package com.thivatm.rncamera.recording

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.thivatm.rncamera.NativeStreamingCameraRecorderSpec

/**
 * Turbo Module `StreamingCameraRecorder`: emits every camera view's capture
 * events to JS. Events go through a module rather than the view so they
 * still arrive after the view unmounts (which stops a Live Recording).
 */
class StreamingCameraRecorderModule(reactContext: ReactApplicationContext) :
  NativeStreamingCameraRecorderSpec(reactContext) {

  init {
    current = this
  }

  override fun invalidate() {
    if (current === this) current = null
    super.invalidate()
  }

  companion object {
    const val NAME = NativeStreamingCameraRecorderSpec.NAME

    @Volatile private var current: StreamingCameraRecorderModule? = null

    /** What camera views report to; forwards to the live module instance. */
    val events: RecordingEvents = object : RecordingEvents {
      override fun recordingStarted(recordingId: String, filePath: String) {
        current?.emitOnRecordingStarted(
          Arguments.createMap().apply {
            putString("recordingId", recordingId)
            putString("filePath", filePath)
          },
        )
      }

      override fun recordingFragment(recordingId: String, recordedBytes: Long) {
        current?.emitOnRecordingFragment(
          Arguments.createMap().apply {
            putString("recordingId", recordingId)
            putDouble("recordedBytes", recordedBytes.toDouble())
          },
        )
      }

      override fun recordingStopped(recordingId: String, reason: String, finalSize: Long) {
        current?.emitOnRecordingStopped(
          Arguments.createMap().apply {
            putString("recordingId", recordingId)
            putString("reason", reason)
            putDouble("finalSize", finalSize.toDouble())
          },
        )
      }

      override fun recordingFailed(recordingId: String, message: String) {
        current?.emitOnRecordingFailed(
          Arguments.createMap().apply {
            putString("recordingId", recordingId)
            putString("message", message)
          },
        )
      }
    }
  }
}
