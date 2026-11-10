import Foundation

/// File primitives on Recording Files for the shared TS upload engine.
/// Missing files throw `RecordingUploadsError.fileMissing`; other failures
/// throw `.io`.
public enum RecordingFiles {
  /// Byte length of the file.
  public static func size(path: String) throws -> Int64 {
    try requireFile(path)
    let attributes = try io { try FileManager.default.attributesOfItem(atPath: path) }
    return (attributes[.size] as? NSNumber)?.int64Value ?? 0
  }

  /// Reads up to `length` bytes from `start`; fewer if the file ends first.
  /// For small reads (MP4 box headers).
  public static func readRange(path: String, start: Int64, length: Int) throws -> Data {
    let handle = try open(path, forWriting: false)
    defer { try? handle.close() }
    return try io {
      let size = try handle.seekToEnd()
      guard start >= 0, UInt64(start) < size, length > 0 else { return Data() }
      try handle.seek(toOffset: UInt64(start))
      return try handle.read(upToCount: length) ?? Data()
    }
  }

  /// Cuts the file down to its first `length` bytes (e.g. to the last complete
  /// Fragment) and flushes it to disk.
  public static func truncate(path: String, length: Int64) throws {
    let handle = try open(path, forWriting: true)
    defer { try? handle.close() }
    try io {
      try handle.truncate(atOffset: UInt64(length))
      try handle.synchronize()
    }
  }

  /// Deletes the file; a missing file is not an error.
  public static func delete(path: String) throws {
    guard FileManager.default.fileExists(atPath: path) else { return }
    try io { try FileManager.default.removeItem(atPath: path) }
  }

  /// Bytes available on the volume holding `directory`, counting space the
  /// system can free for important (user-initiated) work.
  public static func freeDiskSpace(in directory: URL) throws -> Int64 {
    let values = try io {
      try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    }
    return values.volumeAvailableCapacityForImportantUsage ?? 0
  }

  private static func requireFile(_ path: String) throws {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
      !isDirectory.boolValue
    else { throw RecordingUploadsError.fileMissing(path) }
  }

  private static func open(_ path: String, forWriting: Bool) throws -> FileHandle {
    try requireFile(path)
    let url = URL(fileURLWithPath: path)
    return try io {
      forWriting ? try FileHandle(forWritingTo: url) : try FileHandle(forReadingFrom: url)
    }
  }

  /// Runs `work`, mapping Foundation errors to `RecordingUploadsError.io`.
  static func io<T>(_ work: () throws -> T) throws -> T {
    do {
      return try work()
    } catch let error as RecordingUploadsError {
      throw error
    } catch {
      throw RecordingUploadsError.io(error.localizedDescription)
    }
  }
}
