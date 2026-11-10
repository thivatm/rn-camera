import { useEffect, useRef, useState } from 'react';
import { AppState, type ViewProps } from 'react-native';
import { getPermissionStatus } from './permissions';
import NativeStreamingCamera, {
  type NativeCameraErrorEvent,
} from './specs/StreamingCameraNativeComponent';
import type {
  CameraError,
  CameraPosition,
  PermissionStatus,
  VideoOptions,
} from './types';

export type StreamingCameraProps = ViewProps & {
  /** Default `'back'`. Ignored while recording. */
  position?: CameraPosition;
  /** Default `false`. */
  torch?: boolean;
  /** Default `1`. */
  zoom?: number;
  enablePinchToZoom?: boolean;
  enableTapToFocus?: boolean;
  video?: VideoOptions;
  /** Default `true`. `false` = no microphone permission needed. */
  audio?: boolean;
  /** Permission missing, camera unavailable, … */
  onError?: (error: CameraError) => void;
};

function missingPermissions(
  status: PermissionStatus,
  audio: boolean
): string[] {
  const missing: string[] = [];
  if (status.camera !== 'granted') missing.push('camera');
  if (audio && status.microphone !== 'granted') missing.push('microphone');
  return missing;
}

/**
 * Camera preview (spec §3.2). Renders nothing until the required permissions
 * (camera, plus microphone when `audio`) are granted.
 */
export function StreamingCamera({
  video,
  audio = true,
  onError,
  ...rest
}: StreamingCameraProps) {
  const [allowed, setAllowed] = useState(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    // Report a missing permission once per transition, not on every check.
    let reported = false;
    const check = () =>
      getPermissionStatus().then((status) => {
        if (cancelled) return;
        const missing = missingPermissions(status, audio);
        setAllowed(missing.length === 0);
        if (missing.length === 0) {
          reported = false;
        } else if (!reported) {
          reported = true;
          onErrorRef.current?.({
            code: 'permissionMissing',
            message: `Missing ${missing.join(' and ')} permission`,
          });
        }
      });

    check();
    // The user may grant access in Settings while the app is in the background.
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [audio]);

  if (!allowed) return null;

  return (
    <NativeStreamingCamera
      {...rest}
      audio={audio}
      videoCodec={video?.codec}
      videoResolution={video?.resolution}
      videoFps={video?.fps}
      videoBitrate={video?.bitrate}
      onCameraError={(e) => onErrorRef.current?.(toCameraError(e.nativeEvent))}
    />
  );
}

const ERROR_CODES: readonly CameraError['code'][] = [
  'permissionMissing',
  'cameraUnavailable',
  'unknown',
];

function toCameraError(e: NativeCameraErrorEvent): CameraError {
  const code = (ERROR_CODES as readonly string[]).includes(e.code)
    ? (e.code as CameraError['code'])
    : 'unknown';
  return { code, message: e.message };
}
