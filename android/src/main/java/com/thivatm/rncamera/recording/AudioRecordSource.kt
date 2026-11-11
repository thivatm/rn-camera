package com.thivatm.rncamera.recording

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.os.Build
import java.nio.ByteBuffer

/**
 * Microphone PCM via [AudioRecord]. On API 29+ it reports being silenced,
 * which is how a phone call (or another app taking the microphone) shows up
 * without the phone-state permission.
 */
@SuppressLint("MissingPermission") // The camera view checks it before recording.
class AudioRecordSource(context: Context) : PcmSource {
  override val sampleRate = 44_100 // The only rate every device must support.
  override val channelCount = 1

  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val record = AudioRecord(
    MediaRecorder.AudioSource.CAMCORDER,
    sampleRate,
    AudioFormat.CHANNEL_IN_MONO,
    AudioFormat.ENCODING_PCM_16BIT,
    maxOf(
      AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT),
      8192,
    ) * 2,
  )
  private var callback: AudioManager.AudioRecordingCallback? = null

  override fun start(onSilenced: () -> Unit) {
    check(record.state == AudioRecord.STATE_INITIALIZED) { "The microphone could not be opened" }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val cb = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: List<AudioRecordingConfiguration>) {
          val mine = configs.firstOrNull { it.clientAudioSessionId == record.audioSessionId }
          if (mine?.isClientSilenced == true) onSilenced()
        }
      }
      audioManager.registerAudioRecordingCallback(cb, null)
      callback = cb
    }
    record.startRecording()
  }

  /** Writes from index 0 of [buffer]. */
  override fun read(buffer: ByteBuffer, size: Int): Int = record.read(buffer, size)

  override fun stop() {
    callback?.let(audioManager::unregisterAudioRecordingCallback)
    callback = null
    try {
      record.stop()
    } catch (_: IllegalStateException) {
      // Never started.
    }
    record.release()
  }
}
