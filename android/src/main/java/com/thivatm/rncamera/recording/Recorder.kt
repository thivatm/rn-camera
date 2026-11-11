package com.thivatm.rncamera.recording

import com.thivatm.rncamera.camera.VideoSettings
import java.io.File

/**
 * `StopReason` values (spec §4) native code decides on its own. `user`,
 * `maxDuration` and `lowStorage` also arrive from TS via `stopRecording`.
 */
object StopReasons {
  const val USER = "user"
  const val INTERRUPTED = "interrupted"
  const val BACKGROUNDED = "backgrounded"
}

data class CaptureConfig(val video: VideoSettings, val audio: Boolean)

/**
 * Camera frames, microphone, encoders and the fragmented MP4 muxer. Writes an
 * append-only Recording File at the given path. Real one: [MediaCodecCapture].
 */
interface Capture {
  /** Throws if capture cannot start. */
  fun start(file: File, config: CaptureConfig, events: CaptureEvents)

  /** Finishes the file; [CaptureEvents.onFinished] follows. */
  fun stop()
}

/** Delivered on the [Recorder]'s thread (the main thread in production). */
interface CaptureEvents {
  /** A Fragment was appended; the file is now [fileSize] bytes. */
  fun onFragmentWritten(fileSize: Long)

  /** Phone call, microphone or camera taken away, or an encoder failure. */
  fun onInterrupted()

  /** The file is complete and closed at [fileSize] bytes. */
  fun onFinished(fileSize: Long)
}

/**
 * Capture events for JS (`src/specs/NativeStreamingCameraRecorder.ts`).
 * Real one: `StreamingCameraRecorderModule.events`.
 */
interface RecordingEvents {
  fun recordingStarted(recordingId: String, filePath: String)
  fun recordingFragment(recordingId: String, recordedBytes: Long)
  fun recordingStopped(recordingId: String, reason: String, finalSize: Long)
  fun recordingFailed(recordingId: String, message: String)
}

/** Enforces "at most one Live Recording" (spec §4) across all camera views. */
class LiveRecordingLock {
  private var holder: String? = null

  /** False if another recording holds it. */
  fun tryAcquire(recordingId: String): Boolean {
    if (holder != null) return false
    holder = recordingId
    return true
  }

  fun release(recordingId: String) {
    if (holder == recordingId) holder = null
  }

  companion object {
    /** Process-wide; main thread only. */
    val process = LiveRecordingLock()
  }
}

/**
 * One camera view's Live Recording: where the Recording File goes, the
 * single-Live-Recording rule, stop reasons (first one wins) and the events
 * JS sees. Not thread-safe; main thread in production.
 */
class Recorder(
  private val recordingsDir: File,
  private val capture: Capture,
  private val events: RecordingEvents,
  private val lock: LiveRecordingLock = LiveRecordingLock.process,
) {
  private var live: Live? = null

  private class Live(val id: String) {
    var stopReason: String? = null
  }

  /** Runs after each recording's stopped event. */
  var onFinished: (() -> Unit)? = null

  /** This view's Live Recording, including one that is stopping. */
  val liveRecordingId: String? get() = live?.id

  /**
   * Starts recording to `<recordingsDir>/<recordingId>.mp4`; reports
   * `started`, or `failed` if a Live Recording exists or capture can't start.
   */
  fun start(recordingId: String, config: CaptureConfig) {
    if (!lock.tryAcquire(recordingId)) {
      events.recordingFailed(recordingId, "A Live Recording already exists")
      return
    }
    val recording = Live(recordingId)
    val file = File(recordingsDir, "$recordingId.mp4")
    try {
      recordingsDir.mkdirs()
      live = recording
      capture.start(file, config, Events(recording))
    } catch (e: Exception) {
      live = null
      lock.release(recordingId)
      file.delete()
      events.recordingFailed(recordingId, e.message ?: "Recording could not start")
      return
    }
    events.recordingStarted(recordingId, file.path)
  }

  /** Reports that [recordingId] could not start, e.g. because the camera isn't showing. */
  fun reject(recordingId: String, message: String) {
    events.recordingFailed(recordingId, message)
  }

  /** Finishes the Live Recording, reporting [reason] (a `StopReason`). The first reason wins. */
  fun stop(reason: String) {
    val recording = live ?: return
    if (recording.stopReason != null) return
    recording.stopReason = reason
    capture.stop()
  }

  private inner class Events(private val recording: Live) : CaptureEvents {
    override fun onFragmentWritten(fileSize: Long) {
      if (live === recording) events.recordingFragment(recording.id, fileSize)
    }

    override fun onInterrupted() {
      if (live === recording) stop(StopReasons.INTERRUPTED)
    }

    override fun onFinished(fileSize: Long) {
      if (live !== recording) return
      live = null
      lock.release(recording.id)
      events.recordingStopped(recording.id, recording.stopReason ?: StopReasons.INTERRUPTED, fileSize)
      onFinished?.invoke()
    }
  }
}
