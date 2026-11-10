import Foundation

/// Failures of the `RecordingUploads` native primitives. `code` is the promise
/// rejection code JS sees, shared with Android.
public enum RecordingUploadsError: Error, Equatable {
  /// The file does not exist.
  case fileMissing(String)
  /// The Chunk was cancelled with `cancelChunk`.
  case cancelled
  /// The request failed before the server replied.
  case network(String)
  /// Anything else.
  case io(String)

  public var code: String {
    switch self {
    case .fileMissing: return "ENOENT"
    case .cancelled: return "ECANCELLED"
    case .network: return "ENETWORK"
    case .io: return "EIO"
    }
  }

  public var message: String {
    switch self {
    case .fileMissing(let path): return "No such file: \(path)"
    case .cancelled: return "Chunk was cancelled"
    case .network(let message), .io(let message): return message
    }
  }
}
