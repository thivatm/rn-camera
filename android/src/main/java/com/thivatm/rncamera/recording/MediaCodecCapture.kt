package com.thivatm.rncamera.recording

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import androidx.media3.common.util.MediaFormatUtil
import com.thivatm.rncamera.camera.VideoResolution
import java.io.File
import java.nio.ByteBuffer

/** What the encoder asks the camera for. */
data class VideoSourceRequest(val resolution: VideoResolution, val fps: Int)

/** Camera frames for the video encoder. Real one: `CameraXSession`. */
interface VideoFrameSource {
  fun start(request: VideoSourceRequest, listener: VideoFrameListener)

  /** Stops sending frames. */
  fun stop()
}

interface VideoFrameListener {
  /**
   * Frames of [width] x [height] will be drawn into the Surface passed to
   * [provide]. [rotationDegrees] turns them upright (fixed for the
   * recording). Frame timestamps are `elapsedRealtimeNanos` when
   * [realtimeTimestamps], else `System.nanoTime`. Any thread.
   */
  fun onSurfaceRequested(
    width: Int,
    height: Int,
    rotationDegrees: Int,
    realtimeTimestamps: Boolean,
    provide: (Surface) -> Unit,
  )

  /** The camera was taken away (another app, a call, an error). Any thread. */
  fun onSourceLost()
}

/** 16-bit PCM from the microphone. Real one: [AudioRecordSource]. */
interface PcmSource {
  val sampleRate: Int
  val channelCount: Int

  /** [onSilenced] runs (any thread) if the system takes the microphone, e.g. for a call. */
  fun start(onSilenced: () -> Unit)

  /** Blocks until up to [size] bytes are read into [buffer] from index 0; returns the count, negative on error. */
  fun read(buffer: ByteBuffer, size: Int): Int

  /** Stops and releases the microphone. */
  fun stop()
}

/**
 * [Capture] on MediaCodec (video from a camera Surface, AAC from PCM) and
 * [FragmentedRecordingFile]. Encoder output and the muxer run on one
 * background thread; [CaptureEvents] are posted to [events thread][eventHandler].
 */
