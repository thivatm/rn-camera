package com.thivatm.rncamera.recording

import com.thivatm.rncamera.camera.VideoSettings
import org.junit.Assert.assertEquals
import org.junit.Test

class EncoderSettingsTest {
  @Test
  fun explicitSettingsAreUsedAsGiven() {
    val s = EncoderSettings.of(VideoSettings(codec = "hevc", resolution = "720p", fps = 24, bitrate = 2_000_000))

    assertEquals(EncoderSettings("video/hevc", 24, 2_000_000), s)
  }

  @Test
  fun defaultsAre30FpsAndABitrateForTheResolutionAndCodec() {
    assertEquals(EncoderSettings("video/avc", 30, 8_000_000), EncoderSettings.of(VideoSettings()))
    assertEquals(4_000_000, EncoderSettings.of(VideoSettings(resolution = "720p")).bitrate)
    assertEquals(5_000_000, EncoderSettings.of(VideoSettings(codec = "hevc")).bitrate)
    assertEquals(2_500_000, EncoderSettings.of(VideoSettings(codec = "hevc", resolution = "720p")).bitrate)
  }

  @Test
  fun keyframesEveryTwoSecondsAndNoBFrames() {
    val s = EncoderSettings.of(VideoSettings())

    assertEquals(2, s.keyframeIntervalSeconds)
    assertEquals(0, s.maxBFrames)
  }
}
