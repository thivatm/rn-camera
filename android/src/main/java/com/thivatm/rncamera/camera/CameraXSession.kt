package com.thivatm.rncamera.camera

import android.annotation.SuppressLint
import android.content.Context
import android.util.Range
import android.view.Surface
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceRequest
import androidx.camera.core.impl.ConstantObservable
import androidx.camera.core.impl.Observable
import androidx.camera.core.impl.Timebase
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.MediaSpec
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoOutput
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.Observer
import com.thivatm.rncamera.recording.VideoFrameListener
import com.thivatm.rncamera.recording.VideoFrameSource
import com.thivatm.rncamera.recording.VideoSourceRequest

/**
 * [CameraSession] on CameraX. Owns its own lifecycle so the camera is bound
 * exactly while the controller has it open, independent of the host Activity.
 * While recording it also binds a [VideoCapture] whose frames go to the
 * recording encoder ([VideoFrameSource]). All calls must happen on the main
 * thread.
 */
class CameraXSession(
  private val context: Context,
  private val container: FrameLayout,
) : CameraSession, VideoFrameSource, LifecycleOwner {

  private val registry = LifecycleRegistry(this)
  override val lifecycle: Lifecycle get() = registry

  private var previewView: PreviewView? = null
  private var preview: Preview? = null
  private var provider: ProcessCameraProvider? = null
  private var camera: Camera? = null
  private var videoCapture: VideoCapture<EncoderOutput>? = null
  private var cameraStateObserver: Observer<CameraState>? = null
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
    stop()
    preview?.let { provider?.unbind(it) }
    preview = null
    camera = null
  }

  // VideoFrameSource

  override fun start(request: VideoSourceRequest, listener: VideoFrameListener) {
    val cameraProvider = provider
    val cam = camera
    val previewUseCase = preview
    if (cameraProvider == null || cam == null || previewUseCase == null) {
      listener.onSourceLost()
      return
    }
    val quality = when (request.resolution) {
      VideoResolution.HD_720P -> Quality.HD
      VideoResolution.FHD_1080P -> Quality.FHD
    }
    val output = EncoderOutput(
      QualitySelector.from(quality, FallbackStrategy.lowerQualityOrHigherThan(quality)),
      listener,
    )
    val useCase = VideoCapture.Builder(output)
      .setTargetFrameRate(Range(request.fps, request.fps))
      // Orientation is fixed when recording starts (spec §3.2).
      .setTargetRotation(container.display?.rotation ?: Surface.ROTATION_0)
      .build()
    try {
      // Rebinding with the preview: the camera reconfigures for both streams.
      cameraProvider.bindToLifecycle(this, cam.cameraInfo.cameraSelector, previewUseCase, useCase)
    } catch (e: Exception) {
      listener.onSourceLost()
      return
    }
    videoCapture = useCase
    val observer = Observer<CameraState> { state ->
      // Another app took the camera, or it failed. (CLOSED alone also happens on rebinds.)
      if (state.error != null) listener.onSourceLost()
    }
    cam.cameraInfo.cameraState.observe(this, observer)
    cameraStateObserver = observer
  }

  override fun stop() {
    cameraStateObserver?.let { camera?.cameraInfo?.cameraState?.removeObserver(it) }
    cameraStateObserver = null
    videoCapture?.let { provider?.unbind(it) }
    videoCapture = null
  }

  /**
   * Hands CameraX's video Surface request to the recording encoder. Uses
   * CameraX's library-internal [VideoOutput] hooks (MediaSpec, Timebase):
   * public `Recorder` can only write regular MP4, not fragmented MP4.
   */
  @SuppressLint("RestrictedApi")
  private inner class EncoderOutput(
    qualitySelector: QualitySelector,
    private val listener: VideoFrameListener,
  ) : VideoOutput {
    private val mediaSpec = MediaSpec.builder()
      .configureVideo { it.setQualitySelector(qualitySelector) }
      .build()
    private var requested = false

    override fun getMediaSpec(): Observable<MediaSpec> = ConstantObservable.withValue(mediaSpec)

    override fun onSurfaceRequested(request: SurfaceRequest) =
      onSurfaceRequested(request, Timebase.UPTIME, false)

    override fun onSurfaceRequested(request: SurfaceRequest, timebase: Timebase, hasGlProcessing: Boolean) {
      val executor = ContextCompat.getMainExecutor(context)
      request.setTransformationInfoListener(executor) { info ->
        if (requested) return@setTransformationInfoListener
        requested = true
        listener.onSurfaceRequested(
          request.resolution.width,
          request.resolution.height,
          info.rotationDegrees,
          realtimeTimestamps = timebase == Timebase.REALTIME,
        ) { surface -> request.provideSurface(surface, executor) {} }
      }
    }
  }

  private companion object {
    const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
  }
}
