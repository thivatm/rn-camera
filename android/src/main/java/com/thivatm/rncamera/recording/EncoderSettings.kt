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
      // Same defaults as iOS.
      val defaultBitrate = if (video.resolution == "720p") 3_000_000 else 6_000_000
      return EncoderSettings(
        mimeType = if (hevc) "video/hevc" else "video/avc",
        fps = video.fps.takeIf { it > 0 } ?: 30,
        bitrate = video.bitrate.takeIf { it > 0 } ?: defaultBitrate,
      )
    }
  }
}
