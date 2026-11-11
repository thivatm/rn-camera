package com.thivatm.rncamera.camera

import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.widget.FrameLayout
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event
import com.thivatm.rncamera.recording.AudioRecordSource
import com.thivatm.rncamera.recording.MediaCodecCapture
import com.thivatm.rncamera.recording.Recorder
import com.thivatm.rncamera.recording.StreamingCameraRecorderModule
import java.io.File

/**
 * Native view behind the `StreamingCamera` Fabric component. Shows the preview
 * only while it is on screen and the app is in the foreground (see
 * [HostLifecycle]); without
 * permission it stays empty and dispatches `onCameraError`. Records to
 * `filesDir/rn-camera/recordings/<recordingId>.mp4`; capture events go to JS
 * through the `StreamingCameraRecorder` module.
 */
@SuppressLint("ViewConstructor")
class StreamingCameraView(private val reactContext: ThemedReactContext) :
  FrameLayout(reactContext), LifecycleEventListener {

  private val session = CameraXSession(reactContext, this)

  val controller = StreamingCameraController(
    session = session,
    isGranted = { reactContext.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED },
    onError = ::dispatchError,
    recorder = Recorder(
      recordingsDir = File(reactContext.filesDir, "rn-camera/recordings"),
      capture = MediaCodecCapture(
        video = session,
        audioSource = { AudioRecordSource(reactContext) },
        eventHandler = Handler(Looper.getMainLooper()),
      ),
      events = StreamingCameraRecorderModule.events,
    ),
  )

  private val hostLifecycle = HostLifecycle(controller) { isAttachedToWindow }

  /** The app's foreground / background, from the process lifecycle. */
  private val appLifecycle = object : DefaultLifecycleObserver {
    override fun onStart(owner: LifecycleOwner) = hostLifecycle.onAppForeground()

    override fun onStop(owner: LifecycleOwner) = hostLifecycle.onAppBackground()
  }

  private val pinch = ScaleGestureDetector(
    reactContext,
    object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
      override fun onScale(detector: ScaleGestureDetector): Boolean {
        controller.onPinch(detector.scaleFactor)
        return true
      }
    },
  )

  private val tap = GestureDetector(
    reactContext,
    object : GestureDetector.SimpleOnGestureListener() {
      override fun onSingleTapUp(e: MotionEvent): Boolean {
        controller.onTap(e.x, e.y)
        return true
      }
    },
  )

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    reactContext.addLifecycleEventListener(this)
    // Replays ON_START at once if the app is already in the foreground.
    ProcessLifecycleOwner.get().lifecycle.addObserver(appLifecycle)
    controller.start()
  }

  override fun onDetachedFromWindow() {
    reactContext.removeLifecycleEventListener(this)
    ProcessLifecycleOwner.get().lifecycle.removeObserver(appLifecycle)
    controller.stop()
    super.onDetachedFromWindow()
  }

  override fun onHostResume() = hostLifecycle.onHostResume()

  override fun onHostPause() = hostLifecycle.onHostPause()

  override fun onHostDestroy() = hostLifecycle.onHostDestroy()

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    pinch.onTouchEvent(event)
    tap.onTouchEvent(event)
    return true
  }

  // React Native does not lay out natively added children (the PreviewView),
  // so do it by hand whenever they ask for layout.
  // Called from the FrameLayout constructor too, so it must not touch fields.
  override fun requestLayout() {
    super.requestLayout()
    post {
      measure(
        MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
        MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
      )
      layout(left, top, right, bottom)
    }
  }

  private fun dispatchError(error: CameraError) {
    val surfaceId = UIManagerHelper.getSurfaceId(reactContext)
    UIManagerHelper.getEventDispatcher(reactContext)
      ?.dispatchEvent(ErrorEvent(surfaceId, id, error))
  }

  private class ErrorEvent(surfaceId: Int, viewId: Int, private val error: CameraError) :
    Event<ErrorEvent>(surfaceId, viewId) {
    override fun getEventName() = EVENT_NAME

    override fun getEventData(): WritableMap = Arguments.createMap().apply {
      putString("code", error.code)
      putString("message", error.message)
    }
  }

  companion object {
    const val EVENT_NAME = "topCameraError"
  }
}
