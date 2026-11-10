import XCTest
import RnCamera

/// App-private key/value store for persisted upload state (spec §6).
final class KeyValueStoreTests: XCTestCase {
  private var dir: URL!

  override func setUpWithError() throws {
    dir = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: dir)
  }

  func testSetThenGetSurvivesANewStoreOnTheSameDirectory() throws {
    try KeyValueStore(directory: dir).set("recording:1", value: #"{"headers":{"a":"b"}}"#)

    XCTAssertEqual(
      try KeyValueStore(directory: dir).get("recording:1"), #"{"headers":{"a":"b"}}"#)
  }

  func testGetOfAnUnknownKeyIsNil() throws {
    XCTAssertNil(try KeyValueStore(directory: dir).get("nope"))
  }

  func testSetOverwritesAndRemoveDeletes() throws {
    let store = KeyValueStore(directory: dir)
    try store.set("k", value: "1")
    try store.set("k", value: "2")
    XCTAssertEqual(try store.get("k"), "2")

    try store.remove("k")
    XCTAssertNil(try store.get("k"))
    XCTAssertNoThrow(try store.remove("k"))
  }

  func testKeysCannotEscapeTheStoreDirectory() throws {
    let store = KeyValueStore(directory: dir.appendingPathComponent("store"))
    try store.set("../escaped", value: "x")
    try store.set("a/b", value: "y")

    XCTAssertEqual(try store.get("../escaped"), "x")
    XCTAssertEqual(try store.get("a/b"), "y")
    XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("escaped").path))
  }

  func testValuesAreExcludedFromBackup() throws {
    let store = KeyValueStore(directory: dir)
    try store.set("k", value: "secret")

    let values = try dir.resourceValues(forKeys: [.isExcludedFromBackupKey])
    XCTAssertEqual(values.isExcludedFromBackup, true)
  }
}
