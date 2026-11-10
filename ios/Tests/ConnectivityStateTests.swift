import XCTest
import RnCamera

/// Mapping from the current network path to the engine's connectivity signal.
final class ConnectivityStateTests: XCTestCase {
  func testUnsatisfiedPathIsNone() {
    XCTAssertEqual(
      ConnectivityState(isSatisfied: false, usesWifi: true, usesCellular: false),
      ConnectivityState(isConnected: false, networkType: "none"))
  }

  func testWifiWinsOverCellular() {
    XCTAssertEqual(
      ConnectivityState(isSatisfied: true, usesWifi: true, usesCellular: true).networkType, "wifi")
  }

  func testCellular() {
    XCTAssertEqual(
      ConnectivityState(isSatisfied: true, usesWifi: false, usesCellular: true),
      ConnectivityState(isConnected: true, networkType: "cellular"))
  }

  func testAnythingElseIsOther() {
    XCTAssertEqual(
      ConnectivityState(isSatisfied: true, usesWifi: false, usesCellular: false),
      ConnectivityState(isConnected: true, networkType: "other"))
  }

  func testMonitorReportsTheCurrentState() {
    let monitor = ConnectivityMonitor { _ in }
    monitor.start()
    defer { monitor.stop() }

    XCTAssertTrue(["wifi", "cellular", "other", "none"].contains(monitor.current().networkType))
  }
}
