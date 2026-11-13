export { getPermissionStatus, requestPermissions } from './permissions';
export {
    StreamingCamera,
    type StreamingCameraProps,
    type StreamingCameraRef,
} from './StreamingCamera';
export {
    RecordingError,
    type RecordingErrorCode,
    type RecordingStoppedInfo,
} from './recording';
export { RecordingUploads } from './uploads';
export type {
    RecordingUploadsEventName,
    RecordingUploadsEvents,
    Subscription,
    UploadErrorEvent,
    UploadProgressEvent,
    UploadStateChangeEvent,
} from './uploads';

export type {
    CameraError,
    CameraPosition,
    Metadata,
    PauseReason,
    PermissionState,
    PermissionStatus,
    Recording,
    RecordingId,
    StartRecordingOptions,
    StopReason,
    UploadError,
    UploadState,
    UploadTarget,
    UploadUrlProvider,
    VideoOptions,
} from './types';
