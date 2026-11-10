// The registry of Recordings behind the public `RecordingUploads` API
// (spec §3.3). One `RecordingUpload` engine per Recording; all I/O goes
// through the injected Transport / Platform seam, and time through the
// injected clock, so Jest can drive it against the Node fixtures.
import {
  RecordingUpload,
  type RecordingUploadOptions,
  type Schedule,
} from '../engine/RecordingUpload';
import type { Platform, Transport } from '../engine/transport';
import type { UploadStatus } from '../engine/uploadStateMachine';
import type {
  Metadata,
  PauseReason,
  Recording,
  RecordingId,
  StartRecordingOptions,
  StopReason,
  UploadError,
  UploadState,
  UploadUrlProvider,
} from '../types';

/** `uploadProgress` is sent at most once per this many ms per Recording (§5.5). */
export const PROGRESS_INTERVAL_MS = 250;

export type UploadProgressEvent = {
  recordingId: RecordingId;
  metadata?: Metadata;
  recordedBytes: number;
  committedOffset: number;
};

export type UploadStateChangeEvent = {
  recordingId: RecordingId;
  metadata?: Metadata;
  state: UploadState;
  pauseReason?: PauseReason;
};

export type UploadErrorEvent = {
  recordingId: RecordingId;
  metadata?: Metadata;
  error: UploadError;
};

export type RecordingUploadsEvents = {
  uploadProgress: UploadProgressEvent;
  uploadStateChange: UploadStateChangeEvent;
  uploadError: UploadErrorEvent;
};

export type RecordingUploadsEventName = keyof RecordingUploadsEvents;

export type Subscription = { remove(): void };

export type RecordingUploadsManagerOptions = {
  transport: Transport;
  platform: Platform;
  /** Milliseconds since the epoch, for `createdAt` and throttling. Default: `Date.now`. */
  now?: () => number;
  /** Timer for progress throttling and retry backoff. Default: `setTimeout`. */
  schedule?: Schedule;
  /** A value in `[0, 1)`, for backoff jitter. Default: `Math.random`. */
  random?: () => number;
};

/** A Recording's entry in the registry. */
type Entry = {
  id: RecordingId;
  metadata?: Metadata;
  filePath: string | null;
  keepRecordingFile: boolean;
  allowCellular: boolean;
  createdAt: string;
  stopReason?: StopReason;
  interrupted: boolean;
  engine: RecordingUpload;
  progress: ProgressThrottle;
};

const defaultSchedule: Schedule = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

export class RecordingUploadsManager {
  private readonly options: RecordingUploadsManagerOptions;
  private readonly now: () => number;
  private readonly schedule: Schedule;
  private readonly entries = new Map<RecordingId, Entry>();
  private readonly listeners: {
    [E in RecordingUploadsEventName]: Set<
      (event: RecordingUploadsEvents[E]) => void
    >;
  } = {
    uploadProgress: new Set(),
    uploadStateChange: new Set(),
    uploadError: new Set(),
  };

  constructor(options: RecordingUploadsManagerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
  }

  // ---- Public API (§3.3)

  async getRecordings(): Promise<Recording[]> {
    return [...this.entries.values()].map((entry) => this.toRecording(entry));
  }

  /**
   * Retry Upload (§5.3) for a `failed` upload: a fresh Upload Target from
   * `uploadUrlProvider`, from byte 0. A no-op in any other state. Rejects for
   * an unknown Recording.
   */
  async retryUpload(
    recordingId: RecordingId,
    opts: { uploadUrlProvider: UploadUrlProvider }
  ): Promise<void> {
    this.entry(recordingId).engine.retryUpload(opts.uploadUrlProvider);
  }

  /**
   * Removes a Finished Recording in any upload state (§7): cancels its upload
   * and deletes its file. No event fires for it afterwards. Rejects for the
   * Live Recording and for an unknown Recording.
   */
  async deleteRecording(recordingId: RecordingId): Promise<void> {
    const entry = this.entry(recordingId);
    if (entry.engine.snapshot().isLive) {
      throw new Error(`Recording ${recordingId} is live`);
    }
    this.entries.delete(recordingId);
    entry.engine.cancel();
    entry.progress.cancel();
    if (entry.filePath) await this.options.platform.deleteFile(entry.filePath);
  }

  /** Restarts uploads after a relaunch (§6). Not implemented until ticket 09. */
  async resumeUploads(_opts: {
    uploadUrlProvider: UploadUrlProvider;
  }): Promise<void> {}

  addListener<E extends RecordingUploadsEventName>(
    event: E,
    listener: (event: RecordingUploadsEvents[E]) => void
  ): Subscription {
    const set = this.listeners[event] as Set<
      (event: RecordingUploadsEvents[E]) => void
    >;
    set.add(listener);
    return { remove: () => set.delete(listener) };
  }

  // ---- Capture-facing API (tickets 13/14)

