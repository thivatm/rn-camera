// Coordinates capture with the upload registry (spec §3.2, §4, §5.3): the
// single-Live-Recording rule, forwarding native capture events to the upload
// engine, and the stop reasons decided in TS (`user`, `maxDuration`,
// `lowStorage`). Native decides `interrupted` and `backgrounded`, and stops
// with `user` when the camera view unmounts.
import type {
  RecordingStartedEvent,
  RecordingFragmentEvent,
  RecordingStoppedEvent,
  RecordingFailedEvent,
} from '../specs/NativeStreamingCameraRecorder';
import type { RecordingUploadsManager } from '../uploads/RecordingUploadsManager';
import type { RecordingId, StartRecordingOptions, StopReason } from '../types';

/** Free disk space below which a Live Recording stops with `lowStorage`. */
export const LOW_STORAGE_BYTES = 200 * 1024 * 1024;

export type RecordingStoppedInfo = {
  recordingId: RecordingId;
  reason: StopReason;
};

/** One mounted camera view, as the coordinator drives it. */
export type CameraHandle = {
  /** `false` when the native view is not mounted (e.g. no permission). */
  start(recordingId: RecordingId): boolean;
  stop(reason: StopReason): void;
  onStopped(info: RecordingStoppedInfo): void;
};

type Subscription = { remove(): void };
type Emitter<T> = (listener: (event: T) => void) => Subscription;

export type RecorderEvents = {
  onRecordingStarted: Emitter<RecordingStartedEvent>;
  onRecordingFragment: Emitter<RecordingFragmentEvent>;
  onRecordingStopped: Emitter<RecordingStoppedEvent>;
  onRecordingFailed: Emitter<RecordingFailedEvent>;
};

export type CaptureUploads = Pick<
  RecordingUploadsManager,
  | 'registerLiveRecording'
  | 'reportFileGrowth'
  | 'reportRecordingStopped'
  | 'liveRecordingId'
>;

export type LiveRecordingsDeps = {
  events: () => RecorderEvents;
  uploads: () => CaptureUploads;
  freeDiskSpace: () => Promise<number>;
  newRecordingId?: () => RecordingId;
};

export type RecordingErrorCode =
  'recordingInProgress' | 'cameraNotReady' | 'recordingFailed';

export class RecordingError extends Error {
  readonly code: RecordingErrorCode;
  constructor(code: RecordingErrorCode, message: string) {
    super(message);
    this.name = 'RecordingError';
    this.code = code;
  }
}

type Live = {
  recordingId: RecordingId;
  camera: CameraHandle;
  options: StartRecordingOptions;
  started: boolean;
  stopping: boolean;
  checkingStorage: boolean;
  maxDurationTimer?: ReturnType<typeof setTimeout>;
  onStarted: { resolve(): void; reject(error: Error): void };
  stopWaiters: Array<() => void>;
};

export class LiveRecordings {
  private live: Live | null = null;
  private subscribed = false;

  constructor(private readonly deps: LiveRecordingsDeps) {}

  /** Resolves once native has started writing the Recording File. */
  async start(
    camera: CameraHandle,
    options: StartRecordingOptions
  ): Promise<{ recordingId: RecordingId }> {
    if (this.live || this.deps.uploads().liveRecordingId() !== null) {
      throw new RecordingError(
        'recordingInProgress',
        'A Live Recording already exists'
      );
    }
    this.subscribe();
    const recordingId = (this.deps.newRecordingId ?? uuidV4)();
    const started = new Promise<void>((resolve, reject) => {
      this.live = {
        recordingId,
        camera,
        options,
        started: false,
        stopping: false,
        checkingStorage: false,
        onStarted: { resolve, reject },
        stopWaiters: [],
      };
    });
    if (!camera.start(recordingId)) {
      this.live = null;
      throw new RecordingError('cameraNotReady', 'The camera is not ready');
    }
    await started;
    return { recordingId };
  }

