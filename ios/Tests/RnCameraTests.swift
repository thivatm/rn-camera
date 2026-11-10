import XCTest
import RnCamera

/// Harness check: the Swift layer of the pod links into an XCTest bundle.
/// Feature tickets add their own test files next to this one.
final class RnCameraTests: XCTestCase {
  func testSwiftTypesAreReachable() {
    XCTAssertNotNil(RecordingUploadsImpl())
    XCTAssertTrue(StreamingCameraHostView(frame: .zero).subviews.isEmpty)
  }
}
