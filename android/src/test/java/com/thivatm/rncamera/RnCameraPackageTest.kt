package com.thivatm.rncamera

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Harness check: JVM unit tests for the library run under Gradle.
 * Feature tickets add their own test files next to this one.
 */
class RnCameraPackageTest {
  @Test
  fun registersRecordingUploadsTurboModule() {
    val infos = RnCameraPackage().getReactModuleInfoProvider().getReactModuleInfos()

    assertEquals(setOf("RecordingUploads"), infos.keys)
    assertEquals(true, infos["RecordingUploads"]?.isTurboModule)
  }
}
