package com.thivatm.rncamera.recording

import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.nio.ByteBuffer

@RunWith(AndroidJUnit4::class)
class FragmentedRecordingFileTest {
  @get:Rule val tmp = TemporaryFolder()

  private val aac = Format.Builder()
    .setSampleMimeType(MimeTypes.AUDIO_AAC)
    .setSampleRate(48_000)
    .setChannelCount(1)
    .setInitializationData(listOf(byteArrayOf(0x11, 0x88.toByte())))
    .build()

  /** Writes [seconds] of fake 48 kHz AAC frames (1024 samples each). */
  private fun FragmentedRecordingFile.writeAudio(track: Int, seconds: Int) {
    val frameUs = 1024L * 1_000_000 / 48_000
    val frames = (seconds * 1_000_000L / frameUs).toInt()
    repeat(frames) { i ->
      val payload = ByteArray(200) { (i + it).toByte() }
      writeSample(track, ByteBuffer.wrap(payload), i * frameUs, SAMPLE_FLAG_KEY_FRAME)
    }
  }

  @Test
  fun fragmentsAreAppendedAboutEveryTwoSecondsAndReportedAsTheyAreWritten() {
    val file = File(tmp.root, "rec.mp4")
    val growth = mutableListOf<Pair<Long, List<String>>>()
    var lastPtsUs = 0L
    val recording = FragmentedRecordingFile(file) {
      growth += lastPtsUs to topLevelBoxes(file.readBytes())
    }
    val track = recording.addTrack(aac)
    val frameUs = 1024L * 1_000_000 / 48_000

    repeat((9_000_000 / frameUs).toInt()) { i ->
      lastPtsUs = i * frameUs
      recording.writeSample(track, ByteBuffer.wrap(ByteArray(200)), lastPtsUs, SAMPLE_FLAG_KEY_FRAME)
    }

    // Each growth ends on a whole box; the header may come on its own first.
    val fragmentGrowth = growth.filter { (_, boxes) -> "moof" in boxes }
    assertEquals(4, fragmentGrowth.size)
    var previousUs = 0L
    fragmentGrowth.forEachIndexed { i, (ptsUs, boxes) ->
      assertEquals(i + 1, boxes.count { it == "moof" })
      assertTrue("Fragment ${i + 1} spans ${ptsUs - previousUs} us", ptsUs - previousUs in 1_900_000..2_100_000)
      previousUs = ptsUs
    }
  }

  @Test
  fun bytesAlreadyWrittenAreNeverRewritten() {
    val file = File(tmp.root, "rec.mp4")
    val snapshots = mutableListOf<ByteArray>()
    val recording = FragmentedRecordingFile(file) { snapshots += file.readBytes() }
    val track = recording.addTrack(aac)

    recording.writeAudio(track, seconds = 9)
    val finalSize = recording.close()

    val final = file.readBytes()
    assertEquals(final.size.toLong(), finalSize)
    assertTrue(snapshots.isNotEmpty())
    for (snapshot in snapshots) {
      assertTrue(snapshot.size < final.size)
      assertArrayEquals(snapshot, final.copyOf(snapshot.size))
    }
  }

  @Test
  fun theFileIsAFragmentedMp4WithOnlyFragmentsAfterTheHeader() {
    val file = File(tmp.root, "rec.mp4")
    val recording = FragmentedRecordingFile(file) {}
    recording.writeAudio(recording.addTrack(aac), seconds = 5)
    recording.close()

    val boxes = topLevelBoxes(file.readBytes())

    assertEquals(listOf("ftyp", "moov"), boxes.take(2))
    val rest = boxes.drop(2)
    assertTrue(rest.isNotEmpty())
    assertEquals(rest.chunked(2).map { listOf("moof", "mdat") }, rest.chunked(2))
  }
}

/** Top-level MP4 box types in order. */
fun topLevelBoxes(bytes: ByteArray): List<String> {
  val types = mutableListOf<String>()
  var offset = 0L
  while (offset + 8 <= bytes.size) {
    val buf = ByteBuffer.wrap(bytes, offset.toInt(), 16.coerceAtMost(bytes.size - offset.toInt()))
    var size = buf.int.toLong() and 0xffffffffL
    val type = String(bytes, offset.toInt() + 4, 4, Charsets.US_ASCII)
    if (size == 1L) size = buf.long
    types += type
    require(size >= 8) { "Bad box size $size at $offset" }
    offset += size
  }
  require(offset == bytes.size.toLong()) { "Trailing bytes after boxes" }
  return types
}
