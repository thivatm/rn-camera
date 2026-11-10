import Foundation

/// App-private key/value store for the upload engine's persisted state
/// (spec §6). One file per key under `directory` (inside Application Support,
/// not `UserDefaults`, since values may hold Upload Target headers with
/// credentials). The directory is excluded from backup. Writes are atomic: a
/// crash leaves either the old or the new value.
public final class KeyValueStore {
  private let directory: URL
  private let lock = NSLock()

  public init(directory: URL) {
    self.directory = directory
  }

  /// `Application Support/rn-camera/uploads-state`.
  public static func defaultDirectory() -> URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("rn-camera/uploads-state", isDirectory: true)
  }

  public func get(_ key: String) throws -> String? {
    lock.lock()
    defer { lock.unlock() }
    let file = fileURL(for: key)
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    let data = try RecordingFiles.io { try Data(contentsOf: file) }
    return String(decoding: data, as: UTF8.self)
  }

  public func set(_ key: String, value: String) throws {
    lock.lock()
    defer { lock.unlock() }
    try RecordingFiles.io {
      try createDirectoryIfNeeded()
      try Data(value.utf8).write(
        to: fileURL(for: key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
  }

  public func remove(_ key: String) throws {
    lock.lock()
    defer { lock.unlock() }
    let file = fileURL(for: key)
    guard FileManager.default.fileExists(atPath: file.path) else { return }
    try RecordingFiles.io { try FileManager.default.removeItem(at: file) }
  }

  private func createDirectoryIfNeeded() throws {
    guard !FileManager.default.fileExists(atPath: directory.path) else { return }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var excluded = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
  }

  /// Hex-encodes the key so any string maps to a safe file name inside the
  /// directory (same scheme as Android).
  private func fileURL(for key: String) -> URL {
    let name = key.utf8.map { String(format: "%02x", $0) }.joined()
    return directory.appendingPathComponent("\(name).kv")
  }
}
