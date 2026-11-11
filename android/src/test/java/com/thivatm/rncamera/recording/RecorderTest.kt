package com.thivatm.rncamera.recording

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class RecorderTest {
  @get:Rule val tmp = TemporaryFolder()

  private val capture = FakeCapture()
  private val timers = FakeTimers()
  private var freeBytes = 10L * 1024 * 1024 * 1024
  private val events = mutableListOf<String>()
  private var nextId = 0
  private val lock = LiveRecordingLock()

  private fun recorder(captureFor: Capture = capture) = Recorder(
    recordingsDir = File(tmp.root, "rn-camera/recordings"),
    capture = captureFor,
    freeDiskSpace = { freeBytes },
    schedule = timers::schedule,
    newRecordingId = { "rec-${++nextId}" },
    lock = lock,
    listener = object : RecorderListener {
      override fun onFileGrowth(recordingId: String, recordedBytes: Long) {
        events += "grew $recordingId $recordedBytes"
      }

      override fun onStopped(recordingId: String, reason: StopReason, finalSize: Long) {
        events += "stopped $recordingId ${reason.value} $finalSize"
      }
    },
  )

  private val recorder by lazy { recorder() }

  @Test
  fun startWritesTheRecordingFileUnderFilesDirNamedAfterTheRecordingId() {
    val started = recorder.start(RecordingRequest())

    assertEquals("rec-1", started.recordingId)
    assertEquals(File(tmp.root, "rn-camera/recordings/rec-1.mp4").path, started.filePath)
    assertEquals(started.filePath, capture.file?.path)
    assertEquals(true, File(tmp.root, "rn-camera/recordings").isDirectory)
    assertEquals("rec-1", recorder.liveRecordingId)
  }

  @Test
  fun eachFragmentWrittenIsReportedAsFileGrowth() {
    recorder.start(RecordingRequest())

    capture.fragmentWritten(1_000)
    capture.fragmentWritten(2_500)

    assertEquals(listOf("grew rec-1 1000", "grew rec-1 2500"), events)
  }

  @Test
  fun stopRecordingStopsWithReasonUserOnceTheFileIsFinished() {
    recorder.start(RecordingRequest())

    recorder.stop(StopReason.USER)
    assertEquals(true, capture.stopRequested)
    assertEquals("the Recording is live until the file is finished", "rec-1", recorder.liveRecordingId)

    capture.finish(4_000)
    assertEquals(listOf("stopped rec-1 user 4000"), events)
    assertNull(recorder.liveRecordingId)
  }

  @Test
  fun startRejectsWhileALiveRecordingExists() {
    recorder.start(RecordingRequest())

    assertThrows(RecordingAlreadyActiveException::class.java) { recorder.start(RecordingRequest()) }
    recorder.stop(StopReason.USER)
    assertThrows(RecordingAlreadyActiveException::class.java) { recorder.start(RecordingRequest()) }

    capture.finish(10)
    assertEquals("rec-2", recorder.start(RecordingRequest()).recordingId)
  }

  @Test
  fun onlyOneLiveRecordingAcrossCameraViews() {
    val other = recorder(FakeCapture())
    recorder.start(RecordingRequest())

    assertThrows(RecordingAlreadyActiveException::class.java) { other.start(RecordingRequest()) }
  }

  @Test
  fun theFirstStopReasonWins() {
    recorder.start(RecordingRequest())

    recorder.stop(StopReason.BACKGROUNDED)
    recorder.stop(StopReason.USER)
    capture.finish(10)

    assertEquals(listOf("stopped rec-1 backgrounded 10"), events)
    assertEquals(1, capture.stopCount)
  }

  @Test
  fun stopWithoutALiveRecordingDoesNothing() {
    recorder.stop(StopReason.USER)

    assertEquals(false, capture.stopRequested)
    assertEquals(emptyList<String>(), events)
  }

  @Test
  fun maxDurationStopsTheRecordingWhenReached() {
    recorder.start(RecordingRequest(maxDurationSeconds = 30.0))
    assertEquals(30_000L, timers.pendingDelay)

    timers.fire()
    capture.finish(99)

    assertEquals(listOf("stopped rec-1 maxDuration 99"), events)
  }

  @Test
  fun withoutMaxDurationNothingIsScheduled() {
    recorder.start(RecordingRequest())

    assertNull(timers.pendingDelay)
  }

  @Test
  fun theMaxDurationTimerIsCancelledByAnEarlierStop() {
    recorder.start(RecordingRequest(maxDurationSeconds = 30.0))
    recorder.stop(StopReason.USER)

    assertEquals(true, timers.cancelled)
  }

  @Test
  fun lowStorageStopsTheRecordingWhenFreeSpaceDropsBelow200MB() {
    recorder.start(RecordingRequest())

    freeBytes = 200L * 1024 * 1024
    capture.fragmentWritten(1_000)
    assertEquals(false, capture.stopRequested)

    freeBytes = 200L * 1024 * 1024 - 1
    capture.fragmentWritten(2_000)
    capture.finish(2_000)

    assertEquals(
      listOf("grew rec-1 1000", "grew rec-1 2000", "stopped rec-1 lowStorage 2000"),
      events,
    )
  }

  @Test
  fun anInterruptionStopsTheRecordingWithReasonInterrupted() {
    recorder.start(RecordingRequest())

    capture.interrupt()
    capture.finish(500)

    assertEquals(listOf("stopped rec-1 interrupted 500"), events)
  }

  @Test
  fun growthAfterStopIsStillReportedBeforeTheStopEvent() {
    recorder.start(RecordingRequest())
    recorder.stop(StopReason.USER)

    capture.fragmentWritten(700)
    capture.finish(800)

    assertEquals(listOf("grew rec-1 700", "stopped rec-1 user 800"), events)
  }

  @Test
  fun theCaptureGetsTheVideoSettingsAndAudioFlag() {
    val video = com.thivatm.rncamera.camera.VideoSettings(codec = "hevc", resolution = "720p", fps = 24, bitrate = 2_000_000)

    recorder.start(RecordingRequest(video = video, audio = false))

    assertEquals(video, capture.config?.video)
    assertEquals(false, capture.config?.audio)
  }
}

private class FakeCapture : Capture {
  var file: File? = null
  var config: CaptureConfig? = null
  var stopRequested = false
  var stopCount = 0
  private var events: CaptureEvents? = null

  override fun start(file: File, config: CaptureConfig, events: CaptureEvents) {
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

private class FakeTimers {
  var pendingDelay: Long? = null
  var cancelled = false
  private var action: (() -> Unit)? = null

  fun schedule(delayMs: Long, block: () -> Unit): Cancellable {
    pendingDelay = delayMs
    action = block
    return Cancellable { cancelled = true }
  }

  fun fire() = action!!()
}
