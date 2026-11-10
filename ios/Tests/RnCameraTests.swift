import XCTest
import RnCamera

/// Harness check: the Swift layer of the pod links into an XCTest bundle.
/// Feature tickets add their own test files next to this one.
final class RnCameraTests: XCTestCase {
  func testSwiftTypesAreReachable() {
    XCTAssertNotNil(RecordingUploadsImpl())
    XCTAssertTrue(StreamingCameraHostView(frame: .zero).subviews.isEmpty)
  }
}

/// `RecordingUploadsImpl`: the bridge-facing facade the Turbo Module forwards
/// to. Checks the shapes JS sees (resolved values and rejection codes).
final class RecordingUploadsImplTests: XCTestCase {
  private var dir: URL!
  private var uploads: RecordingUploadsImpl!

  override func setUpWithError() throws {
    dir = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    uploads = RecordingUploadsImpl(
      storeDirectory: dir.appendingPathComponent("store"),
      sessionConfiguration: StubResumableServer.sessionConfiguration())
  }

  override func tearDownWithError() throws {
    uploads.invalidate()
    try? FileManager.default.removeItem(at: dir)
  }

  private func call(
    _ invoke: (@escaping (Any?) -> Void, @escaping (String, String) -> Void) -> Void
  ) -> (value: Any?, code: String?) {
    let done = expectation(description: "promise")
    var outcome: (Any?, String?) = (nil, nil)
    invoke(
      { outcome = ($0, nil); done.fulfill() },
      { code, _ in outcome = (nil, code); done.fulfill() })
    wait(for: [done], timeout: 10)
    return outcome
  }

  func testSendChunkResolvesStatusAndLowerCasedHeaders() throws {
    StubResumableServer.reset { _ in .init(status: 308, headers: ["Range": "bytes=0-9"]) }
    let path = dir.appendingPathComponent("rec.mp4").path
    try Data(count: 10).write(to: URL(fileURLWithPath: path))

    let result = call {
      uploads.sendChunk(
        url: "https://upload.example.test/s", headers: ["X-A": "1"], path: path, start: 0, end: 9,
        contentRange: "bytes 0-9/*", resolve: $0, reject: $1)
    }

    let response = try XCTUnwrap(result.value as? [String: Any])
    XCTAssertEqual(response["status"] as? Int, 308)
    XCTAssertEqual((response["headers"] as? [String: String])?["range"], "bytes=0-9")
    XCTAssertEqual(
      StubResumableServer.received.first?.request.value(forHTTPHeaderField: "X-A"), "1")
  }

  func testMissingFileRejectsWithENOENT() {
    let path = dir.appendingPathComponent("gone.mp4").path
    XCTAssertEqual(call { uploads.getFileSize(path: path, resolve: $0, reject: $1) }.code, "ENOENT")
  }

  func testReadRangeResolvesBase64() throws {
    let path = dir.appendingPathComponent("rec.mp4").path
    try Data([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]).write(to: URL(fileURLWithPath: path))

    let value = call { uploads.readRange(path: path, start: 4, length: 4, resolve: $0, reject: $1) }
      .value
    XCTAssertEqual(value as? String, "ZnR5cA==")  // "ftyp"
  }

  func testKeyValueStoreRoundTrip() {
    _ = call { uploads.kvSet(key: "k", value: "v", resolve: $0, reject: $1) }
    XCTAssertEqual(call { uploads.kvGet(key: "k", resolve: $0, reject: $1) }.value as? String, "v")
    _ = call { uploads.kvRemove(key: "k", resolve: $0, reject: $1) }
    XCTAssertTrue(call { uploads.kvGet(key: "k", resolve: $0, reject: $1) }.value is NSNull)
  }

  func testGetConnectivityResolvesTheEngineShape() throws {
    let state = try XCTUnwrap(
      call { uploads.getConnectivity(resolve: $0, reject: $1) }.value as? [String: Any])
    XCTAssertNotNil(state["isConnected"] as? Bool)
    XCTAssertNotNil(state["networkType"] as? String)
  }
}
