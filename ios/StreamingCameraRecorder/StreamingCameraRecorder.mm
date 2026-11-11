#import "StreamingCameraRecorder.h"
#import "RnCameraSwift.h"

@implementation StreamingCameraRecorder

- (instancetype)init
{
  if (self = [super init]) {
    // The newest instance (e.g. after a JS reload) receives the events.
    __weak StreamingCameraRecorder *weakSelf = self;
    StreamingCameraRecorderEvents.shared.emit = ^(NSString *name, NSDictionary *payload) {
      [weakSelf emit:name payload:payload];
    };
  }
  return self;
}

- (void)emit:(NSString *)name payload:(NSDictionary *)payload
{
  if ([name isEqualToString:@"onRecordingStarted"]) {
    [self emitOnRecordingStarted:payload];
  } else if ([name isEqualToString:@"onRecordingFragment"]) {
    [self emitOnRecordingFragment:payload];
  } else if ([name isEqualToString:@"onRecordingStopped"]) {
    [self emitOnRecordingStopped:payload];
  } else if ([name isEqualToString:@"onRecordingFailed"]) {
    [self emitOnRecordingFailed:payload];
  }
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeStreamingCameraRecorderSpecJSI>(params);
}

+ (NSString *)moduleName
{
  return @"StreamingCameraRecorder";
}

@end