class MediaCodecCapture(
  private val video: VideoFrameSource,
  private val audioSource: () -> PcmSource,
  private val eventHandler: Handler,
) : Capture {
  private var session: Session? = null

  override fun start(file: File, config: CaptureConfig, events: CaptureEvents) {
    check(session == null) { "Capture already running" }
    session = Session(file, config, events).also { it.start() }
  }

  override fun stop() {
    session?.stop()
  }

  private inner class Session(
    private val file: File,
    private val config: CaptureConfig,
    private val events: CaptureEvents,
  ) {
    private val settings = EncoderSettings.of(config.video)
    private val thread = HandlerThread("rn-camera-mux").also { it.start() }
    private val mux = Handler(thread.looper)

    // Owned by the mux thread.
    private lateinit var writer: FragmentedRecordingFile
    private lateinit var gate: SampleGate
    private var videoCodec: MediaCodec? = null
    private var inputSurface: Surface? = null
    private var videoDone = false
    private var audioDone = !config.audio
    private var stopping = false
    private var finished = false
    private var interruptedReported = false
    /** Subtracted from video timestamps to bring them to the `System.nanoTime` clock audio uses. */
    private var videoClockOffsetUs = 0L
    private var keyframeRequested = false
    private var videoStopAtUs = Long.MAX_VALUE

    @Volatile private var audioStopRequested = false
    private var audioThread: Thread? = null

    fun start() {
      mux.post {
        try {
          writer = FragmentedRecordingFile(file) { size -> post { events.onFragmentWritten(size) } }
          gate = SampleGate(config.audio, writer)
        } catch (e: Exception) {
          fail("Could not create the Recording File", e)
          return@post
        }
        // Audio starts first so it is running by the first video keyframe (see SampleGate).
        if (config.audio) startAudio()
      }
      video.start(
        VideoSourceRequest(config.video.resolution, settings.fps),
        object : VideoFrameListener {
          override fun onSurfaceRequested(
            width: Int,
            height: Int,
            rotationDegrees: Int,
            realtimeTimestamps: Boolean,
            provide: (Surface) -> Unit,
          ) {
            mux.post { startVideo(width, height, rotationDegrees, realtimeTimestamps, provide) }
          }

          override fun onSourceLost() = interrupt()
        },
      )
    }

    fun stop() {
      // Video ends at the first encoded frame from now on; the camera keeps
      // feeding frames until the file is finished. No signalEndOfInputStream:
      // after it some encoders (c2.android.*) neither take more frames nor
      // deliver end of stream.
      val stopAtUs = nowUs()
      audioStopRequested = true
      mux.post {
        if (stopping) return@post
        stopping = true
        videoStopAtUs = stopAtUs
        if (videoCodec == null) videoDone = true
        maybeFinish()
        // Don't hang if the camera stopped sending frames.
        mux.postDelayed({ finish() }, STOP_TIMEOUT_MS)
      }
    }

    private fun startVideo(
      width: Int,
      height: Int,
      rotationDegrees: Int,
      realtime: Boolean,
      provide: (Surface) -> Unit,
    ) {
      if (stopping || videoCodec != null || !::writer.isInitialized) return
      if (realtime) {
        videoClockOffsetUs = (SystemClock.elapsedRealtimeNanos() - System.nanoTime()) / 1000
      }
      try {
        val format = MediaFormat.createVideoFormat(settings.mimeType, width, height).apply {
          setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
          setInteger(MediaFormat.KEY_BIT_RATE, settings.bitrate)
          setInteger(MediaFormat.KEY_FRAME_RATE, settings.fps)
          setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, settings.keyframeIntervalSeconds)
          setInteger(KEY_MAX_B_FRAMES, settings.maxBFrames)
        }
        val codec = MediaCodec.createEncoderByType(settings.mimeType)
        codec.setCallback(VideoCallback(), mux)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val surface = codec.createInputSurface()
        codec.start()
        videoCodec = codec
        inputSurface = surface
        writer.setOrientation(rotationDegrees)
        provide(surface)
      } catch (e: Exception) {
        fail("Could not start the video encoder", e)
      }
    }

    private inner class VideoCallback : MediaCodec.Callback() {
      override fun onInputBufferAvailable(codec: MediaCodec, index: Int) = Unit

      override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
        if (finished || videoDone) return
        val ptsUs = info.presentationTimeUs - videoClockOffsetUs
        val ended = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0 || ptsUs >= videoStopAtUs
        try {
          if (!ended && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
            val buffer = codec.getOutputBuffer(index)!!
            buffer.position(info.offset).limit(info.offset + info.size)
            gate.onSample(TrackKind.VIDEO, buffer, ptsUs, keyFlag(info.flags))
          }
          codec.releaseOutputBuffer(index, false)
        } catch (e: Exception) {
          fail("Could not write video", e)
          return
        }
        if (ended) {
          videoDone = true
          maybeFinish()
        }
      }

      override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
        fail("Video encoder error", e)
      }

      override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
        gate.onFormat(TrackKind.VIDEO, MediaFormatUtil.createFormatFromMediaFormat(format))
      }
    }

    /** Microphone → AAC encoder, synchronously on its own thread; samples go to the mux thread. */
    private fun startAudio() {
      audioThread = Thread({
        var codec: MediaCodec? = null
        var pcm: PcmSource? = null
        try {
          pcm = audioSource()
          val format = MediaFormat.createAudioFormat(AUDIO_MIME, pcm.sampleRate, pcm.channelCount).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, AUDIO_BITRATE)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, AUDIO_READ_BYTES * 2)
          }
          codec = MediaCodec.createEncoderByType(AUDIO_MIME)
          codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
          codec.start()
          pcm.start(onSilenced = ::interrupt)
          encodeAudio(pcm, codec)
        } catch (e: Exception) {
          mux.post { fail("Audio capture failed", e) }
        } finally {
          try { pcm?.stop() } catch (_: Exception) {}
          try { codec?.stop() } catch (_: Exception) {}
          codec?.release()
          mux.post {
            audioDone = true
            maybeFinish()
          }
        }
      }, "rn-camera-audio").also { it.start() }
    }

    private fun encodeAudio(pcm: PcmSource, codec: MediaCodec) {
      val bytesPerFrame = 2 * pcm.channelCount
      var framesRead = 0L
      var anchorUs = -1L
      var inputEnded = false
      val info = MediaCodec.BufferInfo()
      while (true) {
        if (!inputEnded) {
          val index = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
          if (index >= 0) {
            val buffer = codec.getInputBuffer(index)!!
            buffer.clear()
            val ptsUs = if (anchorUs < 0) 0 else anchorUs + framesRead * 1_000_000 / pcm.sampleRate
            if (audioStopRequested) {
              codec.queueInputBuffer(index, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputEnded = true
            } else {
              val read = pcm.read(buffer, minOf(AUDIO_READ_BYTES, buffer.capacity()))
              if (read < 0) throw IllegalStateException("Microphone read failed ($read)")
              val frames = read / bytesPerFrame
              if (anchorUs < 0) anchorUs = nowUs() - frames * 1_000_000L / pcm.sampleRate
              val pts = anchorUs + framesRead * 1_000_000 / pcm.sampleRate
              codec.queueInputBuffer(index, 0, read, pts, 0)
              framesRead += frames
            }
          }
        }
        val out = codec.dequeueOutputBuffer(info, if (inputEnded) DEQUEUE_TIMEOUT_US else 0)
        when {
          out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val format = MediaFormatUtil.createFormatFromMediaFormat(codec.outputFormat)
            mux.post { if (!finished) gate.onFormat(TrackKind.AUDIO, format) }
          }
          out >= 0 -> {
            if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
              val buffer = codec.getOutputBuffer(out)!!
              buffer.position(info.offset).limit(info.offset + info.size)
              val copy = ByteBuffer.allocateDirect(info.size).put(buffer)
              copy.flip()
              val pts = info.presentationTimeUs
              val flags = keyFlag(info.flags) or SAMPLE_FLAG_KEY_FRAME
              mux.post {
                if (finished) return@post
                try {
                  gate.onSample(TrackKind.AUDIO, copy, pts, flags)
                  requestKeyframeUntilStarted()
                } catch (e: Exception) {
                  fail("Could not write audio", e)
                }
              }
            }
            codec.releaseOutputBuffer(out, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
          }
        }
      }
    }

    private fun nowUs(): Long = System.nanoTime() / 1000

    /**
     * The file starts at a video keyframe after audio began. If video was
     * already running, ask for one now rather than wait up to 2 s.
     */
    private fun requestKeyframeUntilStarted() {
      if (keyframeRequested || gate.started) return
      val codec = videoCodec ?: return
      keyframeRequested = true
      try {
        codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
      } catch (e: IllegalStateException) {
        Log.w(TAG, "Keyframe request failed", e)
      }
    }

    private fun maybeFinish() {
      if (stopping && videoDone && audioDone) finish()
    }

    /** Mux thread. Closes the file (writing the last Fragment) and reports it. */
    private fun finish() {
      if (finished) return
      finished = true
      audioStopRequested = true
      try {
        if (::writer.isInitialized) writer.close()
      } catch (e: Exception) {
        // No samples yet: the muxer has nothing to close. The file stays as is.
        Log.w(TAG, "Closing the Recording File failed", e)
      }
      val size = file.length()
      post {
        // Detach the camera before the encoder's Surface goes away.
        video.stop()
        session = null
        events.onFinished(size)
        mux.post {
          videoCodec?.let {
            try { it.stop() } catch (_: Exception) {}
            it.release()
          }
          inputSurface?.release()
          thread.quitSafely()
        }
      }
    }

    private fun interrupt() {
      post {
        if (interruptedReported) return@post
        interruptedReported = true
        events.onInterrupted()
      }
    }

    private fun fail(message: String, e: Exception) {
      Log.e(TAG, message, e)
      interrupt()
    }

    private fun post(block: () -> Unit) {
      eventHandler.post(block)
    }
  }

  private companion object {
    const val TAG = "RnCameraCapture"
    const val AUDIO_MIME = "audio/mp4a-latm"
    const val AUDIO_BITRATE = 128_000
    const val AUDIO_READ_BYTES = 4096
    const val DEQUEUE_TIMEOUT_US = 10_000L
    const val STOP_TIMEOUT_MS = 1_500L

    /** `MediaFormat.KEY_MAX_B_FRAMES` (API 29); older encoders ignore it. */
    const val KEY_MAX_B_FRAMES = "max-bframes"

    fun keyFlag(codecFlags: Int) =
      if (codecFlags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0) SAMPLE_FLAG_KEY_FRAME else 0
  }
}
