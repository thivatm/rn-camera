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
}
