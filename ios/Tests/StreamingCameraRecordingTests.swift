import AVFoundation
import UIKit
import XCTest
import RnCamera

/// Recording on the camera view (spec §3.2, §4): the single Live Recording,
/// native stop reasons, and the events reported to JS. Capture sits behind
/// the `CameraSession` seam.
final class StreamingCameraRecordingTests: XCTestCase {
  private var session: FakeCameraSession!
  private var events: FakeRecordingEvents!
  private let directory = URL(fileURLWithPath: "/recordings", isDirectory: true)

  override func setUp() {
    super.setUp()
    session = FakeCameraSession()
    events = FakeRecordingEvents()
  }

  private func makeView(camera: AVAuthorizationStatus = .authorized) -> StreamingCameraHostView {
    let fake = session!
    let view = StreamingCameraHostView(
      frame: CGRect(x: 0, y: 0, width: 300, height: 400),
      authorizer: FakeAuthorizer(camera: camera, microphone: .authorized),
      makeSession: { fake },
      recordingsDirectory: directory,
      recordingEvents: events
    )
    view.setActive(true)
    return view
  }

  private func startedView(_ id: String = "rec-1") -> StreamingCameraHostView {
    let view = makeView()
    view.startRecording(id)
    session.finishStarting()
    return view
  }

  func testStartsRecordingToTheRecordingFileWithTheVideoProps() {
    let view = makeView()
    view.videoCodec = "hevc"
    view.videoResolution = "720p"
    view.videoFps = 60
    view.videoBitrate = 4_000_000
    view.audio = false

    view.startRecording("rec-1")
    XCTAssertEqual(events.events, [], "started is reported once capture has begun")
    session.finishStarting()

    XCTAssertEqual(session.recordingFile?.path, "/recordings/rec-1.mp4")
    XCTAssertEqual(
      session.recordingSettings,
      RecordingSettings(codec: "hevc", resolution: "720p", fps: 60, bitrate: 4_000_000, audio: false))
    XCTAssertEqual(events.events, [.started(id: "rec-1", filePath: "/recordings/rec-1.mp4")])
  }

  func testReportsEachFragmentAsFileGrowth() {
    let view = startedView()
    defer { withExtendedLifetime(view) {} }

    session.appendFragment(totalBytes: 1_000)
    session.appendFragment(totalBytes: 250_000)

    XCTAssertEqual(
      Array(events.events.dropFirst()),
      [.fragment(id: "rec-1", recordedBytes: 1_000), .fragment(id: "rec-1", recordedBytes: 250_000)])
  }

  func testStopFinishesTheFileAndReportsTheReasonAndFinalSize() {
    let view = startedView()

    view.stopRecording("maxDuration")
    XCTAssertEqual(events.events.count, 1, "stopped is reported once the file is complete")
    session.finishStopping(finalSize: 9_999)

    XCTAssertEqual(events.events.last, .stopped(id: "rec-1", reason: "maxDuration", finalSize: 9_999))
  }

  func testOnlyOneLiveRecordingAtATime() {
    let view = startedView("rec-1")

    view.startRecording("rec-2")

    XCTAssertEqual(events.events.last, .failed(id: "rec-2"))
    XCTAssertEqual(session.recordingFile?.lastPathComponent, "rec-1.mp4")
  }

  func testCanRecordAgainOnceTheLastRecordingStopped() {
    let view = startedView("rec-1")
    view.stopRecording("user")
    session.finishStopping(finalSize: 10)

    view.startRecording("rec-2")
    session.finishStarting()

    XCTAssertEqual(events.events.last, .started(id: "rec-2", filePath: "/recordings/rec-2.mp4"))
  }

  func testSystemInterruptionsStopTheRecordingWithTheirReason() {
    for reason in ["interrupted", "backgrounded"] {
      setUp()
      let view = startedView()

      session.interrupt(reason)
      session.interrupt("interrupted")
      session.finishStopping(finalSize: 42)
      withExtendedLifetime(view) {}

      XCTAssertEqual(session.stopRecordingCalls, 1)
      XCTAssertEqual(events.events.last, .stopped(id: "rec-1", reason: reason, finalSize: 42))
    }
  }

  func testUnmountingStopsTheRecordingWithReasonUser() {
    let view = startedView()

    view.setActive(false)
    session.finishStopping(finalSize: 7)

    XCTAssertEqual(events.events.last, .stopped(id: "rec-1", reason: "user", finalSize: 7))
    XCTAssertFalse(session.isRunning)
  }

  func testStopWhileStartingReportsStartedThenStopped() {
    let view = makeView()
    view.startRecording("rec-1")

    view.stopRecording("user")
    session.finishStarting()
    session.finishStopping(finalSize: 0)

    XCTAssertEqual(
      events.events,
      [
        .started(id: "rec-1", filePath: "/recordings/rec-1.mp4"),
        .stopped(id: "rec-1", reason: "user", finalSize: 0),
      ])
  }

  func testStopWithoutARecordingIsIgnored() {
    let view = makeView()

    view.stopRecording("user")
    session.interrupt("backgrounded")

    XCTAssertEqual(session.stopRecordingCalls, 0)
    XCTAssertEqual(events.events, [])
  }

  func testFailsToStartWithoutTheCamera() {
    let view = makeView(camera: .denied)

    view.startRecording("rec-1")

    XCTAssertNil(session.recordingFile)
    XCTAssertEqual(events.events, [.failed(id: "rec-1")])
  }

  func testCaptureFailingToStartIsReportedAndFreesTheCamera() {
    let view = makeView()
    session.startError = NSError(domain: "test", code: 1)

    view.startRecording("rec-1")
    session.finishStarting()
    session.startError = nil
    view.startRecording("rec-2")
    session.finishStarting()

    XCTAssertEqual(
      events.events,
      [.failed(id: "rec-1"), .started(id: "rec-2", filePath: "/recordings/rec-2.mp4")])
  }

  func testReleasingTheViewStopsTheRecordingWithReasonUser() {
    var view: StreamingCameraHostView? = startedView()
    XCTAssertNotNil(view)

    view = nil
    session.finishStopping(finalSize: 3)

    XCTAssertEqual(events.events.last, .stopped(id: "rec-1", reason: "user", finalSize: 3))
  }

  func testCameraPositionIsFixedWhileRecording() {
    let view = startedView()

    view.position = "front"
    XCTAssertEqual(session.position, "back")

    view.stopRecording("user")
    session.finishStopping(finalSize: 1)
    XCTAssertEqual(session.position, "front")
  }
}
