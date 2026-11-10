#import "StreamingCameraView.h"
#import "RnCameraSwift.h"

#import <react/renderer/components/RnCameraSpec/ComponentDescriptors.h>
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
    self.contentView = _hostView;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  [super updateProps:props oldProps:oldProps];
}

@end
