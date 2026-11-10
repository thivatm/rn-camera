import Foundation

/// One Chunk `PUT` (spec §5.1). `start` and `end` are inclusive byte offsets
/// into the Recording File at `path`; `end < start` is an empty range, which
/// sends a status query.
public struct ChunkRequest {
  public let url: String
  public let headers: [String: String]
  public let path: String
  public let start: Int64
  public let end: Int64
  public let contentRange: String

  public init(
    url: String, headers: [String: String], path: String, start: Int64, end: Int64,
    contentRange: String
  ) {
    self.url = url
    self.headers = headers
    self.path = path
    self.start = start
    self.end = end
    self.contentRange = contentRange
  }

  var length: Int64 { end < start ? 0 : end - start + 1 }
}

/// Server reply to a Chunk. Header names are lower-cased.
public struct ChunkResponse {
  public let status: Int
  public let headers: [String: String]
}

/// File transport behind the shared TS upload engine: streams a byte range of
/// the Recording File into an HTTP `PUT` without loading it into memory.
public final class ChunkTransport: NSObject {
  private var session: URLSession!
  private let lock = NSLock()
  /// In-flight tasks by Upload URL (the engine keeps one request in flight per Recording).
  private var inFlight: [String: URLSessionTask] = [:]

  public init(configuration: URLSessionConfiguration = .default) {
    super.init()
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }

  /// Ends the session; in-flight Chunks are cancelled.
  public func invalidate() {
    session.invalidateAndCancel()
  }

  /// Sends `request`; `completion` gets the server's reply, or a
  /// `RecordingUploadsError` (`fileMissing`, `cancelled`, `network`, `io`).
  public func send(
    _ request: ChunkRequest, completion: @escaping (Result<ChunkResponse, Error>) -> Void
  ) {
    guard let url = URL(string: request.url) else {
      return completion(.failure(RecordingUploadsError.io("Invalid Upload URL")))
    }
    var urlRequest = URLRequest(url: url)
    urlRequest.httpMethod = "PUT"
    urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
    for (name, value) in request.headers {
      urlRequest.setValue(value, forHTTPHeaderField: name)
    }
    urlRequest.setValue(request.contentRange, forHTTPHeaderField: "Content-Range")
    urlRequest.setValue(String(request.length), forHTTPHeaderField: "Content-Length")

    let body: FileRangeStreamer?
    if request.length == 0 {
      urlRequest.httpBody = Data()
      body = nil
    } else {
      do {
        body = try FileRangeStreamer(path: request.path, start: request.start, length: request.length)
      } catch {
        return completion(.failure(error))
      }
      urlRequest.httpBodyStream = body!.input
    }

    var task: URLSessionTask!
    task = session.dataTask(with: urlRequest) { [weak self] _, response, error in
      self?.finished(task, url: request.url)
      body?.stop()
      if let error = error as? URLError, error.code == .cancelled {
        return completion(.failure(RecordingUploadsError.cancelled))
      }
      if let error = error {
        return completion(.failure(RecordingUploadsError.network(error.localizedDescription)))
      }
      guard let http = response as? HTTPURLResponse else {
        return completion(.failure(RecordingUploadsError.network("No HTTP response")))
      }
      var headers: [String: String] = [:]
      for (name, value) in http.allHeaderFields {
        if let name = name as? String {
          headers[name.lowercased()] = value as? String ?? "\(value)"
        }
      }
      completion(.success(ChunkResponse(status: http.statusCode, headers: headers)))
    }
    lock.lock()
    inFlight[request.url] = task
    lock.unlock()
    body?.start()
    task.resume()
  }

  /// Cancels the in-flight Chunk to `url`, if any; its `send` fails with `cancelled`.
  public func cancel(url: String) {
    lock.lock()
    let task = inFlight[url]
    lock.unlock()
    task?.cancel()
  }

  private func finished(_ task: URLSessionTask, url: String) {
    lock.lock()
    if inFlight[url] === task { inFlight[url] = nil }
    lock.unlock()
  }
}

extension ChunkTransport: URLSessionTaskDelegate {
  /// A resumable server's `308` means "Resume Incomplete", not a redirect:
  /// never follow it, hand it back to the engine.
  public func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  /// The body stream is single-use; a request that needs resending fails and
  /// the engine retries from the Committed Offset.
  public func urlSession(
    _ session: URLSession, task: URLSessionTask,
    needNewBodyStream completionHandler: @escaping (InputStream?) -> Void
  ) {
    completionHandler(nil)
  }
}

/// Feeds `[start, start + length)` of a file into a bound stream pair from a
/// dedicated thread, 64 KiB at a time, so the Chunk is never fully in memory.
private final class FileRangeStreamer {
  let input: InputStream
  private let output: OutputStream
  private let handle: FileHandle
  private let offset: Int64
  private let length: Int64
  private let stopped = NSLock()
  private var isStopped = false

  private static let bufferSize = 64 * 1024

  init(path: String, start: Int64, length: Int64) throws {
    let size = try RecordingFiles.size(path: path)
    guard start + length <= size else {
      throw RecordingUploadsError.io(
        "Recording File has \(size) bytes, Chunk needs \(start + length)")
    }
    guard let handle = FileHandle(forReadingAtPath: path) else {
      throw RecordingUploadsError.fileMissing(path)
    }
    var input: InputStream?
    var output: OutputStream?
    Stream.getBoundStreams(
      withBufferSize: Self.bufferSize, inputStream: &input, outputStream: &output)
    self.input = input!
    self.output = output!
    self.handle = handle
    self.offset = start
    self.length = length
  }

  func start() {
    let thread = Thread { [self] in pump() }
    thread.name = "rn-camera.chunk-body"
    thread.start()
  }

  func stop() {
    stopped.lock()
    isStopped = true
    stopped.unlock()
  }

  private var shouldStop: Bool {
    stopped.lock()
    defer { stopped.unlock() }
    return isStopped
  }

  private func pump() {
    output.open()
    defer {
      output.close()
      try? handle.close()
    }
    do {
      try handle.seek(toOffset: UInt64(offset))
      var remaining = length
      while remaining > 0, !shouldStop {
        let data = try handle.read(upToCount: Int(min(Int64(Self.bufferSize), remaining))) ?? Data()
        if data.isEmpty { return }
        remaining -= Int64(data.count)
        let ok = data.withUnsafeBytes { raw -> Bool in
          var offset = 0
          let bytes = raw.bindMemory(to: UInt8.self)
          while offset < bytes.count {
            let written = output.write(bytes.baseAddress! + offset, maxLength: bytes.count - offset)
            if written <= 0 { return false }
            offset += written
          }
          return true
        }
        if !ok { return }
      }
    } catch {
      return
    }
  }
}
