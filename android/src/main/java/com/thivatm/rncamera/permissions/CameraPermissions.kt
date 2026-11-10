package com.thivatm.rncamera.permissions

import android.Manifest

/** Spec §3.4 `PermissionState`. Android has no `restricted` state. */
enum class PermissionState(val jsValue: String) {
  GRANTED("granted"),
  DENIED("denied"),
  UNDETERMINED("undetermined"),
}

data class PermissionStatus(val camera: PermissionState, val microphone: PermissionState) {
  /** The JS `PermissionStatus` object. */
  fun toJs(): Map<String, String> =
    mapOf("camera" to camera.jsValue, "microphone" to microphone.jsValue)
}

/** The OS permission APIs. */
interface PermissionPlatform {
  fun isGranted(permission: String): Boolean

  /** Shows the system prompt; [onResult] runs once the user has answered. */
  fun request(permissions: List<String>, onResult: () -> Unit)
}

/**
 * Remembers which permissions the library has asked for. Android cannot tell
 * "never asked" from "denied" on its own, so this is what separates
 * `undetermined` from `denied`.
 */
interface RequestHistory {
  fun wasRequested(permission: String): Boolean
  fun markRequested(permission: String)
}

/** Camera and microphone permission state and requests (spec §3.4). */
class CameraPermissions(
  private val platform: PermissionPlatform,
  private val history: RequestHistory,
) {
  fun status() = PermissionStatus(
    camera = stateOf(CAMERA),
    microphone = stateOf(MICROPHONE),
  )

  /** Prompts for the camera, plus the microphone when [audio] is true. */
  fun request(audio: Boolean, onResult: (PermissionStatus) -> Unit) {
    val wanted = if (audio) listOf(CAMERA, MICROPHONE) else listOf(CAMERA)
    val missing = wanted.filterNot(platform::isGranted)
    if (missing.isEmpty()) {
      onResult(status())
      return
    }
    platform.request(missing) {
      missing.forEach(history::markRequested)
      onResult(status())
    }
  }

  private fun stateOf(permission: String) = when {
    platform.isGranted(permission) -> PermissionState.GRANTED
    history.wasRequested(permission) -> PermissionState.DENIED
    else -> PermissionState.UNDETERMINED
  }

  companion object {
    const val CAMERA = Manifest.permission.CAMERA
    const val MICROPHONE = Manifest.permission.RECORD_AUDIO
  }
}
