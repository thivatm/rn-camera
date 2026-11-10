package com.thivatm.rncamera

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager
import com.thivatm.rncamera.camera.StreamingCameraViewManager
import com.thivatm.rncamera.uploads.RecordingUploadsModule

/** Registers the `RecordingUploads` Turbo Module and the `StreamingCamera` view. */
class RnCameraPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    when (name) {
      RecordingUploadsModule.NAME -> RecordingUploadsModule(reactContext)
      else -> null
    }

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    listOf(StreamingCameraViewManager())

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      RecordingUploadsModule.NAME to ReactModuleInfo(
        name = RecordingUploadsModule.NAME,
        className = RecordingUploadsModule::class.java.name,
        canOverrideExistingModule = false,
        needsEagerInit = false,
        isCxxModule = false,
        isTurboModule = true,
      ),
    )
  }
}
