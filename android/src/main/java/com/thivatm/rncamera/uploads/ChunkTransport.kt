package com.thivatm.rncamera.uploads

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap
import okhttp3.Call
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink

/**
 * One Chunk `PUT` (spec §5.1). [start] and [end] are inclusive byte offsets
 * into the Recording File at [path]; `end < start` is an empty range, which
 * sends a status query.
 */
data class ChunkRequest(
  val url: String,
  val headers: Map<String, String>,
  val path: String,
  val start: Long,
  val end: Long,
  val contentRange: String,
)

/** Thrown by [ChunkTransport.send] when the Chunk was cancelled with [ChunkTransport.cancel]. */
class ChunkCancelledException(url: String) : IOException("Chunk to $url was cancelled")

/**
 * Thrown by [ChunkTransport.send] when the Recording File holds fewer bytes
 * than the Chunk's range: a file problem (`EIO`), not a network error.
 */
class RecordingFileTooShortException(message: String) : IOException(message)

/** Server reply to a Chunk. Header names are lower-cased. */
data class ChunkResponse(val status: Int, val headers: Map<String, String>)

/**
 * File transport behind the shared TS upload engine: streams a byte range of
 * the Recording File into an HTTP `PUT` without loading it into memory.
 */
class ChunkTransport(private val client: OkHttpClient) {
  /** In-flight calls by Upload URL (the engine keeps one request in flight per Recording). */
  private val inFlight = ConcurrentHashMap<String, Call>()

  /** Sends [request] and blocks until the server replies. Throws `IOException` on network errors. */
  fun send(request: ChunkRequest): ChunkResponse {
    val builder = Request.Builder().url(request.url)
    request.headers.forEach { (name, value) -> builder.header(name, value) }
    builder.header("Content-Range", request.contentRange)
    builder.put(FileRangeBody(File(request.path), request.start, request.end))

    val call = client.newCall(builder.build())
    inFlight[request.url] = call
    try {
      call.execute().use { response ->
        val headers = response.headers.names().associate { it.lowercase() to response.headers[it]!! }
        return ChunkResponse(response.code, headers)
      }
    } catch (e: IOException) {
      if (call.isCanceled()) throw ChunkCancelledException(request.url)
      throw e
    } finally {
      inFlight.remove(request.url, call)
    }
  }

  /** Cancels the in-flight Chunk to [url], if any; its [send] throws [ChunkCancelledException]. */
  fun cancel(url: String) {
    inFlight[url]?.cancel()
  }
}

/** Request body that streams `[start, end]` (inclusive) from [file]. */
private class FileRangeBody(
  private val file: File,
  private val start: Long,
  private val end: Long,
) : RequestBody() {
  override fun contentType(): MediaType? = null

  override fun contentLength(): Long = if (end < start) 0 else end - start + 1

  override fun writeTo(sink: BufferedSink) {
    var remaining = contentLength()
    if (remaining == 0L) return
    RandomAccessFile(file, "r").use { raf ->
      raf.seek(start)
      val buffer = ByteArray(BUFFER_SIZE)
      while (remaining > 0) {
        val read = raf.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
        if (read < 0) throw RecordingFileTooShortException("Recording File ended before byte $end")
        sink.write(buffer, 0, read)
        remaining -= read
      }
    }
  }

  private companion object {
    const val BUFFER_SIZE = 64 * 1024
  }
}
