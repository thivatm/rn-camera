package com.thivatm.rncamera.camera

import org.junit.Assert.assertEquals
import org.junit.Test

class StreamingCameraControllerTest {
  private val session = FakeCameraSession()
  private val granted = mutableSetOf<String>()
  private val errors = mutableListOf<CameraError>()
  private val controller = StreamingCameraController(
    session = session,
    isGranted = { it in granted },
    onError = { errors += it },
  )

  @Test
  fun withoutCameraPermissionItShowsNothingAndReportsAnError() {
    controller.start()

    assertEquals(null, session.openedAt)
    assertEquals(listOf("permissionDenied"), errors.map { it.code })
  }

  @Test
  fun withPermissionItOpensTheBackCameraByDefault() {
    granted += setOf(CAMERA, MICROPHONE)

    controller.start()

    assertEquals(CameraPosition.BACK, session.openedAt)
    assertEquals(emptyList<CameraError>(), errors)
  }

  @Test
  fun propsSetBeforeStartAreAppliedWhenThePreviewOpens() {
    granted += setOf(CAMERA, MICROPHONE)
    controller.setPosition("front")
    controller.setTorch(true)
    controller.setZoom(2.5f)

    controller.start()

    assertEquals(CameraPosition.FRONT, session.openedAt)
    assertEquals(true, session.torchOn)
    assertEquals(2.5f, session.zoomRatio)
  }

  @Test
  fun withAudioOnAMissingMicrophonePermissionAlsoShowsNothing() {
    granted += CAMERA

    controller.start()

    assertEquals(null, session.openedAt)
    assertEquals(listOf("permissionDenied"), errors.map { it.code })
  }

  @Test
  fun withAudioOffOnlyTheCameraPermissionIsNeeded() {
    granted += CAMERA
    controller.setAudio(false)

    controller.start()

    assertEquals(CameraPosition.BACK, session.openedAt)
    assertEquals(emptyList<CameraError>(), errors)
  }

  @Test
  fun propChangesWhileOpenReachTheCamera() {
    granted += setOf(CAMERA, MICROPHONE)
    controller.start()

    controller.setTorch(true)
    controller.setZoom(3f)
    controller.setPosition("front")

    assertEquals(CameraPosition.FRONT, session.openedAt)
    assertEquals(true, session.torchOn)
    assertEquals(3f, session.zoomRatio)
  }

  @Test
  fun stopReleasesTheCameraAndPropChangesDoNotReopenIt() {
    granted += setOf(CAMERA, MICROPHONE)
    controller.start()

    controller.stop()
    controller.setPosition("front")

    assertEquals(null, session.openedAt)
    assertEquals(1, session.opens)
  }

  @Test
  fun aCameraThatCannotBeOpenedIsReportedAsUnavailable() {
    granted += setOf(CAMERA, MICROPHONE)
    session.failOpenWith = "No front camera"
    controller.setPosition("front")

    controller.start()

    assertEquals(listOf(CameraError("cameraUnavailable", "No front camera")), errors)
  }

  @Test
  fun gesturesDoNothingUnlessEnabled() {
    granted += setOf(CAMERA, MICROPHONE)
    controller.start()

    controller.onPinch(2f)
    controller.onTap(10f, 20f)

    assertEquals(1f, session.zoomRatio)
    assertEquals(emptyList<Pair<Float, Float>>(), session.focusPoints)
  }

  @Test
  fun pinchScalesTheCurrentZoomWithinTheCameraRange() {
    granted += setOf(CAMERA, MICROPHONE)
    session.zoomRange = 1f..4f
    controller.setEnablePinchToZoom(true)
    controller.setZoom(1.5f)
    controller.start()

    controller.onPinch(2f)
    assertEquals(3f, session.zoomRatio)

    controller.onPinch(2f)
    assertEquals(4f, session.zoomRatio)

    controller.onPinch(0.5f)
    assertEquals(2f, session.zoomRatio)
  }

  @Test
  fun tapFocusesWhereTheUserTapped() {
    granted += setOf(CAMERA, MICROPHONE)
    controller.setEnableTapToFocus(true)
    controller.start()

    controller.onTap(10f, 20f)

    assertEquals(listOf(10f to 20f), session.focusPoints)
  }

  @Test
  fun videoSettingsDefaultToTheSpec() {
    controller.setVideo(null)

    assertEquals(VideoSettings(codec = "h264", resolution = "1080p", fps = 30, bitrate = 5_000_000), controller.video)
  }

  @Test
  fun videoSettingsAreStoredForRecording() {
    // JS numbers arrive as doubles.
    controller.setVideo(mapOf("codec" to "hevc", "resolution" to "720p", "fps" to 60.0, "bitrate" to 2_000_000.0))

    assertEquals(VideoSettings(codec = "hevc", resolution = "720p", fps = 60, bitrate = 2_000_000), controller.video)
  }

  @Test
  fun startingAgainWhileOpenKeepsTheCurrentPreview() {
    granted += setOf(CAMERA, MICROPHONE)
    controller.start()

    controller.start()

    assertEquals(1, session.opens)
  }

  @Test
  fun permissionGrantedLaterOpensThePreviewOnTheNextStart() {
    controller.start()
    controller.stop()
    granted += setOf(CAMERA, MICROPHONE)

    controller.start()

    assertEquals(CameraPosition.BACK, session.openedAt)
  }

  private companion object {
    const val CAMERA = "android.permission.CAMERA"
    const val MICROPHONE = "android.permission.RECORD_AUDIO"
  }
}

/** Stands in for CameraX. Records what the controller asked the camera to do. */
class FakeCameraSession : CameraSession {
  var openedAt: CameraPosition? = null
  var opens = 0
  var torchOn = false
  var zoomRatio = 1f
  var zoomRange = 1f..10f
  val focusPoints = mutableListOf<Pair<Float, Float>>()
  var failOpenWith: String? = null

  override fun open(position: CameraPosition, onError: (String) -> Unit) {
    failOpenWith?.let {
      onError(it)
      return
    }
    openedAt = position
    opens++
  }

  override fun close() {
    openedAt = null
  }

  override fun setTorch(enabled: Boolean) {
    torchOn = enabled
  }

  override fun setZoom(ratio: Float): Float {
    zoomRatio = ratio.coerceIn(zoomRange)
    return zoomRatio
  }

  override fun focusAt(x: Float, y: Float) {
    focusPoints += x to y
  }
}
