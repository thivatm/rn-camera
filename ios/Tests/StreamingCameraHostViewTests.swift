import AVFoundation
import UIKit
import XCTest
import RnCamera

final class StreamingCameraHostViewTests: XCTestCase {
  private var session: FakeCameraSession!
  private var authorizer: FakeAuthorizer!
  private var errors: [(code: String, message: String)] = []

  override func setUp() {
    super.setUp()
    session = FakeCameraSession()
    authorizer = FakeAuthorizer(camera: .authorized, microphone: .authorized)
    errors = []
  }

  private func makeView() -> StreamingCameraHostView {
    let fake = session!
    let view = StreamingCameraHostView(
      frame: CGRect(x: 0, y: 0, width: 300, height: 400),
      authorizer: authorizer,
      makeSession: { fake }
    )
    view.onCameraError = { [weak self] code, message in
      self?.errors.append((code, message))
    }
    return view
  }

  func testStartsTheBackCameraPreviewWhenActivatedWithPermission() {
    let view = makeView()

    view.setActive(true)

    XCTAssertEqual(session.startedPosition, "back")
    XCTAssertTrue(session.isRunning)
    XCTAssertTrue(view.layer.sublayers?.contains(session.previewLayer) ?? false)
    XCTAssertTrue(errors.isEmpty)
  }

  func testWithoutCameraPermissionShowsNothingAndReportsPermissionMissing() {
    authorizer.statuses[.video] = .denied
    let view = makeView()

    view.setActive(true)

    XCTAssertNil(session.startedPosition)
    XCTAssertFalse(view.layer.sublayers?.contains(session.previewLayer) ?? false)
    XCTAssertEqual(errors.map(\.code), ["permissionMissing"])
  }

  func testPropsSetBeforeActivationApplyOnceTheSessionStarts() {
    let view = makeView()
    view.position = "front"
    view.torch = true
    view.zoom = 2

    view.setActive(true)

    XCTAssertEqual(session.startedPosition, "front")
    XCTAssertEqual(session.torch, true)
    XCTAssertEqual(session.zoom, 2)
  }

  func testPropChangesReachTheRunningSession() {
    let view = makeView()
    view.setActive(true)

    view.position = "front"
    view.torch = true
    view.zoom = 3

    XCTAssertEqual(session.position, "front")
    XCTAssertEqual(session.torch, true)
    XCTAssertEqual(session.zoom, 3)
  }

  func testRecordingPropsAreStoredForLater() {
    let view = makeView()
    view.videoCodec = "hevc"
    view.videoResolution = "720p"
    view.videoFps = 60
    view.videoBitrate = 5_000_000
    view.audio = false

    XCTAssertEqual(view.videoCodec, "hevc")
    XCTAssertEqual(view.videoResolution, "720p")
    XCTAssertEqual(view.videoFps, 60)
    XCTAssertEqual(view.videoBitrate, 5_000_000)
    XCTAssertFalse(view.audio)
  }

  func testSessionFailuresAreReportedAsErrors() {
    let view = makeView()
    view.setActive(true)

    session.fail(code: "cameraUnavailable", message: "No back camera")

    XCTAssertEqual(errors.map(\.code), ["cameraUnavailable"])
    XCTAssertEqual(errors.first?.message, "No back camera")
  }

  func testDeactivationStopsTheSessionAndRemovesThePreview() {
    let view = makeView()
    view.setActive(true)

    view.setActive(false)

    XCTAssertFalse(session.isRunning)
    XCTAssertFalse(view.layer.sublayers?.contains(session.previewLayer) ?? false)
  }

  func testPinchGestureExistsOnlyWhenEnabled() {
    let view = makeView()
    XCTAssertFalse(hasGesture(UIPinchGestureRecognizer.self, on: view))

    view.enablePinchToZoom = true
    XCTAssertTrue(hasGesture(UIPinchGestureRecognizer.self, on: view))

    view.enablePinchToZoom = false
    XCTAssertFalse(hasGesture(UIPinchGestureRecognizer.self, on: view))
  }

  func testPinchZoomsRelativeToTheZoomAtGestureStartWithinLimits() {
    let view = makeView()
    view.enablePinchToZoom = true
    view.zoom = 2
    view.setActive(true)
    session.maxZoom = 5

    view.handlePinch(scale: 1, began: true)
    view.handlePinch(scale: 1.5, began: false)
    XCTAssertEqual(session.zoom, 3)

    view.handlePinch(scale: 4, began: false)
    XCTAssertEqual(session.zoom, 5)

    view.handlePinch(scale: 1, began: true)
    view.handlePinch(scale: 0.01, began: false)
    XCTAssertEqual(session.zoom, 1)
  }

  func testTapFocusesOnlyWhenEnabled() {
    let view = makeView()
    view.setActive(true)
    XCTAssertFalse(hasGesture(UITapGestureRecognizer.self, on: view))

    view.enableTapToFocus = true
    XCTAssertTrue(hasGesture(UITapGestureRecognizer.self, on: view))
    view.handleTap(at: CGPoint(x: 10, y: 20))

    XCTAssertEqual(session.focusPoints, [CGPoint(x: 10, y: 20)])
  }

  private func hasGesture<T: UIGestureRecognizer>(_ type: T.Type, on view: UIView) -> Bool {
    view.gestureRecognizers?.contains { $0 is T } ?? false
  }
}
