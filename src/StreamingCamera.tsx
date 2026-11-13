import {
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
    type ComponentRef,
    type Ref,
} from 'react';
import { AppState, type ViewProps } from 'react-native';
import { getPermissionStatus } from './permissions';
import { getLiveRecordings, type RecordingStoppedInfo } from './recording';
import type { CameraHandle } from './recording/LiveRecordings';
import NativeStreamingCamera, {
    Commands,
    type NativeCameraErrorEvent,
} from './specs/StreamingCameraNativeComponent';
import type {
    CameraError,
    CameraPosition,
    PermissionStatus,
    RecordingId,
    StartRecordingOptions,
    VideoOptions,
} from './types';

/** `ref` of `<StreamingCamera>` (spec §3.2). */
export type StreamingCameraRef = {
    /**
     * Starts a Live Recording and its upload. Calls `uploadUrlProvider` right
     * away but does not wait for it. Rejects with a `RecordingError` while a
     * Live Recording exists (`recordingInProgress`), when the camera is not
     * showing (`cameraNotReady`), or when capture fails to start
     * (`recordingFailed`).
     */
    startRecording(
        options: StartRecordingOptions
    ): Promise<{ recordingId: RecordingId }>;
    /** Stops this camera's Live Recording with `reason: 'user'`; resolves once it is Finished. */
    stopRecording(): Promise<void>;
};

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
    /** A Live Recording became a Finished Recording, for any `StopReason`. */
    onRecordingStopped?: (info: RecordingStoppedInfo) => void;
    ref?: Ref<StreamingCameraRef>;
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
    position,
    video,
    audio = true,
    onError,
    onRecordingStopped,
    ref,
    ...rest
}: StreamingCameraProps) {
    const [allowed, setAllowed] = useState(false);
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    const onRecordingStoppedRef = useRef(onRecordingStopped);
    onRecordingStoppedRef.current = onRecordingStopped;
    const nativeRef = useRef<ComponentRef<typeof NativeStreamingCamera>>(null);

    const camera = useMemo<CameraHandle>(
        () => ({
            start: (recordingId) => {
                if (!nativeRef.current) return false;
                Commands.startRecording(nativeRef.current, recordingId);
                return true;
            },
            stop: (reason) => {
                if (nativeRef.current)
                    Commands.stopRecording(nativeRef.current, reason);
            },
            onStopped: (info) => onRecordingStoppedRef.current?.(info),
        }),
        []
    );

    useImperativeHandle(
        ref,
        () => ({
            startRecording: (options) =>
                getLiveRecordings().start(camera, options),
            stopRecording: () => getLiveRecordings().stop(camera),
        }),
        [camera]
    );

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
            ref={nativeRef}
            cameraPosition={position}
            audio={audio}
            videoCodec={video?.codec}
            videoResolution={video?.resolution}
            videoFps={video?.fps}
            videoBitrate={video?.bitrate}
            onCameraError={(e) =>
                onErrorRef.current?.(toCameraError(e.nativeEvent))
            }
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
