package com.thivatm.rncamera.camera

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.viewmanagers.StreamingCameraManagerDelegate
import com.facebook.react.viewmanagers.StreamingCameraManagerInterface

@ReactModule(name = StreamingCameraViewManager.NAME)
class StreamingCameraViewManager :
  SimpleViewManager<StreamingCameraView>(),
  StreamingCameraManagerInterface<StreamingCameraView> {

  private val delegate = StreamingCameraManagerDelegate(this)

  override fun getDelegate(): ViewManagerDelegate<StreamingCameraView> = delegate

  override fun getName(): String = NAME

  override fun createViewInstance(context: ThemedReactContext): StreamingCameraView =
    StreamingCameraView(context)

  companion object {
    const val NAME = "StreamingCamera"
  }
}
