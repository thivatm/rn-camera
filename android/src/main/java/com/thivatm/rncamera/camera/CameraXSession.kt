package com.thivatm.rncamera.camera

import android.content.Context
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry

/**
 * [CameraSession] on CameraX. Owns its own lifecycle so the camera is bound
 * exactly while the controller has it open, independent of the host Activity.
 * All calls must happen on the main thread.
 */
class CameraXSession(
  private val context: Context,
  private val container: FrameLayout,
) : CameraSession, LifecycleOwner {

  private val registry = LifecycleRegistry(this)
  override val lifecycle: Lifecycle get() = registry

  private var previewView: PreviewView? = null
  private var preview: Preview? = null
  private var provider: ProcessCameraProvider? = null
  private var camera: Camera? = null
  private var torch = false
  private var zoom = 1f

  /** Bumped on every open/close so stale async binds are dropped. */
  private var generation = 0

  override fun open(position: CameraPosition, onError: (String) -> Unit) {
    unbind()
    val token = ++generation
    val view = previewView ?: PreviewView(context).also {
      it.implementationMode = PreviewView.ImplementationMode.COMPATIBLE
      container.addView(it, ViewGroup.LayoutParams(MATCH, MATCH))
      previewView = it
    }
    registry.currentState = Lifecycle.State.RESUMED

    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      if (token != generation) return@addListener
      try {
        val cameraProvider = future.get()
        val selector = when (position) {
          CameraPosition.FRONT -> CameraSelector.DEFAULT_FRONT_CAMERA
          CameraPosition.BACK -> CameraSelector.DEFAULT_BACK_CAMERA
        }
        if (!cameraProvider.hasCamera(selector)) {
          close()
          onError("This device has no ${position.name.lowercase()} camera")
          return@addListener
        }
        val useCase = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
        camera = cameraProvider.bindToLifecycle(this, selector, useCase)
        provider = cameraProvider
        preview = useCase
        applyTorch()
        applyZoom()
      } catch (e: Exception) {
        close()
        onError(e.message ?: "The camera could not be opened")
      }
    }, ContextCompat.getMainExecutor(context))
  }

  override fun close() {
    generation++
    unbind()
    if (registry.currentState.isAtLeast(Lifecycle.State.CREATED)) {
      registry.currentState = Lifecycle.State.CREATED
    }
    previewView?.let(container::removeView)
    previewView = null
  }

  override fun setTorch(enabled: Boolean) {
    torch = enabled
    applyTorch()
  }

  override fun setZoom(ratio: Float): Float {
    zoom = ratio
    return applyZoom()
  }

  override fun focusAt(x: Float, y: Float) {
    val control = camera?.cameraControl ?: return
    val point = previewView?.meteringPointFactory?.createPoint(x, y) ?: return
    control.startFocusAndMetering(FocusMeteringAction.Builder(point).build())
  }

  private fun applyTorch() {
    val cam = camera ?: return
    if (cam.cameraInfo.hasFlashUnit()) cam.cameraControl.enableTorch(torch)
  }

  private fun applyZoom(): Float {
    val cam = camera ?: return zoom
    val state = cam.cameraInfo.zoomState.value ?: return zoom
    val clamped = zoom.coerceIn(state.minZoomRatio, state.maxZoomRatio)
    cam.cameraControl.setZoomRatio(clamped)
    return clamped
  }

  private fun unbind() {
    preview?.let { provider?.unbind(it) }
    preview = null
    camera = null
  }

  private companion object {
    const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
  }
}
