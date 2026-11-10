package com.thivatm.rncamera.camera

import com.thivatm.rncamera.permissions.CameraPermissions

enum class CameraPosition { FRONT, BACK }

/** The `video` prop (spec §3.2). Stored for recording. */
data class VideoSettings(
  val codec: String = "h264",
  val resolution: String = "1080p",
  val fps: Int = 30,
  val bitrate: Int = 5_000_000,
) {
  companion object {
    fun fromJs(map: Map<String, Any?>?): VideoSettings {
      val defaults = VideoSettings()
      if (map == null) return defaults
      return VideoSettings(
        codec = map["codec"] as? String ?: defaults.codec,
        resolution = map["resolution"] as? String ?: defaults.resolution,
        fps = (map["fps"] as? Number)?.toInt() ?: defaults.fps,
        bitrate = (map["bitrate"] as? Number)?.toInt() ?: defaults.bitrate,
      )
    }
  }
}

/** Payload of the `onError` event. */
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
) {
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
    if (isOpen) open()
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

  fun setVideo(value: Map<String, Any?>?) {
    video = VideoSettings.fromJs(value)
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
      onError(CameraError("permissionDenied", "$it permission has not been granted"))
      return
    }
    open()
  }

  /** The view left the screen or the app went to the background. */
  fun stop() {
    if (!isOpen) return
    isOpen = false
    session.close()
  }

  private fun open() {
    isOpen = true
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
