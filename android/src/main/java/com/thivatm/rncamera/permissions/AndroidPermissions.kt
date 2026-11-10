package com.thivatm.rncamera.permissions

import android.content.Context
import android.content.pm.PackageManager
import com.facebook.react.bridge.ReactContext
import com.facebook.react.modules.core.PermissionAwareActivity

/** [PermissionPlatform] over the Android runtime permission APIs. */
class AndroidPermissionPlatform(private val context: ReactContext) : PermissionPlatform {
  override fun isGranted(permission: String) =
    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  override fun request(permissions: List<String>, onResult: () -> Unit) {
    val activity = context.currentActivity as? PermissionAwareActivity
      ?: throw NoActivityException()
    activity.requestPermissions(permissions.toTypedArray(), REQUEST_CODE) { code, _, _ ->
      if (code != REQUEST_CODE) return@requestPermissions false
      onResult()
      true
    }
  }

  private companion object {
    const val REQUEST_CODE = 0x524e43 // "RNC"
  }
}

class NoActivityException :
  IllegalStateException("No current Activity to show the permission prompt from")

/** [RequestHistory] persisted in app-private SharedPreferences. */
class SharedPreferencesRequestHistory(context: Context) : RequestHistory {
  private val prefs = context.getSharedPreferences(
    "com.thivatm.rncamera.permissions",
    Context.MODE_PRIVATE,
  )

  override fun wasRequested(permission: String) = prefs.getBoolean(permission, false)

  override fun markRequested(permission: String) {
    prefs.edit().putBoolean(permission, true).apply()
  }
}

fun CameraPermissions.Companion.forContext(context: ReactContext) = CameraPermissions(
  AndroidPermissionPlatform(context),
  SharedPreferencesRequestHistory(context),
)
