import AVFoundation

/// Seam over `AVCaptureDevice`'s authorization API so permission logic can be
/// tested without the system prompt.
public protocol CameraAuthorizing {
  func authorizationStatus(for mediaType: AVMediaType) -> AVAuthorizationStatus
  func requestAccess(for mediaType: AVMediaType, completion: @escaping (Bool) -> Void)
}

/// The real authorizer, backed by `AVCaptureDevice`.
public struct SystemCameraAuthorizer: CameraAuthorizing {
  public init() {}

  public func authorizationStatus(for mediaType: AVMediaType) -> AVAuthorizationStatus {
    AVCaptureDevice.authorizationStatus(for: mediaType)
  }

  public func requestAccess(for mediaType: AVMediaType, completion: @escaping (Bool) -> Void) {
    AVCaptureDevice.requestAccess(for: mediaType, completionHandler: completion)
  }
}

/// Swift implementation behind the `CameraPermissions` Turbo Module (spec §3.4).
/// Results are `PermissionStatus` dictionaries: `{ camera, microphone }`.
@objc(CameraPermissionsImpl)
public final class CameraPermissionsImpl: NSObject {
  private let authorizer: CameraAuthorizing

  public init(authorizer: CameraAuthorizing) {
    self.authorizer = authorizer
  }

  @objc public override convenience init() {
    self.init(authorizer: SystemCameraAuthorizer())
  }

  /// `PermissionState` string for an AVFoundation status.
  public static func state(for status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "undetermined"
    @unknown default: return "undetermined"
    }
  }

  @objc public func status() -> [String: String] {
    [
      "camera": Self.state(for: authorizer.authorizationStatus(for: .video)),
      "microphone": Self.state(for: authorizer.authorizationStatus(for: .audio)),
    ]
  }

  /// Prompts for the camera, then the microphone when `audio` is true.
  /// Permissions the user already decided on are not re-prompted.
  @objc public func request(audio: Bool, completion: @escaping ([String: String]) -> Void) {
    let mediaTypes: [AVMediaType] = audio ? [.video, .audio] : [.video]
    let undecided = mediaTypes.filter { authorizer.authorizationStatus(for: $0) == .notDetermined }
    prompt(undecided[...]) { [self] in completion(status()) }
  }

  /// Prompts one at a time: iOS shows a single permission alert at once.
  private func prompt(_ mediaTypes: ArraySlice<AVMediaType>, then done: @escaping () -> Void) {
    guard let next = mediaTypes.first else { return done() }
    authorizer.requestAccess(for: next) { [self] _ in
      prompt(mediaTypes.dropFirst(), then: done)
    }
  }
}
