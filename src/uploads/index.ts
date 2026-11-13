// The app-wide Recording registry over the native `RecordingUploads` Turbo
// Module, and the public `RecordingUploads` object (spec §3.3).
import { AppState } from 'react-native';
import {
    createNativePlatform,
    createNativeTransport,
} from '../engine/nativeTransport';
import type { Platform } from '../engine/transport';
import type { Spec } from '../specs/NativeRecordingUploads';
import { RecordingUploadsManager } from './RecordingUploadsManager';

let manager: RecordingUploadsManager | null = null;
let platform: Platform | null = null;

/**
 * The native `RecordingUploads` Turbo Module. Required lazily: looking it up
 * throws where it is not linked (e.g. Jest suites that never touch uploads).
 */
function nativeRecordingUploads(): Spec {
    return require('../specs/NativeRecordingUploads').default;
}

/** File, storage and signal primitives over the native module, created on first use. */
export function getNativePlatform(): Platform {
    platform ??= createNativePlatform(nativeRecordingUploads());
    return platform;
}

/**
 * The single registry, created on first use. Capture code (tickets 13/14)
 * calls its `registerLiveRecording` / `reportFileGrowth` /
 * `reportRecordingStopped`.
 */
export function getRecordingUploadsManager(): RecordingUploadsManager {
    if (!manager) {
        manager = new RecordingUploadsManager({
            transport: createNativeTransport(nativeRecordingUploads()),
            platform: getNativePlatform(),
            appState: AppState,
        });
    }
    return manager;
}

/** Uploads are separate from `<StreamingCamera>` and outlive it. Spec §3.3. */
export const RecordingUploads = {
    getRecordings: () => getRecordingUploadsManager().getRecordings(),
    resumeUploads: (
        opts: Parameters<RecordingUploadsManager['resumeUploads']>[0]
    ) => getRecordingUploadsManager().resumeUploads(opts),
    retryUpload: (
        ...args: Parameters<RecordingUploadsManager['retryUpload']>
    ) => getRecordingUploadsManager().retryUpload(...args),
    deleteRecording: (
        ...args: Parameters<RecordingUploadsManager['deleteRecording']>
    ) => getRecordingUploadsManager().deleteRecording(...args),
    addListener: ((event, listener) =>
        getRecordingUploadsManager().addListener(
            event,
            listener
        )) as RecordingUploadsManager['addListener'],
};

export {
    RecordingUploadsManager,
    createRecordingUploads,
    PROGRESS_INTERVAL_MS,
} from './RecordingUploadsManager';
export type {
    RecordingUploadsEventName,
    RecordingUploadsEvents,
    RecordingUploadsManagerOptions,
    AppStateSource,
    Subscription,
    UploadErrorEvent,
    UploadProgressEvent,
    UploadStateChangeEvent,
} from './RecordingUploadsManager';
