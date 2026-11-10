#import "RecordingUploads.h"
#import "RnCameraSwift.h"

@implementation RecordingUploads {
  RecordingUploadsImpl *_impl;
}

- (instancetype)init
{
  if (self = [super init]) {
    _impl = [RecordingUploadsImpl new];
  }
  return self;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeRecordingUploadsSpecJSI>(params);
}

+ (NSString *)moduleName
{
  return @"RecordingUploads";
}

@end
