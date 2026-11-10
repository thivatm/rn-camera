package com.thivatm.rncamera.permissions

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.UiThreadUtil
import com.thivatm.rncamera.NativeCameraPermissionsSpec

/** Turbo Module `CameraPermissions` (spec §3.4). */
class CameraPermissionsModule(reactContext: ReactApplicationContext) :
  NativeCameraPermissionsSpec(reactContext) {

  private val permissions = CameraPermissions.forContext(reactContext)

  override fun getPermissionStatus(promise: Promise) {
    promise.resolve(permissions.status().toWritableMap())
  }

  override fun requestPermissions(options: ReadableMap, promise: Promise) {
    val audio = options.hasKey("audio") && options.getBoolean("audio")
    UiThreadUtil.runOnUiThread {
      try {
        permissions.request(audio) { promise.resolve(it.toWritableMap()) }
      } catch (e: NoActivityException) {
        promise.reject("E_NO_ACTIVITY", e.message, e)
      }
    }
  }

  private fun PermissionStatus.toWritableMap() =
    Arguments.createMap().apply { toJs().forEach { (key, value) -> putString(key, value) } }

  companion object {
    const val NAME = NativeCameraPermissionsSpec.NAME
  }
}
