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
}

/// The real `CameraSession`: an `AVCaptureSession` with a single wide-angle
/// video input, configured on a private serial queue.
final class AVCameraSession: CameraSession {
  private let session = AVCaptureSession()
  private let queue = DispatchQueue(label: "rn-camera.capture-session")
  private let preview: AVCaptureVideoPreviewLayer
  private var input: AVCaptureDeviceInput?
  private var torchOn = false
  private var zoomFactor: CGFloat = 1
  private var runtimeErrorObserver: NSObjectProtocol?

  var onError: ((String, String) -> Void)?

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
  }

  deinit {
    if let runtimeErrorObserver { NotificationCenter.default.removeObserver(runtimeErrorObserver) }
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

  // MARK: - On `queue`

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
