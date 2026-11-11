import AVFoundation
import UIKit

/// Seam between `StreamingCameraHostView` and AVFoundation. The host view owns
/// prop handling and permission gating; a `CameraSession` owns the device.
/// Calls arrive on the main thread; `onError` must be called on the main thread.
public protocol CameraSession: AnyObject {
  /// Layer that renders the live preview. Added to the host view while active.
  var previewLayer: CALayer { get }
  /// Largest zoom factor pinch-to-zoom may reach on the current device.
  var maxZoom: CGFloat { get }
  /// `(code, message)`, `code` being a `CameraError` code.
  var onError: ((String, String) -> Void)? { get set }

  /// `position` is `"front"` or `"back"`.
  func start(position: String)
  func stop()
  func setPosition(_ position: String)
  func setTorch(_ on: Bool)
  func setZoom(_ factor: CGFloat)
  /// `point` is in `previewLayer` coordinates.
  func focus(atLayerPoint point: CGPoint)

  // MARK: Recording

  /// The system interrupted capture: `"interrupted"` (phone call, audio
  /// session interruption, writer failure) or `"backgrounded"`.
  var onInterruption: ((String) -> Void)? { get set }

  /// Begins appending a fragmented MP4 to a new file at `file`, with the
  /// orientation fixed now. `onStarted(nil)` once writing has begun, or with
  /// the error. `onFragment(totalBytes)` after each Fragment. Main thread.
  func startRecording(
    to file: URL, settings: RecordingSettings, onStarted: @escaping (Error?) -> Void,
    onFragment: @escaping (Int64) -> Void)
  /// Finishes the file (valid any time after `startRecording`) and calls
  /// `onFinished(finalSize)` on the main thread.
  func stopRecording(onFinished: @escaping (Int64) -> Void)
}

/// The real `CameraSession`: an `AVCaptureSession` with a single wide-angle
/// video input, configured on a private serial queue. While recording, video
/// and audio data outputs feed a `FragmentedMP4Writer` on `recordingQueue`.
final class AVCameraSession: CameraSession {
  private let session = AVCaptureSession()
  private let queue = DispatchQueue(label: "rn-camera.capture-session")
  private let preview: AVCaptureVideoPreviewLayer
  private var input: AVCaptureDeviceInput?
  private var torchOn = false
  private var zoomFactor: CGFloat = 1
  private var runtimeErrorObserver: NSObjectProtocol?
  private var interruptionObservers: [NSObjectProtocol] = []

  // Recording. Outputs and `audioInput` are touched on `queue`; `writer` on
  // `recordingQueue`.
  private let recordingQueue = DispatchQueue(label: "rn-camera.recording")
  private let videoOutput = AVCaptureVideoDataOutput()
  private let audioOutput = AVCaptureAudioDataOutput()
  private var audioInput: AVCaptureDeviceInput?
  private var writer: FragmentedMP4Writer?
  private lazy var sampleReceiver = SampleReceiver { [weak self] output, sample in
    self?.receive(sample, from: output)
  }

  var onError: ((String, String) -> Void)?
  var onInterruption: ((String) -> Void)?

  /// Caps pinch-to-zoom: beyond this digital zoom is not useful.
  private static let zoomCap: CGFloat = 10

  init() {
    preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill
    runtimeErrorObserver = NotificationCenter.default.addObserver(
      forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: .main
    ) { [weak self] note in
      let error = note.userInfo?[AVCaptureSessionErrorKey] as? Error
      self?.onError?("unknown", error?.localizedDescription ?? "Capture session error")
    }
    observeInterruptions()
  }

  deinit {
    if let runtimeErrorObserver { NotificationCenter.default.removeObserver(runtimeErrorObserver) }
    interruptionObservers.forEach(NotificationCenter.default.removeObserver)
    let session = self.session
    queue.async { session.stopRunning() }
  }

  var previewLayer: CALayer { preview }

  var maxZoom: CGFloat {
    guard let device = input?.device else { return 1 }
    return min(device.maxAvailableVideoZoomFactor, Self.zoomCap)
  }

  func start(position: String) {
    queue.async { [self] in
      configureInput(position: position)
      if !session.isRunning { session.startRunning() }
    }
  }

  func stop() {
    queue.async { [self] in
      if session.isRunning { session.stopRunning() }
    }
  }

  func setPosition(_ position: String) {
    queue.async { [self] in configureInput(position: position) }
  }

