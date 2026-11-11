import AVFoundation
import CoreMedia
import XCTest
import RnCamera

/// The Recording File is append-only (spec §4, ADR 0002): bytes already
/// written never change, so the upload can stream it while it grows. Runs the
/// real `AVAssetWriter` (`mpeg4AppleHLS`) on synthetic frames.
final class FragmentedMP4WriterTests: XCTestCase {
  private var dir: URL!

  override func setUpWithError() throws {
    dir = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: dir)
  }

  func testBytesWrittenToTheRecordingFileAreNeverRewritten() throws {
    let url = dir.appendingPathComponent("rec.mp4")
    let file = try RecordingFile(creating: url)
    var snapshots: [Data] = []
    var reportedSizes: [Int64] = []
    let writer = FragmentedMP4Writer(
      file: file,
      settings: RecordingSettings(codec: "h264", resolution: "720p", fps: 30, bitrate: 1_000_000, audio: false),
      audioSettings: nil,
      expectsRealTime: false,
      onFragment: { totalBytes in
        reportedSizes.append(totalBytes)
        snapshots.append((try? Data(contentsOf: url)) ?? Data())
      })

    // 7 s at 30 fps: the 2 s keyframe interval gives at least 3 Fragments.
    for frame in 0..<210 {
      let deadline = Date().addingTimeInterval(5)
      while !writer.isReadyForMoreVideo, Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.005))
      }
      writer.appendVideo(try Self.frame(frame, fps: 30))
    }
    let finished = expectation(description: "finished")
    var finalSize: Int64 = -1
    writer.finish { size in
      finalSize = size
      finished.fulfill()
    }
    wait(for: [finished], timeout: 30)

    XCTAssertNil(writer.failure)
    let final = try Data(contentsOf: url)
    XCTAssertEqual(finalSize, Int64(final.count))
    XCTAssertGreaterThanOrEqual(snapshots.count, 4, "init segment + at least 3 Fragments")
    XCTAssertEqual(String(decoding: final[4..<8], as: UTF8.self), "ftyp")
    for (snapshot, size) in zip(snapshots, reportedSizes) {
      XCTAssertEqual(Int64(snapshot.count), size)
      XCTAssertEqual(final.prefix(snapshot.count), snapshot, "earlier bytes changed")
    }
    XCTAssertEqual(reportedSizes, reportedSizes.sorted())
  }

  /// A 640x360 frame whose content changes over time, at `index / fps` s.
  private static func frame(_ index: Int, fps: Int32) throws -> CMSampleBuffer {
    var pixelBuffer: CVPixelBuffer?
    CVPixelBufferCreate(
      nil, 640, 360, kCVPixelFormatType_32BGRA,
      [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixelBuffer)
    let buffer = try XCTUnwrap(pixelBuffer)
    CVPixelBufferLockBaseAddress(buffer, [])
    let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    for y in 0..<360 {
      // Rows shift with time so every frame differs.
      memset(base + y * bytesPerRow, Int32((y + index * 3) % 256), bytesPerRow)
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])

    var format: CMVideoFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(
      allocator: nil, imageBuffer: buffer, formatDescriptionOut: &format)
    var timing = CMSampleTimingInfo(
      duration: CMTime(value: 1, timescale: fps),
      presentationTimeStamp: CMTime(value: CMTimeValue(index), timescale: fps),
      decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    CMSampleBufferCreateReadyWithImageBuffer(
      allocator: nil, imageBuffer: buffer, formatDescription: try XCTUnwrap(format),
      sampleTiming: &timing, sampleBufferOut: &sample)
    return try XCTUnwrap(sample)
  }
}
