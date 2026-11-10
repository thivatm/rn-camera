package com.thivatm.rncamera.permissions

import org.junit.Assert.assertEquals
import org.junit.Test

class CameraPermissionsTest {
  private val platform = FakePermissionPlatform()
  private val history = InMemoryRequestHistory()
  private val permissions = CameraPermissions(platform, history)

  @Test
  fun statusIsUndeterminedBeforeAnyRequest() {
    assertEquals(
      PermissionStatus(camera = PermissionState.UNDETERMINED, microphone = PermissionState.UNDETERMINED),
      permissions.status(),
    )
  }

  @Test
  fun requestWithAudioAsksForCameraAndMicrophoneAndReportsTheAnswer() {
    platform.userAllows += CAMERA

    val result = requestAndAwait(audio = true)

    assertEquals(listOf(listOf(CAMERA, MICROPHONE)), platform.requests)
    assertEquals(
      PermissionStatus(camera = PermissionState.GRANTED, microphone = PermissionState.DENIED),
      result,
    )
    assertEquals(result, permissions.status())
  }

  @Test
  fun requestWithoutAudioLeavesTheMicrophoneUndetermined() {
    platform.userAllows += setOf(CAMERA, MICROPHONE)

    val result = requestAndAwait(audio = false)

    assertEquals(listOf(listOf(CAMERA)), platform.requests)
    assertEquals(
      PermissionStatus(camera = PermissionState.GRANTED, microphone = PermissionState.UNDETERMINED),
      result,
    )
  }

  @Test
  fun requestDoesNotPromptWhenEverythingIsAlreadyGranted() {
    platform.granted += setOf(CAMERA, MICROPHONE)

    val result = requestAndAwait(audio = true)

    assertEquals(emptyList<List<String>>(), platform.requests)
    assertEquals(
      PermissionStatus(camera = PermissionState.GRANTED, microphone = PermissionState.GRANTED),
      result,
    )
  }

  @Test
  fun aDeniedPermissionStaysDeniedOnLaterStatusChecks() {
    requestAndAwait(audio = true)

    val later = CameraPermissions(platform, history)

    assertEquals(
      PermissionStatus(camera = PermissionState.DENIED, microphone = PermissionState.DENIED),
      later.status(),
    )
  }

  @Test
  fun statusIsSentToJsAsPlainStrings() {
    val status = PermissionStatus(camera = PermissionState.GRANTED, microphone = PermissionState.UNDETERMINED)

    assertEquals(mapOf("camera" to "granted", "microphone" to "undetermined"), status.toJs())
  }

  private fun requestAndAwait(audio: Boolean): PermissionStatus? {
    var result: PermissionStatus? = null
    permissions.request(audio) { result = it }
    return result
  }

  private companion object {
    const val CAMERA = "android.permission.CAMERA"
    const val MICROPHONE = "android.permission.RECORD_AUDIO"
  }
}

/** Simulates the OS: grants whatever the "user" is set to allow when asked. */
class FakePermissionPlatform : PermissionPlatform {
  val granted = mutableSetOf<String>()
  val userAllows = mutableSetOf<String>()
  val requests = mutableListOf<List<String>>()
  var answerImmediately = true
  private var pending: (() -> Unit)? = null

  override fun isGranted(permission: String) = permission in granted

  override fun request(permissions: List<String>, onResult: () -> Unit) {
    requests += permissions
    pending = {
      granted += permissions.filter { it in userAllows }
      onResult()
    }
    if (answerImmediately) answer()
  }

  fun answer() {
    pending?.invoke()
    pending = null
  }
}

class InMemoryRequestHistory : RequestHistory {
  private val requested = mutableSetOf<String>()
  override fun wasRequested(permission: String) = permission in requested
  override fun markRequested(permission: String) {
    requested += permission
  }
}
