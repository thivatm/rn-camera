package com.thivatm.rncamera.uploads

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.thivatm.rncamera.NativeRecordingUploadsSpec
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

/**
 * Turbo Module `RecordingUploads`: native transport, file primitives and
 * signals behind the shared TS upload engine. Blocking work runs off the JS
 * thread. Rejection codes: see [rejectionCode].
 */
class RecordingUploadsModule(reactContext: ReactApplicationContext) :
  NativeRecordingUploadsSpec(reactContext) {

  private val transport = ChunkTransport(
    OkHttpClient.Builder()
      // Chunks are up to 8 MiB on slow links: no overall call timeout.
      .writeTimeout(60, TimeUnit.SECONDS)
      .readTimeout(60, TimeUnit.SECONDS)
      .build(),
  )
  private val store = KeyValueStore(File(reactContext.filesDir, "rn-camera/uploads-state"))
  private val connectivity = ConnectivityMonitor(reactContext) { emitOnConnectivityChange(it.toMap()) }

  /** Chunks get their own threads so a long upload never blocks file or store calls. */
  private val network: ExecutorService = Executors.newCachedThreadPool()
  private val io: ExecutorService = Executors.newSingleThreadExecutor()

  override fun initialize() {
    super.initialize()
    connectivity.start()
  }

  override fun invalidate() {
    connectivity.stop()
    network.shutdownNow()
    io.shutdownNow()
    super.invalidate()
  }

  override fun sendChunk(request: ReadableMap, promise: Promise) {
    val chunk = ChunkRequest(
      url = request.getString("url")!!,
      headers = request.getMap("headers")?.toStringMap() ?: emptyMap(),
      path = request.getString("path")!!,
      start = request.getDouble("start").toLong(),
      end = request.getDouble("end").toLong(),
      contentRange = request.getString("contentRange")!!,
    )
    network.execute {
      try {
        val response = transport.send(chunk)
        promise.resolve(
          Arguments.createMap().apply {
            putInt("status", response.status)
            putMap("headers", Arguments.createMap().apply { response.headers.forEach(::putString) })
          },
        )
      } catch (e: Throwable) {
        reject(promise, e, ioCode = "ENETWORK")
      }
    }
  }

  override fun cancelChunk(url: String) = transport.cancel(url)

  override fun getFileSize(path: String, promise: Promise) =
    onIo(promise) { RecordingFiles.size(path).toDouble() }

  override fun readRange(path: String, start: Double, length: Double, promise: Promise) =
    onIo(promise) {
      Base64.encodeToString(RecordingFiles.readRange(path, start.toLong(), length.toInt()), Base64.NO_WRAP)
    }

  override fun truncate(path: String, length: Double, promise: Promise) =
    onIo(promise) { RecordingFiles.truncate(path, length.toLong()); null }

  override fun deleteFile(path: String, promise: Promise) =
    onIo(promise) { RecordingFiles.delete(path); null }

  override fun getFreeDiskSpace(promise: Promise) =
    onIo(promise) { RecordingFiles.freeDiskSpace(reactApplicationContext.filesDir).toDouble() }

  override fun kvGet(key: String, promise: Promise) = onIo(promise) { store.get(key) }

  override fun kvSet(key: String, value: String, promise: Promise) =
    onIo(promise) { store.set(key, value); null }

  override fun kvRemove(key: String, promise: Promise) = onIo(promise) { store.remove(key); null }

  override fun getConnectivity(promise: Promise) =
    onIo(promise) { connectivity.current().toMap() }

  private fun onIo(promise: Promise, work: () -> Any?) {
    io.execute {
      try {
        promise.resolve(work())
      } catch (e: Throwable) {
        reject(promise, e, ioCode = "EIO")
      }
    }
  }

  private fun reject(promise: Promise, e: Throwable, ioCode: String) =
    promise.reject(rejectionCode(e, ioCode), e.message, e)

  private fun ReadableMap.toStringMap(): Map<String, String> {
    val result = mutableMapOf<String, String>()
    val iterator = keySetIterator()
    while (iterator.hasNextKey()) {
      val key = iterator.nextKey()
      if (getType(key) == ReadableType.String) result[key] = getString(key)!!
    }
    return result
  }

  private fun ConnectivityState.toMap() = Arguments.createMap().apply {
    putBoolean("isConnected", isConnected)
    putString("networkType", networkType)
  }

  companion object {
    const val NAME = NativeRecordingUploadsSpec.NAME
  }
}

/**
 * The promise rejection code JS sees for [e] (shared with iOS): `ENOENT`,
 * `ECANCELLED`, `EIO` for a Recording File that cannot be read, and [ioCode]
 * for any other `IOException` (`ENETWORK` for a Chunk, `EIO` for file and
 * store calls).
 */
internal fun rejectionCode(e: Throwable, ioCode: String): String = when (e) {
  is ChunkCancelledException -> "ECANCELLED"
  is FileNotFoundException -> "ENOENT"
  is RecordingFileTooShortException -> "EIO"
  is IOException -> ioCode
  else -> "EIO"
}
