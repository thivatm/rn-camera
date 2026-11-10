import AVFoundation
import UIKit

/// Swift view hosted by the `StreamingCamera` Fabric component (spec §3.2).
///
/// Shows the camera preview while it is in a window and camera access is
/// granted. Without access it shows nothing and reports `permissionMissing`.
/// Capture itself sits behind the `CameraSession` seam.
@objc(StreamingCameraHostView)
public final class StreamingCameraHostView: UIView {
  private let authorizer: CameraAuthorizing
  private let makeSession: () -> CameraSession
  private var session: CameraSession?
  private var isActive = false

  private lazy var pinchRecognizer = UIPinchGestureRecognizer(
    target: self, action: #selector(onPinch(_:)))
  private lazy var tapRecognizer = UITapGestureRecognizer(
    target: self, action: #selector(onTap(_:)))
  private var zoomAtPinchStart: CGFloat = 1
  /// Current zoom: the `zoom` prop, adjusted by pinching.
  private var currentZoom: CGFloat = 1

  /// `(code, message)`; forwarded to JS `onError`.
  @objc public var onCameraError: ((String, String) -> Void)?

  // MARK: - Props

  /// `"front"` | `"back"`.
  @objc public var position = "back" {
    didSet { if position != oldValue { session?.setPosition(position) } }
  }

  @objc public var torch = false {
    didSet { if torch != oldValue { session?.setTorch(torch) } }
  }

  @objc public var zoom: CGFloat = 1 {
    didSet {
      guard zoom != oldValue else { return }
      currentZoom = zoom
      session?.setZoom(zoom)
    }
  }

  @objc public var enablePinchToZoom = false {
    didSet { setGesture(pinchRecognizer, enabled: enablePinchToZoom) }
  }

  @objc public var enableTapToFocus = false {
    didSet { setGesture(tapRecognizer, enabled: enableTapToFocus) }
  }

  // Recording props: stored here for the recording pipeline.
  @objc public var videoCodec = "h264"
  @objc public var videoResolution = "1080p"
  /// 0 = default.
  @objc public var videoFps = 0
  /// Bits per second; 0 = default.
  @objc public var videoBitrate = 0
  @objc public var audio = true

  // MARK: - Lifecycle

  public init(
    frame: CGRect,
    authorizer: CameraAuthorizing,
    makeSession: @escaping () -> CameraSession
  ) {
    self.authorizer = authorizer
    self.makeSession = makeSession
    super.init(frame: frame)
    clipsToBounds = true
  }

  @objc public override convenience init(frame: CGRect) {
    self.init(frame: frame, authorizer: SystemCameraAuthorizer(), makeSession: { AVCameraSession() })
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  deinit {
    session?.stop()
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    setActive(window != nil)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    session?.previewLayer.frame = bounds
  }

  /// Starts the preview (if camera access is granted) or stops it.
  /// Driven by `didMoveToWindow`; public for tests.
  public func setActive(_ active: Bool) {
    guard active != isActive else { return }
    isActive = active
    active ? start() : stop()
  }

  private func start() {
    guard authorizer.authorizationStatus(for: .video) == .authorized else {
      onCameraError?("permissionMissing", "Camera permission has not been granted")
      return
    }
    let session = self.session ?? makeSession()
    self.session = session
    session.onError = { [weak self] code, message in self?.onCameraError?(code, message) }

    session.previewLayer.frame = bounds
    layer.insertSublayer(session.previewLayer, at: 0)
    session.start(position: position)
    session.setTorch(torch)
    session.setZoom(currentZoom)
  }

  private func stop() {
    guard let session else { return }
    session.stop()
    session.previewLayer.removeFromSuperlayer()
  }

  // MARK: - Gestures

  private func setGesture(_ recognizer: UIGestureRecognizer, enabled: Bool) {
    if enabled {
      if !(gestureRecognizers?.contains(recognizer) ?? false) { addGestureRecognizer(recognizer) }
    } else {
      removeGestureRecognizer(recognizer)
    }
  }

  @objc private func onPinch(_ recognizer: UIPinchGestureRecognizer) {
    guard recognizer.state == .began || recognizer.state == .changed else { return }
    handlePinch(scale: recognizer.scale, began: recognizer.state == .began)
  }

  @objc private func onTap(_ recognizer: UITapGestureRecognizer) {
    handleTap(at: recognizer.location(in: self))
  }

  /// Zooms by `scale` relative to the zoom when the pinch began, within
  /// `1...session.maxZoom`. Public for tests.
  public func handlePinch(scale: CGFloat, began: Bool) {
    guard let session else { return }
    if began { zoomAtPinchStart = currentZoom }
    currentZoom = max(1, min(zoomAtPinchStart * scale, session.maxZoom))
    session.setZoom(currentZoom)
  }

  /// Focuses at `point` (view coordinates). Public for tests.
  public func handleTap(at point: CGPoint) {
    guard let session else { return }
    session.focus(atLayerPoint: layer.convert(point, to: session.previewLayer))
  }
}
