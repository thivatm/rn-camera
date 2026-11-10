#import "RecordingUploads.h"
#import "RnCameraSwift.h"

@implementation RecordingUploads {
  RecordingUploadsImpl *_impl;
}

- (instancetype)init
{
  if (self = [super init]) {
    _impl = [RecordingUploadsImpl new];
    __weak RecordingUploads *weakSelf = self;
    _impl.onConnectivityChange = ^(NSDictionary *state) {
      [weakSelf emitOnConnectivityChange:state];
    };
  }
  return self;
}

- (void)invalidate
{
  [_impl invalidate];
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

static void (^rejecter(RCTPromiseRejectBlock reject))(NSString *, NSString *)
{
  return ^(NSString *code, NSString *message) {
    reject(code, message, nil);
  };
}

- (void)sendChunk:(JS::NativeRecordingUploads::ChunkRequest &)request
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  id headers = request.headers();
  [_impl sendChunkWithUrl:request.url()
                  headers:[headers isKindOfClass:[NSDictionary class]] ? headers : nil
                     path:request.path()
                    start:request.start()
                      end:request.end()
             contentRange:request.contentRange()
                  resolve:resolve
                   reject:rejecter(reject)];
}

- (void)cancelChunk:(NSString *)url
{
  [_impl cancelChunkWithUrl:url];
}

- (void)getFileSize:(NSString *)path
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  [_impl getFileSizeWithPath:path resolve:resolve reject:rejecter(reject)];
}

- (void)readRange:(NSString *)path
            start:(double)start
           length:(double)length
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  [_impl readRangeWithPath:path start:start length:length resolve:resolve reject:rejecter(reject)];
}

- (void)truncate:(NSString *)path
          length:(double)length
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  [_impl truncateWithPath:path length:length resolve:resolve reject:rejecter(reject)];
}

- (void)deleteFile:(NSString *)path
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  [_impl deleteFileWithPath:path resolve:resolve reject:rejecter(reject)];
}

- (void)getFreeDiskSpace:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_impl getFreeDiskSpaceWithResolve:resolve reject:rejecter(reject)];
}

- (void)kvGet:(NSString *)key
      resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject
{
  [_impl kvGetWithKey:key resolve:resolve reject:rejecter(reject)];
}

- (void)kvSet:(NSString *)key
        value:(NSString *)value
      resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject
{
  [_impl kvSetWithKey:key value:value resolve:resolve reject:rejecter(reject)];
}

- (void)kvRemove:(NSString *)key
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  [_impl kvRemoveWithKey:key resolve:resolve reject:rejecter(reject)];
}

- (void)getConnectivity:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [_impl getConnectivityWithResolve:resolve reject:rejecter(reject)];
}

@end
