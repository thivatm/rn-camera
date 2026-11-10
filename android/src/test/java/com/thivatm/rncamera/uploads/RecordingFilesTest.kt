package com.thivatm.rncamera.uploads

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class RecordingFilesTest {
  @get:Rule val tmp = TemporaryFolder()

  private fun file(vararg bytes: Int) =
    tmp.newFile().apply { writeBytes(ByteArray(bytes.size) { bytes[it].toByte() }) }

  @Test
  fun readRangeReturnsTheBytesAtTheOffset() {
    val f = file(0, 0, 0, 24, 'f'.code, 't'.code, 'y'.code, 'p'.code, 9)

    assertArrayEquals(
      byteArrayOf(0, 0, 0, 24, 'f'.code.toByte(), 't'.code.toByte(), 'y'.code.toByte(), 'p'.code.toByte()),
      RecordingFiles.readRange(f.path, 0, 8),
    )
    assertArrayEquals(byteArrayOf(24, 'f'.code.toByte()), RecordingFiles.readRange(f.path, 3, 2))
  }

  @Test
  fun readRangeStopsAtEndOfFile() {
    val f = file(1, 2, 3)

    assertArrayEquals(byteArrayOf(2, 3), RecordingFiles.readRange(f.path, 1, 100))
    assertArrayEquals(byteArrayOf(), RecordingFiles.readRange(f.path, 3, 8))
  }

  @Test
  fun truncateKeepsOnlyTheLeadingBytes() {
    val f = file(1, 2, 3, 4, 5, 6)

    RecordingFiles.truncate(f.path, 4)

    assertEquals(4L, RecordingFiles.size(f.path))
    assertArrayEquals(byteArrayOf(1, 2, 3, 4), f.readBytes())
  }

  @Test
  fun sizeIsTheByteLength() {
    assertEquals(3L, RecordingFiles.size(file(7, 8, 9).path))
  }

  @Test(expected = java.io.FileNotFoundException::class)
  fun sizeOfAMissingFileThrowsFileNotFound() {
    RecordingFiles.size(tmp.root.resolve("missing.mp4").path)
  }

  @Test
  fun deleteRemovesTheFileAndIgnoresMissingFiles() {
    val f = file(1)

    RecordingFiles.delete(f.path)
    RecordingFiles.delete(f.path)

    assertFalse(f.exists())
  }

  @Test
  fun freeDiskSpaceIsPositiveForAWritableDirectory() {
    assertTrue(RecordingFiles.freeDiskSpace(tmp.root) > 0)
  }
}
