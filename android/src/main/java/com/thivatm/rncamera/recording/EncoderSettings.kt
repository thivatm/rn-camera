package com.thivatm.rncamera.recording

import com.thivatm.rncamera.camera.VideoSettings

/** Video encoder parameters resolved from the `video` prop. */
data class EncoderSettings(
  val mimeType: String,
  val fps: Int,
  val bitrate: Int,
) {
  /** Spec §4: a Fragment (and so a keyframe) about every 2 s. */
  val keyframeIntervalSeconds = 2

  /** B-frames give non-monotonic DTS in the muxer (ticket 01). */
  val maxBFrames = 0

  companion object {
    fun of(video: VideoSettings): EncoderSettings {
      val hevc = video.codec == "hevc"
      val hd = video.resolution == "720p"
      val defaultBitrate = when {
        hevc && hd -> 2_500_000
        hevc -> 5_000_000
        hd -> 4_000_000
        else -> 8_000_000
      }
      return EncoderSettings(
        mimeType = if (hevc) "video/hevc" else "video/avc",
        fps = video.fps.takeIf { it > 0 } ?: 30,
        bitrate = video.bitrate.takeIf { it > 0 } ?: defaultBitrate,
      )
    }
  }
}
