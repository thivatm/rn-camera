import AVFoundation
import CoreMedia
import UniformTypeIdentifiers

/// What to record, from the `video*` / `audio` props (spec §3.2).
public struct RecordingSettings: Equatable {
  /// `"h264"` | `"hevc"`.
  public var codec: String
  /// `"720p"` | `"1080p"`.
  public var resolution: String
  /// 0 = default (30).
  public var fps: Int
  /// Bits per second; 0 = default for the resolution.
  public var bitrate: Int
  public var audio: Bool

  public init(codec: String, resolution: String, fps: Int, bitrate: Int, audio: Bool) {
    self.codec = codec
    self.resolution = resolution
    self.fps = fps
    self.bitrate = bitrate
    self.audio = audio
  }

  var framesPerSecond: Int { fps > 0 ? fps : 30 }
  var bitsPerSecond: Int { bitrate > 0 ? bitrate : (resolution == "720p" ? 3_000_000 : 6_000_000) }
}

/// The Recording File: append-only (ADR 0002, 0003). Bytes, once written,
/// are never rewritten. Thread-safe.
public final class RecordingFile {
  /// `Application Support/rn-camera/recordings`.
  public static func defaultDirectory() -> URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("rn-camera/recordings", isDirectory: true)
  }

  public let url: URL
  private let handle: FileHandle
  private let lock = NSLock()
  private var length: Int64 = 0
  private var closed = false

  /// Creates an empty file at `url`, and its directory if needed.
  public init(creating url: URL) throws {
    self.url = url
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
      throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
    }
    handle = try FileHandle(forWritingTo: url)
  }

  /// Bytes written so far.
  public var size: Int64 {
    lock.lock()
    defer { lock.unlock() }
    return length
  }

  /// Appends `data` at the end of the file and returns the new size.
  @discardableResult
  public func append(_ data: Data) throws -> Int64 {
    lock.lock()
    defer { lock.unlock() }
    try handle.seekToEnd()
    try handle.write(contentsOf: data)
    length += Int64(data.count)
    return length
  }

  public func close() {
    lock.lock()
    defer { lock.unlock() }
    guard !closed else { return }
    closed = true
    try? handle.synchronize()
    try? handle.close()
  }
}

/// Encodes camera samples into a fragmented MP4 (spec §4): `AVAssetWriter`
/// with the `mpeg4AppleHLS` profile hands over an initialization segment and
/// then one Fragment about every 2 s (keyframe interval 2 s), each appended to
/// the `RecordingFile`. The writer is created on the first video sample, so
/// the track takes that sample's (already rotated) dimensions.
///
/// Call `append*` and `finish` from one serial queue.
public final class FragmentedMP4Writer {
  private static let fragmentSeconds = 2

  private let file: RecordingFile
  private let settings: RecordingSettings
  private let audioSettings: [String: Any]?
  private let expectsRealTime: Bool
  private let onFragment: (Int64) -> Void

  private var writer: AVAssetWriter?
  private lazy var fragmentReceiver = FragmentReceiver { [weak self] data in self?.appendFragment(data) }
  private var videoInput: AVAssetWriterInput?
  private var audioInput: AVAssetWriterInput?
  private var startTime: CMTime?
  private var finished = false

  /// Set when encoding or writing failed; the file holds what came before.
  public private(set) var failure: Error?
  /// Called once, on the appending queue, when `failure` is first set.
  public var onFailure: ((Error) -> Void)?

  /// `audioSettings` nil = no audio track. `onFragment(totalBytes)` is called
  /// after each Fragment (or the init data) is appended, on an AVFoundation queue.
  public init(
    file: RecordingFile, settings: RecordingSettings, audioSettings: [String: Any]?,
    expectsRealTime: Bool = true, onFragment: @escaping (Int64) -> Void
  ) {
    self.file = file
    self.settings = settings
    self.audioSettings = audioSettings
    self.expectsRealTime = expectsRealTime
    self.onFragment = onFragment
  }

  public var isReadyForMoreVideo: Bool { videoInput?.isReadyForMoreMediaData ?? true }

