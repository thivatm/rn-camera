package com.thivatm.rncamera.uploads

import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * App-private key/value store for the upload engine's persisted state (spec §6).
 * One file per key under [dir] (inside `filesDir`, not SharedPreferences or
 * cache, since values may hold Upload Target headers with credentials).
 * Writes are atomic: a crash leaves either the old or the new value.
 */
class KeyValueStore(private val dir: File) {
  private val lock = Any()

  fun get(key: String): String? = synchronized(lock) {
    val file = fileFor(key)
    if (file.isFile) file.readText(Charsets.UTF_8) else null
  }

  fun set(key: String, value: String) = synchronized(lock) {
    if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Could not create $dir")
    val target = fileFor(key)
    val temp = File(dir, "${target.name}.tmp")
    FileOutputStream(temp).use { out ->
      out.write(value.toByteArray(Charsets.UTF_8))
      out.fd.sync()
    }
    if (!temp.renameTo(target)) throw IOException("Could not write $key")
  }

  fun remove(key: String) = synchronized(lock) {
    val file = fileFor(key)
    if (file.exists() && !file.delete()) throw IOException("Could not remove $key")
  }

  /** Hex-encodes the key so any string maps to a safe file name inside [dir]. */
  private fun fileFor(key: String): File {
    val name = key.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) }
    return File(dir, "$name.kv")
  }
}
