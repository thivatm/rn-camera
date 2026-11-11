package com.thivatm.rncamera.recording

import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.ByteBuffer

class SampleGateTest {
  private val video = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).build()
  private val audio = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).build()
  private val sink = RecordingSink()

  private fun sample(byte: Int) = ByteBuffer.wrap(byteArrayOf(byte.toByte()))

  @Test
  fun samplesWaitUntilEveryTrackHasItsFormat() {
    val gate = SampleGate(audio = true, sink = sink)
    gate.onFormat(TrackKind.VIDEO, video)
    gate.onSample(TrackKind.AUDIO, sample(9), 990, SAMPLE_FLAG_KEY_FRAME)
    gate.onSample(TrackKind.VIDEO, sample(1), 1_000, SAMPLE_FLAG_KEY_FRAME)
    gate.onSample(TrackKind.VIDEO, sample(2), 1_033, 0)
    assertEquals(emptyList<String>(), sink.log)

    gate.onFormat(TrackKind.AUDIO, audio)
    gate.onSample(TrackKind.AUDIO, sample(3), 1_010, SAMPLE_FLAG_KEY_FRAME)

    assertEquals(
      listOf(
        "track video/avc",
        "track audio/mp4a-latm",
        "video 1 @0 key",
        "video 2 @33",
        "audio 3 @10 key",
      ),
      sink.log,
    )
  }

  @Test
  fun theFileStartsAtTheFirstVideoKeyframeAndDropsEverythingBefore() {
    val gate = SampleGate(audio = true, sink = sink)
    gate.onFormat(TrackKind.VIDEO, video)
    gate.onFormat(TrackKind.AUDIO, audio)

    gate.onSample(TrackKind.AUDIO, sample(1), 900, SAMPLE_FLAG_KEY_FRAME)
    gate.onSample(TrackKind.VIDEO, sample(2), 950, 0)
    gate.onSample(TrackKind.VIDEO, sample(3), 1_000, SAMPLE_FLAG_KEY_FRAME)
    gate.onSample(TrackKind.AUDIO, sample(4), 990, SAMPLE_FLAG_KEY_FRAME)
    gate.onSample(TrackKind.AUDIO, sample(5), 1_020, SAMPLE_FLAG_KEY_FRAME)

    assertEquals(
      listOf("track video/avc", "track audio/mp4a-latm", "video 3 @0 key", "audio 5 @20 key"),
      sink.log,
    )
  }

  // The muxer starts every track at 0, so both must begin together for A/V sync.
  @Test
  fun withAudioTheFileStartsAtTheFirstVideoKeyframeOnceAudioHasBegun() {
    val gate = SampleGate(audio = true, sink = sink)
    gate.onFormat(TrackKind.VIDEO, video)
    gate.onFormat(TrackKind.AUDIO, audio)

    gate.onSample(TrackKind.VIDEO, sample(1), 1_000, SAMPLE_FLAG_KEY_FRAME)
    gate.onSample(TrackKind.VIDEO, sample(2), 1_033, 0)
    gate.onSample(TrackKind.AUDIO, sample(3), 1_040, SAMPLE_FLAG_KEY_FRAME)
    gate.onSample(TrackKind.VIDEO, sample(4), 1_066, SAMPLE_FLAG_KEY_FRAME)
    gate.onSample(TrackKind.AUDIO, sample(5), 1_063, SAMPLE_FLAG_KEY_FRAME)
    gate.onSample(TrackKind.AUDIO, sample(6), 1_086, SAMPLE_FLAG_KEY_FRAME)

    assertEquals(
      listOf("track video/avc", "track audio/mp4a-latm", "video 4 @0 key", "audio 6 @20 key"),
      sink.log,
    )
  }

  @Test
  fun withoutAudioOnlyTheVideoTrackIsWritten() {
    val gate = SampleGate(audio = false, sink = sink)
    gate.onFormat(TrackKind.VIDEO, video)
    gate.onSample(TrackKind.VIDEO, sample(1), 5_000, SAMPLE_FLAG_KEY_FRAME)

    assertEquals(listOf("track video/avc", "video 1 @0 key"), sink.log)
  }

  @Test
  fun heldSamplesAreCopiedSoEncoderBuffersCanBeReused() {
    val gate = SampleGate(audio = true, sink = sink)
    gate.onFormat(TrackKind.VIDEO, video)
    gate.onSample(TrackKind.AUDIO, sample(1), 0, SAMPLE_FLAG_KEY_FRAME)
    val buffer = sample(7)
    gate.onSample(TrackKind.VIDEO, buffer, 0, SAMPLE_FLAG_KEY_FRAME)
    buffer.clear()
    buffer.put(0, 9)

    gate.onFormat(TrackKind.AUDIO, audio)

    assertEquals("video 7 @0 key", sink.log.last())
  }

  private class RecordingSink : SampleSink {
    val log = mutableListOf<String>()
    private val kinds = mutableListOf<String>()

    override fun addTrack(format: Format): Int {
      log += "track ${format.sampleMimeType}"
      kinds += if (MimeTypes.isVideo(format.sampleMimeType)) "video" else "audio"
      return kinds.size - 1
    }

    override fun writeSample(track: Int, data: ByteBuffer, presentationTimeUs: Long, flags: Int) {
      val key = if (flags and SAMPLE_FLAG_KEY_FRAME != 0) " key" else ""
      log += "${kinds[track]} ${data.get(data.position())} @$presentationTimeUs$key"
    }
  }
}
