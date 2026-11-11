package com.thivatm.rncamera.recording

import android.graphics.Color
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.view.Surface
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.thivatm.rncamera.camera.VideoCodec
import com.thivatm.rncamera.camera.VideoResolution
import com.thivatm.rncamera.camera.VideoSettings
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.sin

/** Real MediaCodec encoders and Media3 muxer, fed synthetic camera frames and PCM. */
@RunWith(AndroidJUnit4::class)
class MediaCodecCaptureTest {
  @get:Rule val tmp = TemporaryFolder()

  private val main = Handler(Looper.getMainLooper())

  private fun record(
    seconds: Int,
    audio: Boolean,
    codec: VideoCodec = VideoCodec.H264,
    micStartDelayMs: Long = 0,
  ): Result {
    val file = File(tmp.root, "rec.mp4")
    val frames = SyntheticFrames(width = 1280, height = 720)
    val capture = MediaCodecCapture(frames, { SyntheticPcm(micStartDelayMs) }, main)
    val result = Result(file)
    val finished = CountDownLatch(1)
    val events = object : CaptureEvents {
      override fun onFragmentWritten(fileSize: Long) {
        assertEquals(Looper.getMainLooper(), Looper.myLooper())
        result.growth += fileSize
        result.snapshots += file.readBytes().copyOf(fileSize.toInt())
      }

      override fun onInterrupted() {
        result.interrupted = true
      }

      override fun onFinished(fileSize: Long) {
        result.finalSize = fileSize
        finished.countDown()
      }
    }
    main.post { capture.start(file, CaptureConfig(VideoSettings(codec = codec, resolution = VideoResolution.HD_720P), audio), events) }
    SystemClock.sleep(seconds * 1000L)
    main.post { capture.stop() }
    // Well under the stop timeout: the file is finished as soon as the last frame is in.
    assertTrue("capture finished promptly", finished.await(1_000, TimeUnit.MILLISECONDS))
    assertTrue("frame source stopped", frames.stopped)
    return result
  }

  private class Result(val file: File) {
    val growth = mutableListOf<Long>()
    val snapshots = mutableListOf<ByteArray>()
    var interrupted = false
    var finalSize = -1L
  }

  @Test
  fun recordsAFragmentedMp4WithAFragmentAboutEveryTwoSeconds() {
    val r = record(seconds = 7, audio = true)

    val boxes = topLevelBoxes(r.file.readBytes())
    assertEquals(listOf("ftyp", "moov"), boxes.take(2))
    val fragments = boxes.drop(2)
    assertEquals(fragments.chunked(2).map { listOf("moof", "mdat") }, fragments.chunked(2))
    // 7 s at a 2 s keyframe interval: 3 or 4 Fragments.
    assertTrue("got ${fragments.size / 2} fragments", fragments.size / 2 in 3..4)
    assertEquals(r.file.length(), r.finalSize)
    assertEquals(false, r.interrupted)
  }

  @Test
  fun theFileOnlyGrows() {
    val r = record(seconds = 7, audio = true)

    val final = r.file.readBytes()
    assertTrue(r.growth.size >= 3)
    assertEquals(r.growth, r.growth.sorted().distinct())
    for (snapshot in r.snapshots) {
      assertArrayEquals(snapshot, final.copyOf(snapshot.size))
    }
  }

  @Test
  fun withoutAudioOnlyAVideoTrackIsRecorded() {
    val r = record(seconds = 3, audio = false)

    val bytes = r.file.readBytes()
    assertTrue(String(bytes, Charsets.ISO_8859_1).contains("avc1"))
    assertTrue(!String(bytes, Charsets.ISO_8859_1).contains("mp4a"))
  }

  @Test
  fun audioAndVideoLineUpEvenWhenTheMicrophoneStartsLate() {
    val r = record(seconds = 5, audio = true, micStartDelayMs = 700)

    val ends = lastSampleTimesUs(r.file)
    val video = ends.getValue("video")
    val audio = ends.getValue("audio")
    assertTrue("video ends at $video us, audio at $audio us", kotlin.math.abs(video - audio) < 100_000)
    // Recording starts with the microphone; not up to 2 s later at the next regular keyframe.
    assertTrue("video ends at $video us", video > 3_700_000)
  }

  @Test
  fun hevcIsSupported() {
    val r = record(seconds = 3, audio = true, codec = VideoCodec.HEVC)

    assertTrue(String(r.file.readBytes(), Charsets.ISO_8859_1).contains("hvc1"))
  }
}

/** Last sample time per track type, via the platform demuxer. */
private fun lastSampleTimesUs(file: File): Map<String, Long> {
  val extractor = MediaExtractor()
  extractor.setDataSource(file.path)
  val ends = mutableMapOf<String, Long>()
  for (i in 0 until extractor.trackCount) extractor.selectTrack(i)
  while (true) {
    val track = extractor.sampleTrackIndex
    if (track < 0) break
    val mime = extractor.getTrackFormat(track).getString(MediaFormat.KEY_MIME)!!
    ends[mime.substringBefore('/')] = maxOf(ends[mime.substringBefore('/')] ?: 0, extractor.sampleTime)
    extractor.advance()
  }
  extractor.release()
  return ends
}

/** Draws a changing colour into the encoder's Surface at 30 fps. */
private class SyntheticFrames(val width: Int, val height: Int) : VideoFrameSource {
  @Volatile var stopped = false
  private val thread = HandlerThread("frames").also { it.start() }
  private val handler = Handler(thread.looper)

  override fun start(request: VideoSourceRequest, listener: VideoFrameListener) {
    listener.onSurfaceRequested(width, height, rotationDegrees = 90, realtimeTimestamps = false) { surface ->
      handler.post { draw(surface, 0) }
    }
  }

  private fun draw(surface: Surface, frame: Int) {
    if (stopped) return
    try {
      val canvas = surface.lockHardwareCanvas()
      canvas.drawColor(Color.rgb(frame * 7 % 255, frame * 3 % 255, 128))
      surface.unlockCanvasAndPost(canvas)
    } catch (_: Exception) {
      return
    }
    handler.postDelayed({ draw(surface, frame + 1) }, 33)
  }

  override fun stop() {
    stopped = true
    thread.quitSafely()
  }
}

/** A 440 Hz tone, delivered at the pace of the wall clock like a microphone. */
private class SyntheticPcm(private val startDelayMs: Long) : PcmSource {
  override val sampleRate = 44_100
  override val channelCount = 1
  private var t = 0L
  private var startNs = 0L

  override fun start(onSilenced: () -> Unit) {
    SystemClock.sleep(startDelayMs)
    startNs = System.nanoTime()
  }

  override fun read(buffer: ByteBuffer, size: Int): Int {
    val samples = size / 2
    val dueNs = startNs + (t + samples) * 1_000_000_000L / sampleRate
    val waitMs = (dueNs - System.nanoTime()) / 1_000_000
    if (waitMs > 0) SystemClock.sleep(waitMs)
    repeat(samples) {
      val v = (sin(2 * Math.PI * 440 * t++ / sampleRate) * 8000).toInt()
      buffer.put((v and 0xff).toByte())
      buffer.put((v shr 8).toByte())
    }
    return samples * 2
  }

  override fun stop() {}
}
