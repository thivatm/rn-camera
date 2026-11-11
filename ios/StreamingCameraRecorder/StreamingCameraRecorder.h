#import <RnCameraSpec/RnCameraSpec.h>

NS_ASSUME_NONNULL_BEGIN

/// Turbo Module `StreamingCameraRecorder`: emits the camera views' capture
/// events (started, fragment, stopped, failed) to JS.
@interface StreamingCameraRecorder : NativeStreamingCameraRecorderSpecBase <NativeStreamingCameraRecorderSpec>
@end

NS_ASSUME_NONNULL_END
