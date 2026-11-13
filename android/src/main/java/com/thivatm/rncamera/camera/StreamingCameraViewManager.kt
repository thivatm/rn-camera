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

  override fun setCameraPosition(view: StreamingCameraView, value: String?) =
    view.controller.setPosition(value)

  override fun setTorch(view: StreamingCameraView, value: Boolean) =
    view.controller.setTorch(value)

  override fun setZoom(view: StreamingCameraView, value: Float) =
    view.controller.setZoom(value)

  override fun setEnablePinchToZoom(view: StreamingCameraView, value: Boolean) =
    view.controller.setEnablePinchToZoom(value)

  override fun setEnableTapToFocus(view: StreamingCameraView, value: Boolean) =
    view.controller.setEnableTapToFocus(value)

  override fun setVideoCodec(view: StreamingCameraView, value: String?) =
    view.controller.setVideoCodec(value)

  override fun setVideoResolution(view: StreamingCameraView, value: String?) =
    view.controller.setVideoResolution(value)

  override fun setVideoFps(view: StreamingCameraView, value: Int) =
    view.controller.setVideoFps(value)

  override fun setVideoBitrate(view: StreamingCameraView, value: Int) =
    view.controller.setVideoBitrate(value)

  override fun setAudio(view: StreamingCameraView, value: Boolean) =
    view.controller.setAudio(value)

  override fun startRecording(view: StreamingCameraView, recordingId: String) =
    view.controller.startRecording(recordingId)

  override fun stopRecording(view: StreamingCameraView, reason: String) =
    view.controller.stopRecording(reason)

  override fun onDropViewInstance(view: StreamingCameraView) {
    view.controller.stop()
    super.onDropViewInstance(view)
  }

  override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> =
    mapOf(StreamingCameraView.EVENT_NAME to mapOf("registrationName" to "onCameraError"))

  companion object {
    const val NAME = "StreamingCamera"
  }
}