  /// Late frames are dropped rather than queued (real-time capture).
  public func appendVideo(_ sample: CMSampleBuffer) {
    guard !finished, failure == nil else { return }
    if writer == nil, !startWriting(with: sample) { return }
    guard let writer, let videoInput else { return }
    guard writer.status == .writing else { return fail(writer.error) }
    if videoInput.isReadyForMoreMediaData, !videoInput.append(sample) { fail(writer.error) }
  }

  /// Audio before the first video frame is dropped.
  public func appendAudio(_ sample: CMSampleBuffer) {
    guard !finished, failure == nil, let writer, let audioInput, let startTime,
      writer.status == .writing,
      CMSampleBufferGetPresentationTimeStamp(sample) >= startTime,
      audioInput.isReadyForMoreMediaData
    else { return }
    if !audioInput.append(sample) { fail(writer.error) }
  }

  /// Writes the last Fragment and closes the file. `completion(finalSize)` is
  /// called on an AVFoundation queue.
  public func finish(_ completion: @escaping (Int64) -> Void) {
    finished = true
    guard let writer, writer.status == .writing else {
      file.close()
      return completion(file.size)
    }
    videoInput?.markAsFinished()
    audioInput?.markAsFinished()
    writer.finishWriting { [file] in
      file.close()
      completion(file.size)
    }
  }

  // MARK: - Private

  private func appendFragment(_ fragmentData: Data) {
    do {
      onFragment(try file.append(fragmentData))
    } catch {
      failure = failure ?? error
    }
  }

  private func startWriting(with sample: CMSampleBuffer) -> Bool {
    guard let format = CMSampleBufferGetFormatDescription(sample) else { return false }
    let dimensions = CMVideoFormatDescriptionGetDimensions(format)
    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
    let fps = settings.framesPerSecond

    let writer = AVAssetWriter(contentType: .mpeg4Movie)
    writer.outputFileTypeProfile = .mpeg4AppleHLS
    writer.preferredOutputSegmentInterval = CMTime(
      seconds: Double(Self.fragmentSeconds), preferredTimescale: 1)
    writer.initialSegmentStartTime = pts
    writer.delegate = fragmentReceiver

    var compression: [String: Any] = [
      AVVideoAverageBitRateKey: settings.bitsPerSecond,
      AVVideoExpectedSourceFrameRateKey: fps,
      AVVideoMaxKeyFrameIntervalKey: fps * Self.fragmentSeconds,
      AVVideoMaxKeyFrameIntervalDurationKey: Self.fragmentSeconds,
      AVVideoAllowFrameReorderingKey: false,
    ]
    if settings.codec != "hevc" {
      compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
    }
    let video = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: settings.codec == "hevc" ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
        AVVideoWidthKey: Int(dimensions.width),
        AVVideoHeightKey: Int(dimensions.height),
        AVVideoCompressionPropertiesKey: compression,
      ])
    video.expectsMediaDataInRealTime = expectsRealTime
    guard writer.canAdd(video) else {
      fail(nil)
      return false
    }
    writer.add(video)

    var audio: AVAssetWriterInput?
    if let audioSettings {
      let input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
      input.expectsMediaDataInRealTime = expectsRealTime
      if writer.canAdd(input) {
        writer.add(input)
        audio = input
      }
    }

    guard writer.startWriting() else {
      fail(writer.error)
      return false
    }
    writer.startSession(atSourceTime: pts)
    self.writer = writer
    videoInput = video
    audioInput = audio
    startTime = pts
    return true
  }

  private func fail(_ error: Error?) {
    guard failure == nil else { return }
    let error = error ?? CocoaError(.fileWriteUnknown)
    failure = error
    onFailure?(error)
  }
}

/// Hands each Fragment (AVFoundation's "segment") to the writer.
/// `AVAssetWriterDelegate` (an NSObject), kept private so the writer stays a
/// plain Swift class out of the generated ObjC header.
private final class FragmentReceiver: NSObject, AVAssetWriterDelegate {
  private let receive: (Data) -> Void

  init(receive: @escaping (Data) -> Void) {
    self.receive = receive
  }

  func assetWriter(
    _ writer: AVAssetWriter, didOutputSegmentData segmentData: Data,
    segmentType: AVAssetSegmentType, segmentReport: AVAssetSegmentReport?
  ) {
    receive(segmentData)
  }
}
