import AVFoundation
import UIKit
import RnCamera

/// In-memory stand-in for `AVCaptureDevice` authorization.
final class FakeAuthorizer: CameraAuthorizing {
  var statuses: [AVMediaType: AVAuthorizationStatus]
  /// What the user answers when prompted.
  var answer = true
  private(set) var prompted: [AVMediaType] = []

  init(camera: AVAuthorizationStatus, microphone: AVAuthorizationStatus) {
    statuses = [.video: camera, .audio: microphone]
  }

  func authorizationStatus(for mediaType: AVMediaType) -> AVAuthorizationStatus {
    statuses[mediaType] ?? .notDetermined
  }

  func requestAccess(for mediaType: AVMediaType, completion: @escaping (Bool) -> Void) {
    prompted.append(mediaType)
    statuses[mediaType] = answer ? .authorized : .denied
    completion(answer)
  }
}

/// Records what the host view asks of the capture session.
final class FakeCameraSession: CameraSession {
  let previewLayer = CALayer()
  var maxZoom: CGFloat = 10
  var onError: ((String, String) -> Void)?

  private(set) var startedPosition: String?
  private(set) var isRunning = false
  private(set) var position: String?
  private(set) var torch: Bool?
  private(set) var zoom: CGFloat?
  private(set) var focusPoints: [CGPoint] = []

  func start(position: String) {
    startedPosition = position
    self.position = position
    isRunning = true
  }

  func stop() { isRunning = false }
  func setPosition(_ position: String) { self.position = position }
  func setTorch(_ on: Bool) { torch = on }
  func setZoom(_ factor: CGFloat) { zoom = factor }
  func focus(atLayerPoint point: CGPoint) { focusPoints.append(point) }

  func fail(code: String, message: String) { onError?(code, message) }

  // MARK: Recording

  var onInterruption: ((String) -> Void)?
  private(set) var recordingFile: URL?
  private(set) var recordingSettings: RecordingSettings?
  private(set) var stopRecordingCalls = 0
  /// Set to make the next `startRecording` fail.
  var startError: Error?
  private var onStarted: ((Error?) -> Void)?
  private var onFragment: ((Int64) -> Void)?
  private var onFinished: ((Int64) -> Void)?

  func startRecording(
    to file: URL, settings: RecordingSettings, onStarted: @escaping (Error?) -> Void,
    onFragment: @escaping (Int64) -> Void
  ) {
    recordingFile = file
    recordingSettings = settings
    self.onStarted = onStarted
    self.onFragment = onFragment
  }

  func stopRecording(onFinished: @escaping (Int64) -> Void) {
    stopRecordingCalls += 1
    self.onFinished = onFinished
  }

  /// Capture began writing (or failed to).
  func finishStarting() { onStarted?(startError) }
  func appendFragment(totalBytes: Int64) { onFragment?(totalBytes) }
  func finishStopping(finalSize: Int64) { onFinished?(finalSize) }
  func interrupt(_ reason: String) { onInterruption?(reason) }
}

/// Records the capture events the camera view reports to JS.
final class FakeRecordingEvents: RecordingEvents {
  enum Event: Equatable {
    case started(id: String, filePath: String)
    case fragment(id: String, recordedBytes: Int64)
    case stopped(id: String, reason: String, finalSize: Int64)
    case failed(id: String)
  }

  private(set) var events: [Event] = []

  func recordingStarted(id: String, filePath: String) {
    events.append(.started(id: id, filePath: filePath))
  }
  func recordingFragment(id: String, recordedBytes: Int64) {
    events.append(.fragment(id: id, recordedBytes: recordedBytes))
  }
  func recordingStopped(id: String, reason: String, finalSize: Int64) {
    events.append(.stopped(id: id, reason: reason, finalSize: finalSize))
  }
  func recordingFailed(id: String, message: String) {
    events.append(.failed(id: id))
  }
}