  func setTorch(_ on: Bool) {
    queue.async { [self] in
      torchOn = on
      applyTorch()
    }
  }

  func setZoom(_ factor: CGFloat) {
    queue.async { [self] in
      zoomFactor = factor
      applyZoom()
    }
  }

  func focus(atLayerPoint point: CGPoint) {
    let devicePoint = preview.captureDevicePointConverted(fromLayerPoint: point)
    queue.async { [self] in
      guard let device = input?.device else { return }
      configure(device) {
        if device.isFocusPointOfInterestSupported, device.isFocusModeSupported(.autoFocus) {
          device.focusPointOfInterest = devicePoint
          device.focusMode = .autoFocus
        }
        if device.isExposurePointOfInterestSupported, device.isExposureModeSupported(.autoExpose) {
          device.exposurePointOfInterest = devicePoint
          device.exposureMode = .autoExpose
        }
      }
    }
  }

  // MARK: - Recording

  func startRecording(
    to file: URL, settings: RecordingSettings, onStarted: @escaping (Error?) -> Void,
    onFragment: @escaping (Int64) -> Void
  ) {
    let rotation = Self.currentVideoRotation()
    queue.async { [self] in
      do {
        let recordingFile = try RecordingFile(creating: file)
        try configureRecordingOutputs(settings: settings, rotation: rotation)
        let audioSettings =
          settings.audio
          ? audioOutput.recommendedAudioSettingsForAssetWriter(writingTo: .mp4) : nil
        let writer = FragmentedMP4Writer(
          file: recordingFile, settings: settings, audioSettings: audioSettings,
          onFragment: { totalBytes in DispatchQueue.main.async { onFragment(totalBytes) } })
        writer.onFailure = { [weak self] _ in
          DispatchQueue.main.async { self?.onInterruption?("interrupted") }
        }
        recordingQueue.sync { self.writer = writer }
        DispatchQueue.main.async { onStarted(nil) }
      } catch {
        removeRecordingOutputs()
        DispatchQueue.main.async { onStarted(error) }
      }
    }
  }

  func stopRecording(onFinished: @escaping (Int64) -> Void) {
    // Finishing must survive the app going to the background.
    var task = UIBackgroundTaskIdentifier.invalid
    task = UIApplication.shared.beginBackgroundTask { UIApplication.shared.endBackgroundTask(task) }
    let done: (Int64) -> Void = { finalSize in
      DispatchQueue.main.async {
        onFinished(finalSize)
        UIApplication.shared.endBackgroundTask(task)
      }
    }
    // After any pending `startRecording` on `queue`.
    queue.async { [self] in
      recordingQueue.async { [self] in
        guard let writer else { return done(0) }
        self.writer = nil
        writer.finish(done)
      }
      removeRecordingOutputs()
    }
  }

  private func receive(_ sample: CMSampleBuffer, from output: AVCaptureOutput) {
    // On `recordingQueue`.
    if output === videoOutput {
      writer?.appendVideo(sample)
    } else {
      writer?.appendAudio(sample)
    }
  }

