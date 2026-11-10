#import "StreamingCameraView.h"
#import "RnCameraSwift.h"

#import <react/renderer/components/RnCameraSpec/ComponentDescriptors.h>
#import <react/renderer/components/RnCameraSpec/EventEmitters.h>
#import <react/renderer/components/RnCameraSpec/Props.h>
#import <react/renderer/components/RnCameraSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@implementation StreamingCameraView {
  StreamingCameraHostView *_hostView;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<StreamingCameraComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const StreamingCameraProps>();
    _props = defaultProps;

    _hostView = [[StreamingCameraHostView alloc] initWithFrame:frame];
    __weak StreamingCameraView *weakSelf = self;
    _hostView.onCameraError = ^(NSString *code, NSString *message) {
      [weakSelf emitCameraErrorWithCode:code message:message];
    };
    self.contentView = _hostView;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &newProps = *std::static_pointer_cast<const StreamingCameraProps>(props);

  _hostView.position = newProps.position == StreamingCameraPosition::Front ? @"front" : @"back";
  _hostView.torch = newProps.torch;
  _hostView.zoom = newProps.zoom;
  _hostView.enablePinchToZoom = newProps.enablePinchToZoom;
  _hostView.enableTapToFocus = newProps.enableTapToFocus;
  _hostView.videoCodec = newProps.videoCodec == StreamingCameraVideoCodec::Hevc ? @"hevc" : @"h264";
  _hostView.videoResolution = [NSString stringWithUTF8String:newProps.videoResolution.c_str()];
  _hostView.videoFps = newProps.videoFps;
  _hostView.videoBitrate = newProps.videoBitrate;
  _hostView.audio = newProps.audio;

  [super updateProps:props oldProps:oldProps];
}

- (void)emitCameraErrorWithCode:(NSString *)code message:(NSString *)message
{
  if (!_eventEmitter) {
    return;
  }
  std::static_pointer_cast<const StreamingCameraEventEmitter>(_eventEmitter)
      ->onCameraError({.code = std::string(code.UTF8String), .message = std::string(message.UTF8String)});
}

@end