  /**
   * A new Live Recording. Calls the Upload URL Provider right away; capture
   * does not wait for it.
   */
  registerLiveRecording(input: {
    recordingId: RecordingId;
    filePath: string;
    options: StartRecordingOptions;
  }): void {
    const { recordingId, filePath, options } = input;
    if (this.entries.has(recordingId)) {
      throw new Error(`Recording ${recordingId} is already registered`);
    }
    const entry: Entry = {
      id: recordingId,
      metadata: options.metadata,
      filePath,
      keepRecordingFile: options.keepRecordingFile ?? true,
      allowCellular: options.allowCellular ?? true,
      createdAt: new Date(this.now()).toISOString(),
      interrupted: false,
      // Assigned below: the engine's callbacks need the entry.
      engine: undefined as unknown as RecordingUpload,
      progress: undefined as unknown as ProgressThrottle,
    };
    entry.progress = new ProgressThrottle(this.now, this.schedule, () =>
      this.emitProgress(entry)
    );
    entry.engine = this.createEngine(entry, {
      filePath,
      uploadUrlProvider: options.uploadUrlProvider,
      minChunkSize: options.minChunkSize,
    });
    this.entries.set(recordingId, entry);
    entry.engine.start();
  }

  /** The Live Recording's file is now `recordedBytes` long. */
  reportFileGrowth(recordingId: RecordingId, recordedBytes: number): void {
    const entry = this.liveEntry(recordingId);
    entry.engine.fileGrew(recordedBytes);
    entry.progress.request();
  }

  /** The Live Recording stopped; its file is `finalSize` long. */
  reportRecordingStopped(
    recordingId: RecordingId,
    stop: { finalSize: number; reason: StopReason }
  ): void {
    const entry = this.liveEntry(recordingId);
    entry.stopReason = stop.reason;
    entry.engine.recordingStopped(stop.finalSize);
    entry.progress.request();
  }

  /** The Live Recording, if any. */
  liveRecordingId(): RecordingId | null {
    for (const entry of this.entries.values()) {
      if (entry.engine.snapshot().isLive) return entry.id;
    }
    return null;
  }

  // ---- Internals

  private createEngine(
    entry: Entry,
    options: Pick<
      RecordingUploadOptions,
      'filePath' | 'uploadUrlProvider' | 'minChunkSize' | 'finishedSize'
    >
  ): RecordingUpload {
    return new RecordingUpload({
      ...options,
      recordingId: entry.id,
      metadata: entry.metadata,
      transport: this.options.transport,
      platform: this.options.platform,
      schedule: this.options.schedule,
      random: this.options.random,
      onStateChange: (status) => this.onStateChange(entry, status),
      onProgress: () => entry.progress.request(),
    });
  }

  private onStateChange(entry: Entry, status: UploadStatus): void {
    if (this.entries.get(entry.id) !== entry) return;
    const { metadata } = entry;
    this.emit(
      'uploadStateChange',
      withoutUndefined({
        recordingId: entry.id,
        metadata,
        state: status.state,
        pauseReason: status.pauseReason,
      })
    );
    if (status.state === 'failed' && status.error) {
      this.emit(
        'uploadError',
        withoutUndefined({
          recordingId: entry.id,
          metadata,
          error: status.error,
        })
      );
    }
  }

  private emitProgress(entry: Entry): void {
    if (this.entries.get(entry.id) !== entry) return;
    const { recordedBytes, committedOffset } = entry.engine.snapshot();
    this.emit(
      'uploadProgress',
      withoutUndefined({
        recordingId: entry.id,
        metadata: entry.metadata,
        recordedBytes,
        committedOffset,
      })
    );
  }

  private emit<E extends RecordingUploadsEventName>(
    name: E,
    event: RecordingUploadsEvents[E]
  ): void {
    const set = this.listeners[name] as Set<
      (event: RecordingUploadsEvents[E]) => void
    >;
    for (const listener of [...set]) listener(event);
  }

  private entry(recordingId: RecordingId): Entry {
    const entry = this.entries.get(recordingId);
    if (!entry) throw new Error(`Unknown Recording ${recordingId}`);
    return entry;
  }

  private liveEntry(recordingId: RecordingId): Entry {
    const entry = this.entry(recordingId);
    if (!entry.engine.snapshot().isLive) {
      throw new Error(`Recording ${recordingId} is not live`);
    }
    return entry;
  }

  private toRecording(entry: Entry): Recording {
    const { status, recordedBytes, committedOffset, isLive } =
      entry.engine.snapshot();
    return withoutUndefined({
      id: entry.id,
      metadata: entry.metadata,
      isLive,
      interrupted: entry.interrupted,
      stopReason: entry.stopReason,
      filePath: entry.filePath,
      recordedBytes,
      committedOffset,
      uploadState: status.state,
      pauseReason: status.pauseReason,
      error: status.error,
      keepRecordingFile: entry.keepRecordingFile,
      allowCellular: entry.allowCellular,
      createdAt: entry.createdAt,
    });
  }
}

/**
 * Sends at most one event per `PROGRESS_INTERVAL_MS`. A request inside the
 * window is delivered at the window's end, with the values current then.
 */
class ProgressThrottle {
  private lastSent = -Infinity;
  private cancelPending: (() => void) | null = null;

  constructor(
    private readonly now: () => number,
    private readonly schedule: Schedule,
    private readonly send: () => void
  ) {}

  request(): void {
    if (this.cancelPending) return;
    const wait = this.lastSent + PROGRESS_INTERVAL_MS - this.now();
    if (wait <= 0) {
      this.fire();
      return;
    }
    this.cancelPending = this.schedule(() => {
      this.cancelPending = null;
      this.fire();
    }, wait);
  }

  cancel(): void {
    this.cancelPending?.();
    this.cancelPending = null;
  }

  private fire(): void {
    this.lastSent = this.now();
    this.send();
  }
}

export function createRecordingUploads(
  options: RecordingUploadsManagerOptions
): RecordingUploadsManager {
  return new RecordingUploadsManager(options);
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as T;
}
