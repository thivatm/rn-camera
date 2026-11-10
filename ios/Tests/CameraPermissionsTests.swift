import AVFoundation
import XCTest
import RnCamera

final class CameraPermissionsTests: XCTestCase {
  func testMapsEveryAuthorizationStatusToAPermissionState() {
    XCTAssertEqual(CameraPermissionsImpl.state(for: .authorized), "granted")
    XCTAssertEqual(CameraPermissionsImpl.state(for: .denied), "denied")
    XCTAssertEqual(CameraPermissionsImpl.state(for: .notDetermined), "undetermined")
    XCTAssertEqual(CameraPermissionsImpl.state(for: .restricted), "restricted")
  }

  func testReportsCameraAndMicrophoneStatusWithoutPrompting() {
    let authorizer = FakeAuthorizer(camera: .authorized, microphone: .notDetermined)
    let permissions = CameraPermissionsImpl(authorizer: authorizer)

    XCTAssertEqual(permissions.status(), ["camera": "granted", "microphone": "undetermined"])
    XCTAssertTrue(authorizer.prompted.isEmpty)
  }

  func testRequestWithoutAudioPromptsForTheCameraOnly() {
    let authorizer = FakeAuthorizer(camera: .notDetermined, microphone: .notDetermined)
    let permissions = CameraPermissionsImpl(authorizer: authorizer)

    let result = request(permissions, audio: false)

    XCTAssertEqual(authorizer.prompted, [.video])
    XCTAssertEqual(result, ["camera": "granted", "microphone": "undetermined"])
  }

  func testRequestWithAudioPromptsOnlyForUndecidedPermissions() {
    let authorizer = FakeAuthorizer(camera: .denied, microphone: .notDetermined)
    authorizer.answer = false
    let permissions = CameraPermissionsImpl(authorizer: authorizer)

    let result = request(permissions, audio: true)

    XCTAssertEqual(authorizer.prompted, [.audio])
    XCTAssertEqual(result, ["camera": "denied", "microphone": "denied"])
  }

  private func request(_ permissions: CameraPermissionsImpl, audio: Bool) -> [String: String]? {
    let done = expectation(description: "request completes")
    var result: [String: String]?
    permissions.request(audio: audio) {
      result = $0
      done.fulfill()
    }
    wait(for: [done], timeout: 1)
    return result
  }
}
