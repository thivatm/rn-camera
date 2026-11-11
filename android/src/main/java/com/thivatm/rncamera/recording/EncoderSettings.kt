package com.thivatm.rncamera.recording

import com.thivatm.rncamera.camera.VideoCodec
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
      return EncoderSettings(
        mimeType = when (video.codec) {
          VideoCodec.HEVC -> "video/hevc"
          VideoCodec.H264 -> "video/avc"
        },
        fps = video.fps.takeIf { it > 0 } ?: 30,
        bitrate = video.bitrate.takeIf { it > 0 } ?: video.resolution.defaultBitrate,
      )
    }
  }
}
