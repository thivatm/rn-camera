package com.thivatm.rncamera.recording

import com.thivatm.rncamera.camera.VideoSettings
import java.io.File

/** Why a Live Recording stopped (spec §4). [value] is the JS string. */
enum class StopReason(val value: String) {
  USER("user"),
  INTERRUPTED("interrupted"),
  LOW_STORAGE("lowStorage"),
  MAX_DURATION("maxDuration"),
  BACKGROUNDED("backgrounded"),
}

/** What `startRecording` needs from native code. */
data class RecordingRequest(
  val video: VideoSettings = VideoSettings(),
  val audio: Boolean = true,
  val maxDurationSeconds: Double? = null,
)

data class StartedRecording(val recordingId: String, val filePath: String)

data class CaptureConfig(val video: VideoSettings, val audio: Boolean)

/** Thrown by [Recorder.start] while a Live Recording exists. */
class RecordingAlreadyActiveException :
  IllegalStateException("A Live Recording already exists; stop it before starting another")

/**
 * Camera frames, microphone, encoders and the fragmented MP4 muxer. Writes an
 * append-only Recording File at the given path. Real one: [MediaCodecCapture].
 */
interface Capture {
  fun start(file: File, config: CaptureConfig, events: CaptureEvents)

  /** Finishes the file; [CaptureEvents.onFinished] follows. */
  fun stop()
}

/** Delivered on the [Recorder]'s thread (the main thread in production). */
interface CaptureEvents {
  /** A Fragment was appended; the file is now [fileSize] bytes. */
  fun onFragmentWritten(fileSize: Long)

  /** Phone call, microphone taken, camera lost or an encoder failure. */
  fun onInterrupted()

  /** The file is complete and closed at [fileSize] bytes. */
  fun onFinished(fileSize: Long)
}

fun interface Cancellable {
  fun cancel()
}

interface RecorderListener {
  fun onFileGrowth(recordingId: String, recordedBytes: Long)
  fun onStopped(recordingId: String, reason: StopReason, finalSize: Long)
}

/** Enforces "at most one Live Recording" (spec §4) across all camera views. */
class LiveRecordingLock {
  var holder: String? = null
    private set

  fun acquire(recordingId: String) {
    if (holder != null) throw RecordingAlreadyActiveException()
    holder = recordingId
  }

  fun release(recordingId: String) {
    if (holder == recordingId) holder = null
  }

  companion object {
    val process = LiveRecordingLock()
  }
}

/**
 * One camera view's recordings: the Recording File location, the single Live
 * Recording rule and every stop reason except `backgrounded`/`user`, which
 * the view triggers. Not thread-safe; use from one thread.
 */
class Recorder(
  private val recordingsDir: File,
  private val capture: Capture,
  private val freeDiskSpace: () -> Long,
  private val schedule: (delayMs: Long, block: () -> Unit) -> Cancellable,
  private val newRecordingId: () -> String,
  private val listener: RecorderListener,
  private val lock: LiveRecordingLock = LiveRecordingLock.process,
) {
  private var live: Live? = null

  private class Live(val id: String) {
    var stopReason: StopReason? = null
    var maxDurationTimer: Cancellable? = null
  }

  /** The Live Recording of this view, including one that is stopping. */
  val liveRecordingId: String? get() = live?.id

  fun start(request: RecordingRequest): StartedRecording {
    if (lock.holder != null) throw RecordingAlreadyActiveException()
    val id = newRecordingId()
    lock.acquire(id)
    val recording = Live(id)
    live = recording
    try {
      recordingsDir.mkdirs()
      val file = File(recordingsDir, "$id.mp4")
      capture.start(file, CaptureConfig(request.video, request.audio), Events(recording))
      request.maxDurationSeconds?.takeIf { it > 0 }?.let { seconds ->
        recording.maxDurationTimer = schedule((seconds * 1000).toLong()) {
          if (live === recording) stop(StopReason.MAX_DURATION)
        }
      }
      return StartedRecording(id, file.path)
    } catch (e: Exception) {
      live = null
      lock.release(id)
      throw e
    }
  }

  /** Stops the Live Recording; the first reason given wins. */
  fun stop(reason: StopReason) {
    val recording = live ?: return
    if (recording.stopReason != null) return
    recording.stopReason = reason
    recording.maxDurationTimer?.cancel()
    capture.stop()
  }

  private inner class Events(private val recording: Live) : CaptureEvents {
    override fun onFragmentWritten(fileSize: Long) {
      if (live !== recording) return
      listener.onFileGrowth(recording.id, fileSize)
      if (freeDiskSpace() < LOW_STORAGE_BYTES) stop(StopReason.LOW_STORAGE)
    }

    override fun onInterrupted() {
      if (live === recording) stop(StopReason.INTERRUPTED)
    }

    override fun onFinished(fileSize: Long) {
      if (live !== recording) return
      live = null
      lock.release(recording.id)
      recording.maxDurationTimer?.cancel()
      listener.onStopped(recording.id, recording.stopReason ?: StopReason.INTERRUPTED, fileSize)
    }
  }

  companion object {
    /** Spec §4: stop with `lowStorage` below 200 MB free. */
    const val LOW_STORAGE_BYTES = 200L * 1024 * 1024
  }
}
