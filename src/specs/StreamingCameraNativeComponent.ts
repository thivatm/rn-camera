import {
  codegenNativeComponent,
  type CodegenTypes,
  type ViewProps,
} from 'react-native';

type ErrorEvent = Readonly<{
  code: string;
  message: string;
}>;

type VideoSettings = Readonly<{
  codec?: CodegenTypes.WithDefault<'h264' | 'hevc', 'h264'>;
  resolution?: CodegenTypes.WithDefault<'720p' | '1080p', '1080p'>;
  fps?: CodegenTypes.WithDefault<CodegenTypes.Int32, 30>;
  bitrate?: CodegenTypes.WithDefault<CodegenTypes.Int32, 5000000>;
}>;

/** Codegen spec for the `StreamingCamera` Fabric view (spec §3.2). */
export interface NativeProps extends ViewProps {
  position?: CodegenTypes.WithDefault<'front' | 'back', 'back'>;
  torch?: CodegenTypes.WithDefault<boolean, false>;
  zoom?: CodegenTypes.WithDefault<CodegenTypes.Float, 1.0>;
  enablePinchToZoom?: CodegenTypes.WithDefault<boolean, false>;
  enableTapToFocus?: CodegenTypes.WithDefault<boolean, false>;
  video?: VideoSettings;
  audio?: CodegenTypes.WithDefault<boolean, true>;
  onError?: CodegenTypes.DirectEventHandler<ErrorEvent>;
}

export default codegenNativeComponent<NativeProps>('StreamingCamera');
