package com.thivatm.rncamera

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Harness check: JVM unit tests for the library run under Gradle.
 * Feature tickets add their own test files next to this one.
 */
class RnCameraPackageTest {
  private val infos = RnCameraPackage().getReactModuleInfoProvider().getReactModuleInfos()

  @Test
  fun registersRecordingUploadsTurboModule() {
    assertEquals(true, infos["RecordingUploads"]?.isTurboModule)
  }

  @Test
  fun registersStreamingCameraRecorderTurboModule() {
    assertEquals(true, infos["StreamingCameraRecorder"]?.isTurboModule)
  }

  @Test
  fun registersCameraPermissionsTurboModule() {
    assertEquals(true, infos["CameraPermissions"]?.isTurboModule)
  }
}
