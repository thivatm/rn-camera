import Foundation
import Network

/// Connectivity signal for the upload engine. `networkType` is one of `wifi`,
/// `cellular`, `other` (e.g. wired Ethernet) or `none`.
public struct ConnectivityState: Equatable {
  public let isConnected: Bool
  public let networkType: String

  public init(isConnected: Bool, networkType: String) {
    self.isConnected = isConnected
    self.networkType = networkType
  }

  public init(isSatisfied: Bool, usesWifi: Bool, usesCellular: Bool) {
    switch (isSatisfied, usesWifi, usesCellular) {
    case (false, _, _): self.init(isConnected: false, networkType: "none")
    case (true, true, _): self.init(isConnected: true, networkType: "wifi")
    case (true, false, true): self.init(isConnected: true, networkType: "cellular")
    default: self.init(isConnected: true, networkType: "other")
    }
  }

  init(path: NWPath) {
    self.init(
      isSatisfied: path.status == .satisfied,
      usesWifi: path.usesInterfaceType(.wifi),
      usesCellular: path.usesInterfaceType(.cellular))
  }

  var dictionary: [String: Any] { ["isConnected": isConnected, "networkType": networkType] }
}

/// Watches the current network path with `NWPathMonitor` and reports
/// `ConnectivityState` changes (deduplicated) to `onChange`.
public final class ConnectivityMonitor {
  private let onChange: (ConnectivityState) -> Void
  private let queue = DispatchQueue(label: "rn-camera.connectivity")
  private var monitor: NWPathMonitor?
  private var last: ConnectivityState?

  public init(onChange: @escaping (ConnectivityState) -> Void) {
    self.onChange = onChange
  }

  public func start() {
    queue.sync {
      guard monitor == nil else { return }
      let monitor = NWPathMonitor()
      monitor.pathUpdateHandler = { [weak self] path in self?.publish(ConnectivityState(path: path)) }
      monitor.start(queue: queue)
      self.monitor = monitor
    }
  }

  public func stop() {
    queue.sync {
      monitor?.cancel()
      monitor = nil
      last = nil
    }
  }

  /// The current state from the monitor's latest path; `none` if not started.
  public func current() -> ConnectivityState {
    queue.sync {
      guard let monitor else { return ConnectivityState(isConnected: false, networkType: "none") }
      return last ?? ConnectivityState(path: monitor.currentPath)
    }
  }

  /// Runs on `queue`.
  private func publish(_ state: ConnectivityState) {
    guard state != last else { return }
    last = state
    onChange(state)
  }
}
