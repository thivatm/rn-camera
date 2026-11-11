package com.thivatm.rncamera.recording

import com.thivatm.rncamera.camera.VideoCodec
import com.thivatm.rncamera.camera.VideoResolution
import com.thivatm.rncamera.camera.VideoSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class RecorderTest {
  @get:Rule val tmp = TemporaryFolder()

  private val capture = FakeCapture()
  private val events = EventLog()
  private val lock = LiveRecordingLock()

  private fun recorder(captureFor: Capture = capture) = Recorder(
    recordingsDir = File(tmp.root, "rn-camera/recordings"),
    capture = captureFor,
    events = events,
    lock = lock,
  )

  private val recorder by lazy { recorder() }
  private val config = CaptureConfig(VideoSettings(), audio = true)

  @Test
  fun startWritesTheRecordingFileUnderFilesDirNamedAfterTheRecordingId() {
    recorder.start("rec-1", config)

    val path = File(tmp.root, "rn-camera/recordings/rec-1.mp4").path
    assertEquals(path, capture.file?.path)
    assertEquals(true, File(tmp.root, "rn-camera/recordings").isDirectory)
    assertEquals(listOf("started rec-1 $path"), events.log)
    assertEquals("rec-1", recorder.liveRecordingId)
  }

  @Test
  fun theCaptureGetsTheVideoSettingsAndAudioFlag() {
    val custom = CaptureConfig(VideoSettings(codec = VideoCodec.HEVC, resolution = VideoResolution.HD_720P, fps = 24, bitrate = 2_000_000), audio = false)

    recorder.start("rec-1", custom)

    assertEquals(custom, capture.config)
  }

  @Test
  fun eachFragmentWrittenIsReportedAfterTheStartedEvent() {
    recorder.start("rec-1", config)

    capture.fragmentWritten(1_000)
    capture.fragmentWritten(2_500)

    assertEquals(listOf("fragment rec-1 1000", "fragment rec-1 2500"), events.log.drop(1))
  }

  @Test
  fun stopEchoesTheReasonOnceTheFileIsFinished() {
    recorder.start("rec-1", config)

    recorder.stop("maxDuration")
    assertEquals(true, capture.stopRequested)
    assertEquals("the Recording is live until the file is finished", "rec-1", recorder.liveRecordingId)

    capture.finish(4_000)
    assertEquals("stopped rec-1 maxDuration 4000", events.log.last())
    assertNull(recorder.liveRecordingId)
  }

  @Test
  fun startFailsWhileALiveRecordingExists() {
    recorder.start("rec-1", config)

    recorder.start("rec-2", config)
    recorder.stop("user")
    recorder.start("rec-3", config)

    assertEquals(
      listOf("failed rec-2 A Live Recording already exists", "failed rec-3 A Live Recording already exists"),
      events.log.filter { it.startsWith("failed") },
    )
    assertEquals(1, capture.startCount)

    capture.finish(10)
    recorder.start("rec-4", config)
    assertEquals("rec-4", recorder.liveRecordingId)
  }

  @Test
  fun onlyOneLiveRecordingAcrossCameraViews() {
    val other = recorder(FakeCapture())
    recorder.start("rec-1", config)

    other.start("rec-2", config)

    assertEquals("failed rec-2 A Live Recording already exists", events.log.last())
    assertNull(other.liveRecordingId)
  }

  @Test
  fun aCaptureThatCannotStartFailsAndKeepsNoFile() {
    val broken = FakeCapture(startError = IllegalStateException("no encoder"))
    val r = recorder(broken)

    r.start("rec-1", config)

    assertEquals(listOf("failed rec-1 no encoder"), events.log)
    assertEquals(false, File(tmp.root, "rn-camera/recordings/rec-1.mp4").exists())
    assertNull(r.liveRecordingId)
    recorder.start("rec-2", config)
    assertEquals("the lock was released", "rec-2", recorder.liveRecordingId)
  }

  @Test
  fun theFirstStopReasonWins() {
    recorder.start("rec-1", config)

    recorder.stop(StopReasons.BACKGROUNDED)
    recorder.stop("user")
    capture.finish(10)

    assertEquals("stopped rec-1 backgrounded 10", events.log.last())
    assertEquals(1, capture.stopCount)
  }

  @Test
  fun stopWithoutALiveRecordingDoesNothing() {
    recorder.stop("user")

    assertEquals(false, capture.stopRequested)
    assertEquals(emptyList<String>(), events.log)
  }

  @Test
  fun anInterruptionStopsTheRecordingWithReasonInterrupted() {
    recorder.start("rec-1", config)

    capture.interrupt()
    capture.finish(500)

    assertEquals("stopped rec-1 interrupted 500", events.log.last())
  }

  @Test
  fun fragmentsWrittenWhileStoppingAreReportedBeforeTheStopEvent() {
    recorder.start("rec-1", config)
    recorder.stop("user")

    capture.fragmentWritten(700)
    capture.finish(800)

    assertEquals(listOf("fragment rec-1 700", "stopped rec-1 user 800"), events.log.drop(1))
  }
}

class EventLog : RecordingEvents {
  val log = mutableListOf<String>()

  override fun recordingStarted(recordingId: String, filePath: String) {
    log += "started $recordingId $filePath"
  }

  override fun recordingFragment(recordingId: String, recordedBytes: Long) {
    log += "fragment $recordingId $recordedBytes"
  }

  override fun recordingStopped(recordingId: String, reason: String, finalSize: Long) {
    log += "stopped $recordingId $reason $finalSize"
  }

  override fun recordingFailed(recordingId: String, message: String) {
    log += "failed $recordingId $message"
  }
}

class FakeCapture(private val startError: Exception? = null) : Capture {
  var file: File? = null
  var config: CaptureConfig? = null
  var stopRequested = false
  var startCount = 0
  var stopCount = 0
  private var events: CaptureEvents? = null

  override fun start(file: File, config: CaptureConfig, events: CaptureEvents) {
    startError?.let {
      file.writeBytes(ByteArray(3))
      throw it
    }
    startCount++
    this.file = file
    this.config = config
    this.events = events
    stopRequested = false
  }

  override fun stop() {
    stopRequested = true
    stopCount++
  }

  fun fragmentWritten(size: Long) = events!!.onFragmentWritten(size)
  fun interrupt() = events!!.onInterrupted()
  fun finish(size: Long) = events!!.onFinished(size)
}
