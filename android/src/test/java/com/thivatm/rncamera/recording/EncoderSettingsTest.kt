package com.thivatm.rncamera.recording

import com.thivatm.rncamera.camera.VideoCodec
import com.thivatm.rncamera.camera.VideoResolution
import com.thivatm.rncamera.camera.VideoSettings
import org.junit.Assert.assertEquals
import org.junit.Test

class EncoderSettingsTest {
  @Test
  fun explicitSettingsAreUsedAsGiven() {
    val s = EncoderSettings.of(VideoSettings(codec = VideoCodec.HEVC, resolution = VideoResolution.HD_720P, fps = 24, bitrate = 2_000_000))

    assertEquals(EncoderSettings("video/hevc", 24, 2_000_000), s)
  }

  @Test
  // Same defaults as iOS (ticket 13).
  fun defaultsAre30FpsAnd6MbpsAt1080pOr3MbpsAt720p() {
    assertEquals(EncoderSettings("video/avc", 30, 6_000_000), EncoderSettings.of(VideoSettings()))
    assertEquals(3_000_000, EncoderSettings.of(VideoSettings(resolution = VideoResolution.HD_720P)).bitrate)
    assertEquals(6_000_000, EncoderSettings.of(VideoSettings(codec = VideoCodec.HEVC)).bitrate)
  }

  @Test
  fun keyframesEveryTwoSecondsAndNoBFrames() {
    val s = EncoderSettings.of(VideoSettings())

    assertEquals(2, s.keyframeIntervalSeconds)
    assertEquals(0, s.maxBFrames)
  }
}
