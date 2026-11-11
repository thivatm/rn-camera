package com.thivatm.rncamera.recording

import androidx.media3.common.Format
import java.nio.ByteBuffer

enum class TrackKind { VIDEO, AUDIO }

/** Where encoded samples go; [FragmentedRecordingFile] in production. */
interface SampleSink {
  fun addTrack(format: Format): Int
  fun writeSample(track: Int, data: ByteBuffer, presentationTimeUs: Long, flags: Int)
}

/**
 * Sits between the encoders and the muxer. The muxer needs every track
 * before the first sample, so samples are held (copied) until each expected
 * track has its format. The file starts at the first video keyframe at or
 * after the first audio sample: earlier samples are dropped and timestamps
 * are rebased to 0 there. (The Media3 fragmented muxer starts every track at
 * 0, so a track that began later would drift out of sync.)
 * Single-threaded.
 */
class SampleGate(audio: Boolean, private val sink: SampleSink) {
  private val expected = if (audio) listOf(TrackKind.VIDEO, TrackKind.AUDIO) else listOf(TrackKind.VIDEO)
  private val formats = mutableMapOf<TrackKind, Format>()
  private val tracks = mutableMapOf<TrackKind, Int>()
  private val held = mutableListOf<Held>()
  private var startUs: Long? = null
  private var firstAudioUs: Long? = null

  /** Whether the file has started; until then the video encoder should be asked for a keyframe. */
  val started: Boolean get() = startUs != null

  private class Held(val kind: TrackKind, val data: ByteBuffer, val ptsUs: Long, val flags: Int)

  fun onFormat(kind: TrackKind, format: Format) {
    if (kind !in expected || kind in formats) return
    formats[kind] = format
    if (expected.all { it in formats }) {
      for (k in expected) tracks[k] = sink.addTrack(formats.getValue(k))
      held.forEach { write(it.kind, it.data, it.ptsUs, it.flags) }
      held.clear()
    }
  }

  fun onSample(kind: TrackKind, data: ByteBuffer, presentationTimeUs: Long, flags: Int) {
    if (kind !in expected) return
    if (tracks.size < expected.size) {
      val copy = ByteBuffer.allocate(data.remaining()).put(data.duplicate())
      copy.flip()
      held += Held(kind, copy, presentationTimeUs, flags)
    } else {
      write(kind, data, presentationTimeUs, flags)
    }
  }

  private fun write(kind: TrackKind, data: ByteBuffer, ptsUs: Long, flags: Int) {
    if (startUs == null) {
      if (kind == TrackKind.AUDIO && firstAudioUs == null) firstAudioUs = ptsUs
      if (kind != TrackKind.VIDEO || flags and SAMPLE_FLAG_KEY_FRAME == 0) return
      if (TrackKind.AUDIO in expected && ptsUs < (firstAudioUs ?: return)) return
      startUs = ptsUs
    }
    val start = startUs!!
    if (ptsUs < start) return
    sink.writeSample(tracks.getValue(kind), data, ptsUs - start, flags)
  }
}
