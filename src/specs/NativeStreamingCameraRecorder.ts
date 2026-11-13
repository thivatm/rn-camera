import {
    TurboModuleRegistry,
    type CodegenTypes,
    type TurboModule,
} from 'react-native';

/** The camera began writing the Recording File at `filePath`. */
export type RecordingStartedEvent = {
    recordingId: string;
    filePath: string;
};

/** A Fragment was appended; the Recording File is now `recordedBytes` long. */
export type RecordingFragmentEvent = {
    recordingId: string;
    recordedBytes: CodegenTypes.Double;
};

/**
 * The Recording File is complete and `finalSize` long. `reason` is a
 * `StopReason`: the one passed to the `stopRecording` command, or
 * `'interrupted'` / `'backgrounded'` / `'user'` (view unmounted) when native
 * stopped on its own.
 */
export type RecordingStoppedEvent = {
    recordingId: string;
    reason: string;
    finalSize: CodegenTypes.Double;
};

/** Recording could not start; nothing was registered and no file is kept. */
export type RecordingFailedEvent = {
    recordingId: string;
    message: string;
};

/**
 * Codegen spec for the `StreamingCameraRecorder` Turbo Module: the capture
 * events of the `StreamingCamera` view. They come from a module rather than
 * the view so that they still arrive after the view unmounts (which stops a
 * Live Recording). Commands go to the view (`startRecording` /
 * `stopRecording` in `StreamingCameraNativeComponent`).
 */
export interface Spec extends TurboModule {
    readonly onRecordingStarted: CodegenTypes.EventEmitter<RecordingStartedEvent>;
    readonly onRecordingFragment: CodegenTypes.EventEmitter<RecordingFragmentEvent>;
    readonly onRecordingStopped: CodegenTypes.EventEmitter<RecordingStoppedEvent>;
    readonly onRecordingFailed: CodegenTypes.EventEmitter<RecordingFailedEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>(
    'StreamingCameraRecorder'
);
