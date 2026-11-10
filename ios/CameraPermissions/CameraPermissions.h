#import <RnCameraSpec/RnCameraSpec.h>

NS_ASSUME_NONNULL_BEGIN

/// `CameraPermissions` Turbo Module (spec §3.4). Thin ObjC++ shim over the
/// Swift `CameraPermissionsImpl`.
@interface CameraPermissions : NSObject <NativeCameraPermissionsSpec>
@end

NS_ASSUME_NONNULL_END
