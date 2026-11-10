import XCTest
import RnCamera

/// `ChunkTransport` (the native side of `sendChunk`) against an in-process
/// stub resumable server (spec §5.1).
final class ChunkTransportTests: XCTestCase {
  private var dir: URL!
  private var transport: ChunkTransport!
  private let uploadURL = "https://upload.example.test/session/abc"

  override func setUpWithError() throws {
    dir = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    transport = ChunkTransport(configuration: StubResumableServer.sessionConfiguration())
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: dir)
  }

  /// A Recording File whose byte at offset i is `i % 251` (prime, so ranges
  /// at different offsets have different contents).
  private func makeRecordingFile(size: Int) throws -> String {
    let url = dir.appendingPathComponent("rec.mp4")
    try Data((0..<size).map { UInt8($0 % 251) }).write(to: url)
    return url.path
  }

  private func fileBytes(_ path: String, _ range: ClosedRange<Int>) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: path))[range]
  }

  private func send(
    path: String, start: Int64, end: Int64, contentRange: String,
    headers: [String: String] = [:]
  ) -> Result<ChunkResponse, Error> {
    let done = expectation(description: "send")
    var result: Result<ChunkResponse, Error>!
    transport.send(
      ChunkRequest(
        url: uploadURL, headers: headers, path: path, start: start, end: end,
        contentRange: contentRange)
    ) {
      result = $0
      done.fulfill()
    }
    wait(for: [done], timeout: 10)
    return result
  }

  func testSendsExactlyTheRequestedBytesAndHeaders() throws {
    StubResumableServer.reset { _ in .init(status: 308, headers: ["Range": "bytes=0-786431"]) }
    let path = try makeRecordingFile(size: 1_000_000)

    let response = try send(
      path: path, start: 262_144, end: 786_431,
      contentRange: "bytes 262144-786431/*",
      headers: ["Authorization": "Bearer secret", "X-Upload-Target": "t1"]
    ).get()

    XCTAssertEqual(StubResumableServer.received.count, 1)
    let received = try XCTUnwrap(StubResumableServer.received.first)
    XCTAssertEqual(received.request.httpMethod, "PUT")
    XCTAssertEqual(received.request.url?.absoluteString, uploadURL)
    XCTAssertEqual(received.request.value(forHTTPHeaderField: "Content-Length"), "524288")
    XCTAssertEqual(
      received.request.value(forHTTPHeaderField: "Content-Range"), "bytes 262144-786431/*")
    XCTAssertEqual(received.request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
    XCTAssertEqual(received.request.value(forHTTPHeaderField: "X-Upload-Target"), "t1")
    XCTAssertEqual(received.body, try fileBytes(path, 262_144...786_431))

    XCTAssertEqual(response.status, 308)
    XCTAssertEqual(response.headers["range"], "bytes=0-786431")
  }

  func testEmptyRangeSendsAStatusQuery() throws {
    StubResumableServer.reset { _ in .init(status: 308) }
    let path = try makeRecordingFile(size: 1000)

    let response = try send(path: path, start: 0, end: -1, contentRange: "bytes */*").get()

    let received = try XCTUnwrap(StubResumableServer.received.first)
    XCTAssertEqual(received.request.httpMethod, "PUT")
    XCTAssertEqual(received.request.value(forHTTPHeaderField: "Content-Length"), "0")
    XCTAssertEqual(received.request.value(forHTTPHeaderField: "Content-Range"), "bytes */*")
    XCTAssertEqual(received.body.count, 0)
    XCTAssertEqual(response.status, 308)
    XCTAssertNil(response.headers["range"])
  }

  func testFinalChunkReturnsCompletion() throws {
    StubResumableServer.reset { _ in .init(status: 201) }
    let path = try makeRecordingFile(size: 1000)

    let response = try send(path: path, start: 512, end: 999, contentRange: "bytes 512-999/1000")
      .get()

    let received = try XCTUnwrap(StubResumableServer.received.first)
    XCTAssertEqual(received.request.value(forHTTPHeaderField: "Content-Range"), "bytes 512-999/1000")
    XCTAssertEqual(received.body, try fileBytes(path, 512...999))
    XCTAssertEqual(response.status, 201)
  }

  func testResumeIncompleteIsReturnedNotFollowedAsARedirect() throws {
    StubResumableServer.reset { received in
      received.request.url?.path == "/elsewhere"
        ? .init(status: 200)
        : .init(
          status: 308, headers: ["Range": "bytes=0-99", "Location": "https://upload.example.test/elsewhere"],
          redirectTo: URL(string: "https://upload.example.test/elsewhere"))
    }
    let path = try makeRecordingFile(size: 1000)

    let response = try send(path: path, start: 0, end: 99, contentRange: "bytes 0-99/*").get()

    XCTAssertEqual(StubResumableServer.received.count, 1)
    XCTAssertEqual(response.status, 308)
    XCTAssertEqual(response.headers["range"], "bytes=0-99")
  }

  func testMissingFileFailsWithFileMissing() {
    StubResumableServer.reset { _ in .init(status: 308) }
    let path = dir.appendingPathComponent("gone.mp4").path

    let result = send(path: path, start: 0, end: 99, contentRange: "bytes 0-99/*")

    XCTAssertEqual(result.failure?.code, "ENOENT")
    XCTAssertTrue(StubResumableServer.received.isEmpty)
  }

  func testNetworkErrorFailsWithNetwork() throws {
    StubResumableServer.reset { _ in .init(status: 0, error: URLError(.networkConnectionLost)) }
    let path = try makeRecordingFile(size: 1000)

    let result = send(path: path, start: 0, end: 99, contentRange: "bytes 0-99/*")

    XCTAssertEqual(result.failure?.code, "ENETWORK")
  }

  func testCancelFailsTheInFlightChunkWithCancelled() throws {
    StubResumableServer.reset { _ in .init(status: 308, delay: 5) }
    let path = try makeRecordingFile(size: 1000)
    let done = expectation(description: "send")
    var result: Result<ChunkResponse, Error>!
    transport.send(
      ChunkRequest(
        url: uploadURL, headers: [:], path: path, start: 0, end: 99,
        contentRange: "bytes 0-99/*")
    ) {
      result = $0
      done.fulfill()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.transport.cancel(url: self.uploadURL) }

    wait(for: [done], timeout: 3)
    XCTAssertEqual(result.failure?.code, "ECANCELLED")
  }
}

extension Result where Failure == Error {
  var failure: RecordingUploadsError? {
    if case .failure(let error) = self { return error as? RecordingUploadsError }
    return nil
  }
}
