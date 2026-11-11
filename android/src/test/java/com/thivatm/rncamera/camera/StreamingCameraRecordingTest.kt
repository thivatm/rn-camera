package com.thivatm.rncamera.camera

import com.thivatm.rncamera.recording.CaptureConfig
import com.thivatm.rncamera.recording.EventLog
import com.thivatm.rncamera.recording.FakeCapture
import com.thivatm.rncamera.recording.LiveRecordingLock
import com.thivatm.rncamera.recording.Recorder
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The `startRecording` / `stopRecording` commands and the stop reasons the view decides. */
class StreamingCameraRecordingTest {
  @get:Rule val tmp = TemporaryFolder()

  private val session = FakeCameraSession()
  private val capture = FakeCapture()
  private val events = EventLog()
  private val controller by lazy {
    StreamingCameraController(
      session = session,
      isGranted = { true },
      onError = {},
      recorder = Recorder(tmp.root, capture, events, LiveRecordingLock()),
    )
  }

  @Test
  fun startRecordingUsesTheCurrentVideoAndAudioProps() {
    controller.setVideoCodec("hevc")
    controller.setVideoResolution("720p")
    controller.setAudio(false)
    controller.start()

    controller.startRecording("rec-1")

    assertEquals(CaptureConfig(VideoSettings(codec = VideoCodec.HEVC, resolution = VideoResolution.HD_720P), audio = false), capture.config)
    assertEquals("started rec-1", events.log.single().substringBeforeLast(' '))
  }

  @Test
  fun startRecordingFailsWhenTheCameraIsNotShowing() {
    controller.startRecording("rec-1")

    assertEquals(listOf("failed rec-1 The camera is not ready"), events.log)
    assertEquals(0, capture.startCount)
  }

  @Test
  fun stopRecordingEchoesTheReasonFromJs() {
    controller.start()
    controller.startRecording("rec-1")

    controller.stopRecording("lowStorage")
    capture.finish(42)

    assertEquals("stopped rec-1 lowStorage 42", events.log.last())
  }

  @Test
  fun goingToTheBackgroundStopsWithBackgrounded() {
    controller.start()
    controller.startRecording("rec-1")

    controller.stop(backgrounded = true)
    capture.finish(42)

    assertEquals("stopped rec-1 backgrounded 42", events.log.last())
    assertEquals(null, session.openedAt)
  }

  @Test
  fun unmountingStopsWithUser() {
    controller.start()
    controller.startRecording("rec-1")

    controller.stop()
    capture.finish(42)

    assertEquals("stopped rec-1 user 42", events.log.last())
  }

  @Test
  fun positionIsIgnoredWhileRecordingAndAppliedWhenItStops() {
    controller.start()
    controller.startRecording("rec-1")

    controller.setPosition("front")
    assertEquals(CameraPosition.BACK, session.openedAt)

    controller.stopRecording("user")
    assertEquals(CameraPosition.BACK, session.openedAt)
    capture.finish(42)
    assertEquals(CameraPosition.FRONT, session.openedAt)
  }
}
