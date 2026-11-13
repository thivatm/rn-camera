/**
 * The public types must match spec §3.1 exactly. The `Spec*` types below are
 * copied verbatim from docs/spec/v1.md §3.1 and act as the source of truth;
 * `yarn typecheck` fails if an exported type drifts from them.
 */
import type {
    Metadata,
    PauseReason,
    Recording,
    RecordingId,
    StartRecordingOptions,
    StopReason,
    UploadError,
    UploadState,
    UploadTarget,
    UploadUrlProvider,
} from '../index';

type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
type Expect<T extends true> = T;

// ---- spec §3.1, verbatim ----
type SpecRecordingId = string;
type SpecMetadata = Record<string, unknown>;
type SpecUploadTarget = {
    url: string;
    headers?: Record<string, string>;
};
type SpecUploadUrlProvider = (ctx: {
    recordingId: SpecRecordingId;
    metadata?: SpecMetadata;
}) => Promise<SpecUploadTarget>;
type SpecStartRecordingOptions = {
    uploadUrlProvider: SpecUploadUrlProvider;
    keepRecordingFile?: boolean;
    allowCellular?: boolean;
    metadata?: SpecMetadata;
    maxDurationSeconds?: number;
    minChunkSize?: number;
};
type SpecStopReason =
    'user' | 'interrupted' | 'lowStorage' | 'maxDuration' | 'backgrounded';
type SpecUploadState =
    | 'waitingForUrl'
    | 'uploading'
    | 'paused'
    | 'finalizing'
    | 'completed'
    | 'failed';
type SpecPauseReason =
    | 'offline'
    | 'backgrounded'
    | 'deprioritized'
    | 'awaitingWifi'
    | 'awaitingResume';
type SpecUploadError = {
    code: 'urlProviderFailed' | 'urlRejected' | 'fileMissing' | 'unknown';
    httpStatus?: number;
    message: string;
};
type SpecRecording = {
    id: SpecRecordingId;
    metadata?: SpecMetadata;
    isLive: boolean;
    interrupted: boolean;
    stopReason?: SpecStopReason;
    filePath: string | null;
    recordedBytes: number;
    committedOffset: number;
    uploadState: SpecUploadState;
    pauseReason?: SpecPauseReason;
    error?: SpecUploadError;
    keepRecordingFile: boolean;
    allowCellular: boolean;
    createdAt: string;
};

export type TypeAssertions = [
    Expect<Equal<RecordingId, SpecRecordingId>>,
    Expect<Equal<Metadata, SpecMetadata>>,
    Expect<Equal<UploadTarget, SpecUploadTarget>>,
    Expect<Equal<UploadUrlProvider, SpecUploadUrlProvider>>,
    Expect<Equal<StartRecordingOptions, SpecStartRecordingOptions>>,
    Expect<Equal<StopReason, SpecStopReason>>,
    Expect<Equal<UploadState, SpecUploadState>>,
    Expect<Equal<PauseReason, SpecPauseReason>>,
    Expect<Equal<UploadError, SpecUploadError>>,
    Expect<Equal<Recording, SpecRecording>>,
];

describe('public types (§3.1)', () => {
    it('accepts a Recording shaped as in the spec', () => {
        const recording: Recording = {
            id: '6f1c2c1e-0d6b-4c1a-9a51-2f7b8f2a9d10',
            isLive: false,
            interrupted: false,
            stopReason: 'user',
            filePath: null,
            recordedBytes: 3_145_728,
            committedOffset: 3_145_728,
            uploadState: 'completed',
            keepRecordingFile: true,
            allowCellular: true,
            createdAt: '2026-11-10T12:00:00.000Z',
        };

        expect(JSON.parse(JSON.stringify(recording))).toEqual(recording);
    });
});
