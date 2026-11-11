import Foundation

/// Capture events the camera view reports to JS (see
/// `src/specs/NativeStreamingCameraRecorder.ts`). Called on the main thread.
public protocol RecordingEvents: AnyObject {
  func recordingStarted(id: String, filePath: String)
  func recordingFragment(id: String, recordedBytes: Int64)
  func recordingStopped(id: String, reason: String, finalSize: Int64)
  func recordingFailed(id: String, message: String)
}

/// Routes every camera view's capture events to the `StreamingCameraRecorder`
/// Turbo Module, which emits them to JS. Events go through a module rather
/// than the view so they still arrive after the view unmounts.
@objc(StreamingCameraRecorderEvents)
public final class StreamingCameraRecorderEvents: NSObject, RecordingEvents {
  @objc public static let shared = StreamingCameraRecorderEvents()

  /// `(eventName, payload)`, `eventName` being a spec emitter name
  /// (`onRecordingStarted`, …). Set by the Turbo Module.
  @objc public var emit: ((String, NSDictionary) -> Void)?

  public func recordingStarted(id: String, filePath: String) {
    emit?("onRecordingStarted", ["recordingId": id, "filePath": filePath])
  }

  public func recordingFragment(id: String, recordedBytes: Int64) {
    emit?("onRecordingFragment", ["recordingId": id, "recordedBytes": NSNumber(value: recordedBytes)])
  }

  public func recordingStopped(id: String, reason: String, finalSize: Int64) {
    emit?(
      "onRecordingStopped",
      ["recordingId": id, "reason": reason, "finalSize": NSNumber(value: finalSize)])
  }

  public func recordingFailed(id: String, message: String) {
    emit?("onRecordingFailed", ["recordingId": id, "message": message])
  }
}
