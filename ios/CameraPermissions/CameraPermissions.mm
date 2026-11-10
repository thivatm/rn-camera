#import "CameraPermissions.h"
#import "RnCameraSwift.h"

@implementation CameraPermissions {
  CameraPermissionsImpl *_impl;
}

- (instancetype)init
{
  if (self = [super init]) {
    _impl = [CameraPermissionsImpl new];
  }
  return self;
}

- (void)requestPermissions:(BOOL)audio
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [_impl requestWithAudio:audio
               completion:^(NSDictionary<NSString *, NSString *> *status) {
                 resolve(status);
               }];
}

- (void)getPermissionStatus:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  resolve([_impl status]);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeCameraPermissionsSpecJSI>(params);
}

+ (NSString *)moduleName
{
  return @"CameraPermissions";
}

@end
