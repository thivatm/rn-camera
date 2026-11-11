import type * as React from 'react';
import {
  codegenNativeCommands,
  codegenNativeComponent,
  type CodegenTypes,
  type HostComponent,
  type ViewProps,
} from 'react-native';

export type NativeCameraErrorEvent = Readonly<{
  /** 'permissionMissing' | 'cameraUnavailable' | 'unknown' */
  code: string;
  message: string;
}>;

/**
 * Codegen spec for the `StreamingCamera` Fabric view (spec §3.2). The public
 * `video` object is flattened into `video*` props. Recording props/commands
 * are added by the recording tickets.
 */
export interface NativeProps extends ViewProps {
  position?: CodegenTypes.WithDefault<'front' | 'back', 'back'>;
  torch?: CodegenTypes.WithDefault<boolean, false>;
  zoom?: CodegenTypes.WithDefault<CodegenTypes.Float, 1>;
  enablePinchToZoom?: CodegenTypes.WithDefault<boolean, false>;
  enableTapToFocus?: CodegenTypes.WithDefault<boolean, false>;
  videoCodec?: CodegenTypes.WithDefault<'h264' | 'hevc', 'h264'>;
  /** '720p' | '1080p'. A string, not an enum: codegen can't name C++ enum cases that start with a digit. */
  videoResolution?: CodegenTypes.WithDefault<string, '1080p'>;
  /** 0 = native default. */
  videoFps?: CodegenTypes.WithDefault<CodegenTypes.Int32, 0>;
  /** Bits per second; 0 = native default. */
  videoBitrate?: CodegenTypes.WithDefault<CodegenTypes.Int32, 0>;
  audio?: CodegenTypes.WithDefault<boolean, true>;
  onCameraError?: CodegenTypes.DirectEventHandler<NativeCameraErrorEvent>;
}

type ComponentType = HostComponent<NativeProps>;

/**
 * Recording commands. Results arrive as `StreamingCameraRecorder` module
 * events, keyed by `recordingId`.
 */
interface NativeCommands {
  /**
   * Starts recording to `<Application Support>/rn-camera/recordings/<recordingId>.mp4`
   * with the current `video*` / `audio` props, then emits `onRecordingStarted`
   * (or `onRecordingFailed`).
   */
  startRecording: (
    viewRef: React.ElementRef<ComponentType>,
    recordingId: string
  ) => void;
  /**
   * Finishes the Live Recording, then emits `onRecordingStopped` with
   * `reason` (a `StopReason`). Ignored when not recording.
   */
  stopRecording: (
    viewRef: React.ElementRef<ComponentType>,
    reason: string
  ) => void;
}

export const Commands: NativeCommands = codegenNativeCommands<NativeCommands>({
  supportedCommands: ['startRecording', 'stopRecording'],
});

export default codegenNativeComponent<NativeProps>('StreamingCamera');
