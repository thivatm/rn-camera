import Foundation

/// Swift implementation behind the `RecordingUploads` Turbo Module: native
/// transport, file primitives and signals for the shared TS upload engine
/// (see `src/specs/NativeRecordingUploads.ts`). Blocking file and store work
/// runs on a serial queue; Chunks run on their own `URLSession`. Rejection
/// codes: `ENOENT` (file missing), `ECANCELLED` (Chunk cancelled), `ENETWORK`
/// (network error), `EIO` (anything else).
@objc(RecordingUploadsImpl)
public final class RecordingUploadsImpl: NSObject {
  public typealias Resolve = (Any?) -> Void
  public typealias Reject = (_ code: String, _ message: String) -> Void

  private let transport: ChunkTransport
  private let store: KeyValueStore
  private let io = DispatchQueue(label: "rn-camera.uploads-io")
  private lazy var connectivity = ConnectivityMonitor { [weak self] state in
    self?.onConnectivityChange?(state.dictionary as NSDictionary)
  }

  /// Called with `{ isConnected, networkType }` whenever connectivity changes.
  @objc public var onConnectivityChange: ((NSDictionary) -> Void)?

  @objc public override convenience init() {
    self.init(storeDirectory: KeyValueStore.defaultDirectory(), sessionConfiguration: .default)
  }

  public init(storeDirectory: URL, sessionConfiguration: URLSessionConfiguration) {
    transport = ChunkTransport(configuration: sessionConfiguration)
    store = KeyValueStore(directory: storeDirectory)
    super.init()
    connectivity.start()
  }

  @objc public func invalidate() {
    connectivity.stop()
    transport.invalidate()
  }

  // MARK: File transport

  @objc(sendChunkWithUrl:headers:path:start:end:contentRange:resolve:reject:)
  public func sendChunk(
    url: String, headers: [String: Any]?, path: String, start: Double, end: Double,
    contentRange: String, resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    let request = ChunkRequest(
      url: url, headers: (headers ?? [:]).compactMapValues { $0 as? String }, path: path,
      start: Int64(start), end: Int64(end), contentRange: contentRange)
    transport.send(request) { result in
      switch result {
      case .success(let response):
        resolve(["status": response.status, "headers": response.headers] as NSDictionary)
      case .failure(let error):
        Self.reject(reject, error)
      }
    }
  }

  @objc(cancelChunkWithUrl:)
  public func cancelChunk(url: String) {
    transport.cancel(url: url)
  }

  // MARK: File and storage primitives

  @objc(getFileSizeWithPath:resolve:reject:)
  public func getFileSize(path: String, resolve: @escaping Resolve, reject: @escaping Reject) {
    onIo(resolve, reject) { NSNumber(value: try RecordingFiles.size(path: path)) }
  }

  @objc(readRangeWithPath:start:length:resolve:reject:)
  public func readRange(
    path: String, start: Double, length: Double, resolve: @escaping Resolve,
    reject: @escaping Reject
  ) {
    onIo(resolve, reject) {
      try RecordingFiles.readRange(path: path, start: Int64(start), length: Int(length))
        .base64EncodedString()
    }
  }

  @objc(truncateWithPath:length:resolve:reject:)
  public func truncate(
    path: String, length: Double, resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    onIo(resolve, reject) {
      try RecordingFiles.truncate(path: path, length: Int64(length))
      return NSNull()
    }
  }

  @objc(deleteFileWithPath:resolve:reject:)
  public func deleteFile(path: String, resolve: @escaping Resolve, reject: @escaping Reject) {
    onIo(resolve, reject) {
      try RecordingFiles.delete(path: path)
      return NSNull()
    }
  }

  @objc(getFreeDiskSpaceWithResolve:reject:)
  public func getFreeDiskSpace(resolve: @escaping Resolve, reject: @escaping Reject) {
    onIo(resolve, reject) {
      // The app container's volume, which holds Application Support (Recording Files).
      NSNumber(
        value: try RecordingFiles.freeDiskSpace(in: URL(fileURLWithPath: NSHomeDirectory())))
    }
  }

  @objc(kvGetWithKey:resolve:reject:)
  public func kvGet(key: String, resolve: @escaping Resolve, reject: @escaping Reject) {
    onIo(resolve, reject) { (try self.store.get(key)).map { $0 as Any } ?? NSNull() }
  }

  @objc(kvSetWithKey:value:resolve:reject:)
  public func kvSet(
    key: String, value: String, resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    onIo(resolve, reject) {
      try self.store.set(key, value: value)
      return NSNull()
    }
  }

  @objc(kvRemoveWithKey:resolve:reject:)
  public func kvRemove(key: String, resolve: @escaping Resolve, reject: @escaping Reject) {
    onIo(resolve, reject) {
      try self.store.remove(key)
      return NSNull()
    }
  }

  // MARK: Signals

  @objc(getConnectivityWithResolve:reject:)
  public func getConnectivity(resolve: @escaping Resolve, reject: @escaping Reject) {
    resolve(connectivity.current().dictionary as NSDictionary)
  }

  // MARK: Helpers

  private func onIo(_ resolve: @escaping Resolve, _ reject: @escaping Reject, _ work: @escaping () throws -> Any) {
    io.async {
      do {
        resolve(try work())
      } catch {
        Self.reject(reject, error)
      }
    }
  }

  private static func reject(_ reject: Reject, _ error: Error) {
    let error = error as? RecordingUploadsError ?? .io(error.localizedDescription)
    reject(error.code, error.message)
  }
}
