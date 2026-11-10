import XCTest
import RnCamera

/// File primitives the TS upload engine uses on Recording Files.
final class RecordingFilesTests: XCTestCase {
  private var dir: URL!
  private var path: String!

  override func setUpWithError() throws {
    dir = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    path = dir.appendingPathComponent("rec.mp4").path
    try Data((0..<1000).map { UInt8($0 % 251) }).write(to: URL(fileURLWithPath: path))
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: dir)
  }

  private func code(of work: () throws -> Void) -> String? {
    do {
      try work()
      return nil
    } catch {
      return (error as? RecordingUploadsError)?.code
    }
  }

  func testSizeOfAFile() throws {
    XCTAssertEqual(try RecordingFiles.size(path: path), 1000)
  }

  func testSizeOfAMissingFileFailsWithFileMissing() {
    XCTAssertEqual(code { _ = try RecordingFiles.size(path: path + ".gone") }, "ENOENT")
  }

  func testReadRangeReadsTheRequestedBytes() throws {
    // An MP4 box header: 8 bytes at an offset.
    let bytes = try RecordingFiles.readRange(path: path, start: 260, length: 8)
    XCTAssertEqual(bytes, Data([9, 10, 11, 12, 13, 14, 15, 16]))
  }

  func testReadRangeStopsAtTheEndOfTheFile() throws {
    XCTAssertEqual(try RecordingFiles.readRange(path: path, start: 996, length: 100).count, 4)
    XCTAssertEqual(try RecordingFiles.readRange(path: path, start: 2000, length: 8), Data())
  }

  func testReadRangeOfAMissingFileFailsWithFileMissing() {
    XCTAssertEqual(
      code { _ = try RecordingFiles.readRange(path: path + ".gone", start: 0, length: 8) }, "ENOENT")
  }

  func testTruncateKeepsTheFirstBytes() throws {
    let original = try Data(contentsOf: URL(fileURLWithPath: path))

    try RecordingFiles.truncate(path: path, length: 600)

    XCTAssertEqual(try RecordingFiles.size(path: path), 600)
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), original.prefix(600))
  }

  func testTruncateOfAMissingFileFailsWithFileMissing() {
    XCTAssertEqual(code { try RecordingFiles.truncate(path: path + ".gone", length: 0) }, "ENOENT")
  }

  func testDeleteRemovesTheFileAndIgnoresAMissingOne() throws {
    try RecordingFiles.delete(path: path)
    XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    XCTAssertNoThrow(try RecordingFiles.delete(path: path))
  }

  func testFreeDiskSpaceIsPositive() throws {
    XCTAssertGreaterThan(try RecordingFiles.freeDiskSpace(in: dir), 0)
  }
}
