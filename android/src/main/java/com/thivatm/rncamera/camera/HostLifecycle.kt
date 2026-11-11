package com.thivatm.rncamera.camera

/**
 * Maps host lifecycle signals to [StreamingCameraController]. Only the app
 * going to the background (the process stops, not merely the Activity
 * pausing, e.g. under the system permission dialog) stops a Live Recording
 * with `backgrounded` and closes the camera; coming back to the foreground
 * reopens it while the view is attached ([isAttached]).
 */
class HostLifecycle(
  private val controller: StreamingCameraController,
  private val isAttached: () -> Boolean,
) {
  /** The Activity resumed. */
  fun onHostResume() = startIfAttached()

  /**
   * The Activity paused. The app may still be in the foreground (a dialog or
   * a transparent Activity over it), so the camera and any Live Recording
   * carry on; [onAppBackground] follows if the app really leaves.
   */
  fun onHostPause() = Unit

  /** The Activity is being destroyed. */
  fun onHostDestroy() = controller.stop(backgrounded = true)

  /** The app went to the background (no Activity of it is visible). */
  fun onAppBackground() = controller.stop(backgrounded = true)

  /** The app came back to the foreground. */
  fun onAppForeground() = startIfAttached()

  private fun startIfAttached() {
    if (isAttached()) controller.start()
  }
}
