package com.thivatm.rncamera.uploads

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ChunkTransportTest {
  @get:Rule val tmp = TemporaryFolder()

  private val server = MockWebServer()
  private val transport = ChunkTransport(OkHttpClient())

  @Before fun start() = server.start()

  @After fun stop() = server.shutdown()

  private fun recordingFile(size: Int): java.io.File {
    val bytes = ByteArray(size) { (it % 251).toByte() }
    return tmp.newFile("recording.mp4").apply { writeBytes(bytes) }
  }

  @Test
  fun sendsExactlyTheRequestedInclusiveByteRangeWithProtocolHeaders() {
    val file = recordingFile(1000)
    server.enqueue(MockResponse().setResponseCode(308).addHeader("Range", "bytes=0-299"))

    val response = transport.send(
      ChunkRequest(
        url = server.url("/upload").toString(),
        headers = mapOf("Authorization" to "Bearer secret"),
        path = file.path,
        start = 100,
        end = 299,
        contentRange = "bytes 100-299/*",
      ),
    )

    val recorded = server.takeRequest()
    assertEquals("PUT", recorded.method)
    assertEquals("Bearer secret", recorded.getHeader("Authorization"))
    assertEquals("200", recorded.getHeader("Content-Length"))
    assertEquals("bytes 100-299/*", recorded.getHeader("Content-Range"))
    assertArrayEquals(file.readBytes().copyOfRange(100, 300), recorded.body.readByteArray())

    assertEquals(308, response.status)
    assertEquals("bytes=0-299", response.headers["range"])
  }

  @Test
  fun emptyRangeSendsAnEmptyStatusQuery() {
    val file = recordingFile(10)
    server.enqueue(MockResponse().setResponseCode(308))

    val response = transport.send(
      ChunkRequest(
        url = server.url("/upload").toString(),
        headers = emptyMap(),
        path = file.path,
        start = 0,
        end = -1,
        contentRange = "bytes */*",
      ),
    )

    val recorded = server.takeRequest()
    assertEquals("PUT", recorded.method)
    assertEquals("0", recorded.getHeader("Content-Length"))
    assertEquals("bytes */*", recorded.getHeader("Content-Range"))
    assertEquals(0L, recorded.bodySize)
    assertEquals(308, response.status)
    assertEquals(null, response.headers["range"])
  }

  @Test
  fun finalChunkReturnsCompletionStatus() {
    val file = recordingFile(1000)
    server.enqueue(MockResponse().setResponseCode(201))

    val response = transport.send(
      ChunkRequest(
        url = server.url("/upload").toString(),
        headers = emptyMap(),
        path = file.path,
        start = 512,
        end = 999,
        contentRange = "bytes 512-999/1000",
      ),
    )

    val recorded = server.takeRequest()
    assertEquals("bytes 512-999/1000", recorded.getHeader("Content-Range"))
    assertArrayEquals(file.readBytes().copyOfRange(512, 1000), recorded.body.readByteArray())
    assertEquals(201, response.status)
  }

  @Test
  fun cancelAbortsTheInFlightChunkForThatUrl() {
    val file = recordingFile(1000)
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
    val url = server.url("/upload").toString()

    val failure = AtomicReference<Throwable?>()
    val sender = thread {
      try {
        transport.send(ChunkRequest(url, emptyMap(), file.path, 0, 999, "bytes 0-999/*"))
      } catch (t: Throwable) {
        failure.set(t)
      }
    }
    server.takeRequest()

    transport.cancel(url)
    sender.join(5_000)

    assertFalse("send() should return once cancelled", sender.isAlive)
    assertTrue(failure.get() is ChunkCancelledException)
  }
  @Test
  fun aRecordingFileShorterThanTheRangeFailsWithEIONotENETWORK() {
    val file = recordingFile(100)
    server.enqueue(MockResponse().setResponseCode(308))

    val failure = runCatching {
      transport.send(
        ChunkRequest(server.url("/upload").toString(), emptyMap(), file.path, 0, 999, "bytes 0-999/*"),
      )
    }.exceptionOrNull()

    assertTrue("send() should fail", failure != null)
    assertEquals("EIO", rejectionCode(failure!!, ioCode = "ENETWORK"))
  }

  @Test
  fun aMissingRecordingFileFailsWithENOENT() {
    server.enqueue(MockResponse().setResponseCode(308))

    val failure = runCatching {
      transport.send(
        ChunkRequest(server.url("/upload").toString(), emptyMap(), tmp.root.path + "/gone.mp4", 0, 9, "bytes 0-9/*"),
      )
    }.exceptionOrNull()

    assertEquals("ENOENT", rejectionCode(failure!!, ioCode = "ENETWORK"))
  }
}