  private func observeInterruptions() {
    let center = NotificationCenter.default
    let interrupt: (String) -> (Notification) -> Void = { reason in
      { [weak self] _ in self?.onInterruption?(reason) }
    }
    interruptionObservers = [
      center.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main,
        using: interrupt("backgrounded")),
      center.addObserver(
        forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: .main
      ) { [weak self] note in
        let raw = note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int
        let background =
          raw == AVCaptureSession.InterruptionReason.videoDeviceNotAvailableInBackground.rawValue
        self?.onInterruption?(background ? "backgrounded" : "interrupted")
      },
      center.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
      ) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        if raw == AVAudioSession.InterruptionType.began.rawValue {
          self?.onInterruption?("interrupted")
        }
      },
    ]
  }

  /// Rotation that keeps the recorded video upright for the current
  /// interface orientation. Read once per recording: orientation is fixed.
  private static func currentVideoRotation() -> AVCaptureVideoOrientation {
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    switch scene?.interfaceOrientation {
    case .landscapeLeft: return .landscapeLeft
    case .landscapeRight: return .landscapeRight
    case .portraitUpsideDown: return .portraitUpsideDown
    default: return .portrait
    }
  }

  // MARK: - On `queue`

  private func configureRecordingOutputs(
    settings: RecordingSettings, rotation: AVCaptureVideoOrientation
  ) throws {
    session.beginConfiguration()
    defer { session.commitConfiguration() }

    let preset: AVCaptureSession.Preset = settings.resolution == "720p" ? .hd1280x720 : .hd1920x1080
    session.sessionPreset = session.canSetSessionPreset(preset) ? preset : .high

    if !session.outputs.contains(videoOutput) {
      guard session.canAddOutput(videoOutput) else {
        throw CocoaError(.featureUnsupported, userInfo: [NSLocalizedDescriptionKey: "Cannot record video"])
      }
      session.addOutput(videoOutput)
    }
    videoOutput.alwaysDiscardsLateVideoFrames = true
    videoOutput.setSampleBufferDelegate(sampleReceiver, queue: recordingQueue)
    if let connection = videoOutput.connection(with: .video), connection.isVideoOrientationSupported {
      connection.videoOrientation = rotation
    }

    if settings.audio {
      guard
        let microphone = AVCaptureDevice.default(for: .audio),
        let audioInput = try? AVCaptureDeviceInput(device: microphone),
        session.canAddInput(audioInput)
      else {
        throw CocoaError(.featureUnsupported, userInfo: [NSLocalizedDescriptionKey: "Microphone unavailable"])
      }
      session.addInput(audioInput)
      self.audioInput = audioInput
      if !session.outputs.contains(audioOutput), session.canAddOutput(audioOutput) {
        session.addOutput(audioOutput)
      }
      audioOutput.setSampleBufferDelegate(sampleReceiver, queue: recordingQueue)
    }

    if settings.fps > 0, let device = input?.device {
      applyFrameRate(settings.fps, to: device)
    }
  }

  private func removeRecordingOutputs() {
    session.beginConfiguration()
    if let audioInput { session.removeInput(audioInput) }
    audioInput = nil
    session.removeOutput(audioOutput)
    session.removeOutput(videoOutput)
    session.commitConfiguration()
  }

  private func applyFrameRate(_ fps: Int, to device: AVCaptureDevice) {
    let supported = device.activeFormat.videoSupportedFrameRateRanges.contains {
      Double(fps) >= $0.minFrameRate && Double(fps) <= $0.maxFrameRate
    }
    guard supported else { return }
    configure(device) {
      let duration = CMTime(value: 1, timescale: CMTimeScale(fps))
      device.activeVideoMinFrameDuration = duration
      device.activeVideoMaxFrameDuration = duration
    }
  }

  private func configureInput(position: String) {
    let wanted: AVCaptureDevice.Position = position == "front" ? .front : .back
    if input?.device.position == wanted { return }

    guard
      let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: wanted),
      let newInput = try? AVCaptureDeviceInput(device: device)
    else {
      return report("cameraUnavailable", "No \(position) camera available")
    }

    session.beginConfiguration()
    if let input { session.removeInput(input) }
    if session.canAddInput(newInput) {
      session.addInput(newInput)
      input = newInput
    } else {
      input = nil
    }
    session.commitConfiguration()

    guard input != nil else { return report("cameraUnavailable", "Cannot use the \(position) camera") }
    applyTorch()
    applyZoom()
  }

  private func applyTorch() {
    guard let device = input?.device, device.hasTorch else { return }
    let mode: AVCaptureDevice.TorchMode = torchOn ? .on : .off
    guard device.isTorchModeSupported(mode) else { return }
    configure(device) { device.torchMode = mode }
  }

  private func applyZoom() {
    guard let device = input?.device else { return }
    let upper = min(device.maxAvailableVideoZoomFactor, Self.zoomCap)
    let clamped = max(device.minAvailableVideoZoomFactor, min(zoomFactor, upper))
    configure(device) { device.videoZoomFactor = clamped }
  }

  private func configure(_ device: AVCaptureDevice, _ change: () -> Void) {
    do {
      try device.lockForConfiguration()
      change()
      device.unlockForConfiguration()
    } catch {
      report("unknown", error.localizedDescription)
    }
  }

  private func report(_ code: String, _ message: String) {
    DispatchQueue.main.async { [weak self] in self?.onError?(code, message) }
  }
}

/// Forwards capture samples to a closure (the delegate must be an NSObject).
private final class SampleReceiver: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate,
  AVCaptureAudioDataOutputSampleBufferDelegate
{
  private let receive: (AVCaptureOutput, CMSampleBuffer) -> Void

  init(receive: @escaping (AVCaptureOutput, CMSampleBuffer) -> Void) {
    self.receive = receive
  }

  func captureOutput(
    _ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    receive(output, sampleBuffer)
  }
}
