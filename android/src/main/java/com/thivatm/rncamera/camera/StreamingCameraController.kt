package com.thivatm.rncamera.camera

import com.thivatm.rncamera.permissions.CameraPermissions
import com.thivatm.rncamera.recording.CaptureConfig
import com.thivatm.rncamera.recording.Recorder
import com.thivatm.rncamera.recording.StopReasons

enum class CameraPosition { FRONT, BACK }

/** The `videoCodec` prop. Anything but `"hevc"` is H.264. */
enum class VideoCodec {
  H264, HEVC;

  companion object {
    fun of(value: String?) = if (value == "hevc") HEVC else H264
  }
}

/** The `videoResolution` prop. Anything but `"720p"` is 1080p. */
enum class VideoResolution(
  /** Bits per second when the `videoBitrate` prop is 0 (same as iOS). */
  val defaultBitrate: Int,
) {
  HD_720P(3_000_000), FHD_1080P(6_000_000);

  companion object {
    fun of(value: String?) = if (value == "720p") HD_720P else FHD_1080P
  }
}

/**
 * The `video*` props (spec §3.2 `video`, flattened), parsed. Stored for
 * recording. `fps` and `bitrate` of 0 leave the choice to the encoder.
 */
data class VideoSettings(
  val codec: VideoCodec = VideoCodec.H264,
  val resolution: VideoResolution = VideoResolution.FHD_1080P,
  val fps: Int = 0,
  val bitrate: Int = 0,
)

/** Payload of the `onCameraError` event. */
data class CameraError(val code: String, val message: String)

/** The device camera and its preview. CameraX lives behind this seam. */
interface CameraSession {
  /** Starts the preview. [onError] runs if the camera cannot be opened. */
  fun open(position: CameraPosition, onError: (String) -> Unit)

  /** Stops the preview and releases the camera. */
  fun close()

  fun setTorch(enabled: Boolean)

  /** Returns the zoom ratio actually applied, clamped to what the camera supports. */
  fun setZoom(ratio: Float): Float

  /** [x] and [y] are in view pixels. */
  fun focusAt(x: Float, y: Float)
}

/**
 * Prop handling and lifecycle for `<StreamingCamera>` (spec §3.2), independent
 * of Android views and CameraX.
 */
class StreamingCameraController(
  private val session: CameraSession,
  private val isGranted: (String) -> Boolean,
  private val onError: (CameraError) -> Unit,
  private val recorder: Recorder? = null,
) {
  init {
    // `position` is ignored while recording and applied once it stops.
    recorder?.onFinished = { if (isOpen && openPosition != position) open() }
  }

  private var openPosition: CameraPosition? = null

  private var position = CameraPosition.BACK
  private var torch = false
  private var zoom = 1f
  private var appliedZoom = 1f
  private var pinchToZoom = false
  private var tapToFocus = false
  private var isOpen = false

  fun setPosition(value: String?) {
    val next = if (value == "front") CameraPosition.FRONT else CameraPosition.BACK
    if (next == position) return
    position = next
    if (isOpen && !isRecording) open()
  }

  fun setTorch(value: Boolean) {
    torch = value
    if (isOpen) session.setTorch(torch)
  }

  fun setZoom(value: Float) {
    zoom = value
    if (isOpen) appliedZoom = session.setZoom(zoom)
  }

  fun setEnablePinchToZoom(value: Boolean) {
    pinchToZoom = value
  }

  fun setEnableTapToFocus(value: Boolean) {
    tapToFocus = value
  }

  /** A pinch gesture changed its span by [scaleFactor] since the last call. */
  fun onPinch(scaleFactor: Float) {
    if (!pinchToZoom || !isOpen) return
    appliedZoom = session.setZoom(appliedZoom * scaleFactor)
  }

  /** A single tap at view coordinates ([x], [y]). */
  fun onTap(x: Float, y: Float) {
    if (!tapToFocus || !isOpen) return
    session.focusAt(x, y)
  }

  var video = VideoSettings()
    private set

  fun setVideoCodec(value: String?) {
    video = video.copy(codec = VideoCodec.of(value))
  }

  fun setVideoResolution(value: String?) {
    video = video.copy(resolution = VideoResolution.of(value))
  }

  fun setVideoFps(value: Int) {
    video = video.copy(fps = value)
  }

  fun setVideoBitrate(value: Int) {
    video = video.copy(bitrate = value)
  }

  /** Stored for recording; also decides whether the microphone permission is required. */
  var audio = true
    private set

  fun setAudio(value: Boolean) {
    audio = value
  }

  /** The view is on screen and the app is in the foreground. */
  fun start() {
    if (isOpen) return
    missingPermission()?.let {
      onError(CameraError("permissionMissing", "$it permission has not been granted"))
      return
    }
    open()
  }

  /**
   * The view left the screen (a Live Recording stops with `user`) or, with
   * [backgrounded], the app went to the background (`backgrounded`).
   */
  fun stop(backgrounded: Boolean = false) {
    recorder?.stop(if (backgrounded) StopReasons.BACKGROUNDED else StopReasons.USER)
    if (!isOpen) return
    isOpen = false
    openPosition = null
    session.close()
  }

  private val isRecording get() = recorder?.liveRecordingId != null

  /** The `startRecording` command: records with the current `video*` / `audio` props. */
  fun startRecording(recordingId: String) {
    val recorder = recorder ?: return
    if (!isOpen && !isRecording) {
      recorder.reject(recordingId, "The camera is not ready")
      return
    }
    recorder.start(recordingId, CaptureConfig(video, audio))
  }

  /** The `stopRecording` command; [reason] is a `StopReason`. */
  fun stopRecording(reason: String) {
    recorder?.stop(reason)
  }

  private fun open() {
    isOpen = true
    openPosition = position
    session.open(position) { message ->
      isOpen = false
      onError(CameraError("cameraUnavailable", message))
    }
    session.setTorch(torch)
    appliedZoom = session.setZoom(zoom)
  }

  private fun missingPermission(): String? = when {
    !isGranted(CameraPermissions.CAMERA) -> "Camera"
    audio && !isGranted(CameraPermissions.MICROPHONE) -> "Microphone"
    else -> null
  }
}
