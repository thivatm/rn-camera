import AVFoundation
import UIKit

/// Swift view hosted by the `StreamingCamera` Fabric component (spec §3.2).
///
/// Shows the camera preview while it is in a window and camera access is
/// granted. Without access it shows nothing and reports `permissionMissing`.
/// Records at most one Live Recording (spec §4) and reports it through
/// `RecordingEvents`; it stops on its own with `interrupted`, `backgrounded`,
/// or `user` when removed from the window. Capture itself sits behind the
/// `CameraSession` seam.
@objc(StreamingCameraHostView)
public final class StreamingCameraHostView: UIView {
  private let authorizer: CameraAuthorizing
  private let makeSession: () -> CameraSession
  private let recordingsDirectory: URL
  private let recordingEvents: RecordingEvents
  private var session: CameraSession?
  private var isActive = false
  private var recording: LiveRecording?

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
    // Ignored while recording; applied once the recording stops.
    didSet { if position != oldValue, recording == nil { session?.setPosition(position) } }
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

  // Recording props, read when a recording starts.
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
    makeSession: @escaping () -> CameraSession,
    recordingsDirectory: URL = RecordingFile.defaultDirectory(),
    recordingEvents: RecordingEvents = StreamingCameraRecorderEvents.shared
  ) {
    self.authorizer = authorizer
    self.makeSession = makeSession
    self.recordingsDirectory = recordingsDirectory
    self.recordingEvents = recordingEvents
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
    // No `self` in the callbacks: weak references can't be formed in deinit.
    if let recording, recording.stopReason == nil, let session {
      recording.stopReason = "user"
      let events = recordingEvents
      session.stopRecording { finalSize in recording.reportStopped(finalSize, to: events) }
    }
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
    session.onInterruption = { [weak self] reason in self?.stopRecording(reason) }

    session.previewLayer.frame = bounds
    layer.insertSublayer(session.previewLayer, at: 0)
    session.start(position: position)
    session.setTorch(torch)
    session.setZoom(currentZoom)
  }

  private func stop() {
    guard let session else { return }
    stopRecording("user")
    session.stop()
    session.previewLayer.removeFromSuperlayer()
  }

  // MARK: - Recording

  /// Starts recording to `<recordingsDirectory>/<recordingId>.mp4`. Reports
  /// `recordingStarted`, or `recordingFailed` while another recording is live
  /// or the camera is not showing.
  @objc public func startRecording(_ recordingId: String) {
    guard recording == nil else {
      return recordingEvents.recordingFailed(id: recordingId, message: "A Live Recording already exists")
    }
    guard isActive, let session else {
      return recordingEvents.recordingFailed(id: recordingId, message: "The camera is not ready")
    }
    let file = recordingsDirectory.appendingPathComponent("\(recordingId).mp4")
    let live = LiveRecording(id: recordingId, file: file)
    recording = live
    let events = recordingEvents
    session.startRecording(
      to: file,
      settings: RecordingSettings(
        codec: videoCodec, resolution: videoResolution, fps: videoFps, bitrate: videoBitrate,
        audio: audio),
      onStarted: { [weak self] error in
        if let error {
          live.failed = true
          try? FileManager.default.removeItem(at: file)
          self?.clear(live)
          events.recordingFailed(id: recordingId, message: error.localizedDescription)
        } else {
          live.started = true
          events.recordingStarted(id: recordingId, filePath: file.path)
        }
      },
      onFragment: { totalBytes in
        if live.started, !live.failed { events.recordingFragment(id: recordingId, recordedBytes: totalBytes) }
      })
  }

  /// Finishes the Live Recording with `reason` (a `StopReason`) and reports
  /// `recordingStopped` once the file is complete. The first reason wins.
  @objc public func stopRecording(_ reason: String) {
    guard let recording, recording.stopReason == nil, let session else { return }
    recording.stopReason = reason
    let events = recordingEvents
    session.stopRecording { [weak self] finalSize in
      self?.clear(recording)
      recording.reportStopped(finalSize, to: events)
    }
  }

  private func clear(_ live: LiveRecording) {
    guard recording === live else { return }
    recording = nil
    session?.setPosition(position)
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

/// The view's Live Recording, shared with the session callbacks.
private final class LiveRecording {
  let id: String
  let file: URL
  var started = false
  var failed = false
  var stopReason: String?

  init(id: String, file: URL) {
    self.id = id
    self.file = file
  }

  func reportStopped(_ finalSize: Int64, to events: RecordingEvents) {
    guard started, !failed, let stopReason else { return }
    events.recordingStopped(id: id, reason: stopReason, finalSize: finalSize)
  }
}
