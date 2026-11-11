package com.thivatm.rncamera.recording

import androidx.media3.common.Format
import androidx.media3.container.Mp4OrientationData
import androidx.media3.muxer.BufferInfo
import androidx.media3.muxer.FragmentedMp4Muxer
import androidx.media3.muxer.Muxer
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer

/** `MediaCodec.BUFFER_FLAG_KEY_FRAME`, without depending on android.media here. */
const val SAMPLE_FLAG_KEY_FRAME = 1

/**
 * A Recording File written as fragmented MP4 (ADR 0002): `ftyp` + `moov`,
 * then a `moof` + `mdat` Fragment about every 2 s. The file is opened for
 * append only, so bytes already written can never change.
 *
 * [onFragmentWritten] runs, on the writing thread, each time the file grows
 * (i.e. a Fragment was appended), with the new file size.
 */
class FragmentedRecordingFile(
  file: File,
  private val onFragmentWritten: (fileSize: Long) -> Unit,
) : SampleSink {
  private val output = CountingOutputStream(FileOutputStream(file, true))
  private val muxer: Muxer = FragmentedMp4Muxer.Builder(output)
    // Just under the 2 s keyframe interval: the muxer only cuts once the
    // duration is exceeded, so 2_000 would give 4 s Fragments (ticket 01).
    .setFragmentDurationMs(FRAGMENT_DURATION_MS)
    .build()
  private var reported = 0L

  override fun addTrack(format: Format): Int = muxer.addTrack(format)

  /** Display rotation of the video, fixed when recording starts. */
  fun setOrientation(degrees: Int) {
    muxer.addMetadataEntry(Mp4OrientationData(degrees))
  }

  /** [flags] are `MediaCodec.BUFFER_FLAG_*` bits. */
  override fun writeSample(track: Int, data: ByteBuffer, presentationTimeUs: Long, flags: Int) {
    muxer.writeSampleData(track, data, BufferInfo(presentationTimeUs, data.remaining(), flags))
    if (output.count > reported) {
      reported = output.count
      onFragmentWritten(reported)
    }
  }

  /** Flushes the last Fragment and closes the file; returns its final size. */
  fun close(): Long {
    muxer.close()
    return output.count
  }

  private class CountingOutputStream(private val out: OutputStream) : OutputStream() {
    var count = 0L
      private set

    override fun write(b: Int) {
      out.write(b)
      count++
    }

    override fun write(b: ByteArray, off: Int, len: Int) {
      out.write(b, off, len)
      count += len
    }

    override fun flush() = out.flush()

    override fun close() = out.close()
  }

  companion object {
    const val FRAGMENT_DURATION_MS = 1_900L
  }
}
