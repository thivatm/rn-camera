package com.thivatm.rncamera.camera

import com.thivatm.rncamera.recording.EventLog
import com.thivatm.rncamera.recording.FakeCapture
import com.thivatm.rncamera.recording.LiveRecordingLock
import com.thivatm.rncamera.recording.Recorder
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Which host lifecycle signals stop a Live Recording with `backgrounded`. */
class HostLifecycleTest {
  @get:Rule val tmp = TemporaryFolder()

  private val session = FakeCameraSession()
  private val capture = FakeCapture()
  private val events = EventLog()
  private var attached = true
  private val controller by lazy {
    StreamingCameraController(
      session = session,
      isGranted = { true },
      onError = {},
      recorder = Recorder(tmp.root, capture, events, LiveRecordingLock()),
    )
  }
  private val lifecycle by lazy { HostLifecycle(controller) { attached } }

  private fun recording() {
    controller.start()
    controller.startRecording("rec-1")
  }

  @Test
  fun anActivityPauseInTheForegroundKeepsRecordingAndThePreview() {
    // E.g. the system permission dialog over the Activity.
    recording()

    lifecycle.onHostPause()
    lifecycle.onHostResume()

    assertEquals(listOf("started rec-1"), events.log.map { it.substringBeforeLast(' ') })
    assertEquals(0, capture.stopCount)
    assertEquals(CameraPosition.BACK, session.openedAt)
    assertEquals(1, session.opens)
  }

  @Test
  fun goingToTheBackgroundStopsWithBackgroundedAndClosesTheCamera() {
    recording()

    lifecycle.onHostPause()
    lifecycle.onAppBackground()
    capture.finish(42)

    assertEquals("stopped rec-1 backgrounded 42", events.log.last())
    assertEquals(null, session.openedAt)
  }

  @Test
  fun comingBackToTheForegroundReopensTheCamera() {
    controller.start()
    lifecycle.onAppBackground()

    lifecycle.onAppForeground()

    assertEquals(CameraPosition.BACK, session.openedAt)
    assertEquals(2, session.opens)
  }

  @Test
  fun aDetachedViewStaysClosedInTheForeground() {
    controller.start()
    lifecycle.onAppBackground()
    attached = false

    lifecycle.onAppForeground()
    lifecycle.onHostResume()

    assertEquals(null, session.openedAt)
  }
}
