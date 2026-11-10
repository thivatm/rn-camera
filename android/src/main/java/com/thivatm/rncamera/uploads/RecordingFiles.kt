package com.thivatm.rncamera.uploads

import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.RandomAccessFile

/** File primitives on Recording Files for the shared TS upload engine. */
object RecordingFiles {
  /** Byte length of the file. Throws [FileNotFoundException] if it doesn't exist. */
  fun size(path: String): Long {
    val file = File(path)
    if (!file.isFile) throw FileNotFoundException(path)
    return file.length()
  }

  /** Reads up to [length] bytes from [start]; fewer if the file ends first. For small reads (MP4 box headers). */
  fun readRange(path: String, start: Long, length: Int): ByteArray =
    RandomAccessFile(path, "r").use { raf ->
      val available = (raf.length() - start).coerceIn(0, length.toLong()).toInt()
      val bytes = ByteArray(available)
      raf.seek(start)
      raf.readFully(bytes)
      bytes
    }

  /** Cuts the file down to its first [length] bytes (e.g. to the last complete Fragment). */
  fun truncate(path: String, length: Long) {
    RandomAccessFile(path, "rw").use { raf ->
      raf.channel.truncate(length)
      raf.fd.sync()
    }
  }

  /** Deletes the file; a missing file is not an error. */
  fun delete(path: String) {
    val file = File(path)
    if (file.exists() && !file.delete()) throw IOException("Could not delete $path")
  }

  /** Bytes available to the app on the volume holding [dir]. */
  fun freeDiskSpace(dir: File): Long = dir.usableSpace
}