  /** Stops `camera`'s Live Recording with `user`; resolves once it is Finished. */
  stop(camera: CameraHandle, reason: StopReason = 'user'): Promise<void> {
    const live = this.live;
    if (!live || live.camera !== camera) return Promise.resolve();
    const done = new Promise<void>((resolve) => live.stopWaiters.push(resolve));
    this.requestStop(live, reason);
    return done;
  }

  private requestStop(live: Live, reason: StopReason) {
    if (live.stopping) return;
    live.stopping = true;
    live.camera.stop(reason);
  }

  private subscribe() {
    if (this.subscribed) return;
    this.subscribed = true;
    const events = this.deps.events();
    events.onRecordingStarted((e) => this.handleStarted(e));
    events.onRecordingFragment((e) => this.handleFragment(e));
    events.onRecordingStopped((e) => this.handleStopped(e));
    events.onRecordingFailed((e) => this.handleFailed(e));
  }

  private current(recordingId: string): Live | null {
    return this.live?.recordingId === recordingId ? this.live : null;
  }

  private handleStarted(e: RecordingStartedEvent) {
    const live = this.current(e.recordingId);
    if (!live || live.started) return;
    live.started = true;
    this.deps.uploads().registerLiveRecording({
      recordingId: live.recordingId,
      filePath: e.filePath,
      options: live.options,
    });
    const { maxDurationSeconds } = live.options;
    if (maxDurationSeconds !== undefined && maxDurationSeconds > 0) {
      live.maxDurationTimer = setTimeout(
        () => this.requestStop(live, 'maxDuration'),
        maxDurationSeconds * 1000
      );
    }
    this.checkStorage(live);
    live.onStarted.resolve();
  }

  private handleFragment(e: RecordingFragmentEvent) {
    const live = this.current(e.recordingId);
    if (!live?.started) return;
    this.deps.uploads().reportFileGrowth(live.recordingId, e.recordedBytes);
    this.checkStorage(live);
  }

  private handleStopped(e: RecordingStoppedEvent) {
    const live = this.current(e.recordingId);
    if (!live?.started) return;
    this.live = null;
    clearTimeout(live.maxDurationTimer);
    const reason = toStopReason(e.reason);
    this.deps.uploads().reportRecordingStopped(live.recordingId, {
      finalSize: e.finalSize,
      reason,
    });
    live.stopWaiters.forEach((resolve) => resolve());
    live.camera.onStopped({ recordingId: live.recordingId, reason });
  }

  private handleFailed(e: RecordingFailedEvent) {
    const live = this.current(e.recordingId);
    if (!live || live.started) return;
    this.live = null;
    live.stopWaiters.forEach((resolve) => resolve());
    live.onStarted.reject(new RecordingError('recordingFailed', e.message));
  }

  private checkStorage(live: Live) {
    if (live.checkingStorage || live.stopping) return;
    live.checkingStorage = true;
    this.deps
      .freeDiskSpace()
      .then(
        (free) => {
          if (free < LOW_STORAGE_BYTES && this.live === live) {
            this.requestStop(live, 'lowStorage');
          }
        },
        () => {}
      )
      .finally(() => {
        live.checkingStorage = false;
      });
  }
}

const STOP_REASONS: readonly StopReason[] = [
  'user',
  'interrupted',
  'lowStorage',
  'maxDuration',
  'backgrounded',
];

function toStopReason(reason: string): StopReason {
  return (STOP_REASONS as readonly string[]).includes(reason)
    ? (reason as StopReason)
    : 'interrupted';
}

/** RFC 4122 version 4 UUID. */
export function uuidV4(): string {
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) bytes.push(Math.floor(Math.random() * 256));
  bytes[6] = 0x40 + (bytes[6]! % 16); // version 4
  bytes[8] = 0x80 + (bytes[8]! % 64); // variant 10xx
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
