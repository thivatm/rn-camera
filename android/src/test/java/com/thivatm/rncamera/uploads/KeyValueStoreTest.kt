package com.thivatm.rncamera.uploads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class KeyValueStoreTest {
  @get:Rule val tmp = TemporaryFolder()

  @Test
  fun setValuesSurviveANewStoreOnTheSameDirectory() {
    val dir = tmp.newFolder("kv")
    KeyValueStore(dir).set("recording:abc", """{"headers":{"Authorization":"Bearer x"}}""")

    assertEquals(
      """{"headers":{"Authorization":"Bearer x"}}""",
      KeyValueStore(dir).get("recording:abc"),
    )
  }

  @Test
  fun missingKeyIsNull() {
    assertNull(KeyValueStore(tmp.newFolder("kv")).get("nope"))
  }

  @Test
  fun setOverwritesAndRemoveDeletes() {
    val store = KeyValueStore(tmp.newFolder("kv"))
    store.set("k", "one")
    store.set("k", "two")
    assertEquals("two", store.get("k"))

    store.remove("k")
    store.remove("k")
    assertNull(store.get("k"))
  }

  @Test
  fun keysCannotEscapeTheStoreDirectory() {
    val dir = tmp.newFolder("kv")
    val store = KeyValueStore(dir)

    store.set("../escaped", "v")

    assertEquals("v", store.get("../escaped"))
    assertTrue(tmp.root.listFiles()!!.all { it == dir })
  }
}
