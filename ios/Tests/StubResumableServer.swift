import Foundation

/// In-process stand-in for a resumable upload server, installed as a
/// `URLProtocol` on the session under test. Records every request (with its
/// body read in full) and answers with whatever `respond` returns.
final class StubResumableServer: URLProtocol {
  struct Received {
    let request: URLRequest
    let body: Data
  }

  struct Reply {
    var status: Int
    var headers: [String: String] = [:]
    /// When set, the stub reports a redirect to this URL instead of replying.
    var redirectTo: URL? = nil
    /// When set, the stub fails the request with this error.
    var error: Error? = nil
    /// Delay before replying, to leave room for cancellation.
    var delay: TimeInterval = 0
  }

  private static let lock = NSLock()
  private static var _received: [Received] = []
  private static var _respond: (Received) -> Reply = { _ in Reply(status: 308) }

  static var received: [Received] {
    lock.lock(); defer { lock.unlock() }
    return _received
  }

  static func reset(respond: @escaping (Received) -> Reply) {
    lock.lock(); defer { lock.unlock() }
    _received = []
    _respond = respond
  }

  static func sessionConfiguration() -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubResumableServer.self]
    return config
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  private var cancelled = false

  override func startLoading() {
    let received = Received(request: request, body: Self.readBody(of: request))
    let reply: Reply
    Self.lock.lock()
    Self._received.append(received)
    reply = Self._respond(received)
    Self.lock.unlock()

    DispatchQueue.global().asyncAfter(deadline: .now() + reply.delay) { [self] in
      guard !cancelled else { return }
      if let error = reply.error {
        client?.urlProtocol(self, didFailWithError: error)
        return
      }
      let response = HTTPURLResponse(
        url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1",
        headerFields: reply.headers)!
      if let target = reply.redirectTo {
        client?.urlProtocol(
          self, wasRedirectedTo: URLRequest(url: target), redirectResponse: response)
      }
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocolDidFinishLoading(self)
    }
  }

  override func stopLoading() { cancelled = true }

  private static func readBody(of request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let n = stream.read(&buffer, maxLength: buffer.count)
      if n <= 0 { break }
      data.append(buffer, count: n)
    }
    return data
  }
}
