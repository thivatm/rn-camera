// The registry of Recordings behind the public `RecordingUploads` API
// (spec §3.3). One `RecordingUpload` engine per Recording; all I/O goes
// through the injected Transport / Platform seam, and time through the
// injected clock, so Jest can drive it against the Node fixtures.
import {
  RecordingUpload,
  type RecordingUploadOptions,
  type Schedule,
} from '../engine/RecordingUpload';
import { truncateToLastCompleteFragment } from '../engine/fragmentedMp4';
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
  UploadTarget,
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
  minChunkSize?: number;
  engine: RecordingUpload;
  progress: ProgressThrottle;
  /** A key/value write of this entry is queued. */
  persistQueued: boolean;
};

/** Key/value keys (spec §6). The index lists every persisted Recording id. */
const INDEX_KEY = 'rnCamera.uploads.index';
const recordingKey = (id: RecordingId) => `rnCamera.uploads.recording.${id}`;

/**
 * A Recording as stored in the key/value store. The Upload Target's headers
 * may hold credentials: the store is app-private and the record is removed
 * with the Recording.
 */
type PersistedRecording = {
  version: 1;
  id: RecordingId;
  metadata?: Metadata;
  filePath: string | null;
  createdAt: string;
  keepRecordingFile: boolean;
  allowCellular: boolean;
  minChunkSize?: number;
  isLive: boolean;
  interrupted: boolean;
  stopReason?: StopReason;
  recordedBytes: number;
  committedOffset: number;
  target: UploadTarget | null;
  status: UploadStatus;
};

/** Restored Recordings have no provider until `resumeUploads` / `retryUpload`. */
const noProvider: UploadUrlProvider = async () => {
  throw new Error(
    'No Upload URL Provider: call RecordingUploads.resumeUploads'
  );
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
  /** Restoring the persisted Recordings; the public API waits for it. */
  private readonly restored: Promise<void>;
  /** Key/value operations, one at a time and in order, after the restore. */
  private storage: Promise<void>;
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
    this.restored = this.restore().catch(() => {});
    this.storage = this.restored;
  }

  // ---- Public API (§3.3)

  async getRecordings(): Promise<Recording[]> {
    await this.restored;
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
    await this.restored;
    this.entry(recordingId).engine.retryUpload(opts.uploadUrlProvider);
  }

  /**
   * Removes a Finished Recording in any upload state (§7): cancels its upload
   * and deletes its file. No event fires for it afterwards. Rejects for the
   * Live Recording and for an unknown Recording.
   */
  async deleteRecording(recordingId: RecordingId): Promise<void> {
    await this.restored;
    const entry = this.entry(recordingId);
    if (entry.engine.snapshot().isLive) {
      throw new Error(`Recording ${recordingId} is live`);
    }
    this.entries.delete(recordingId);
    entry.engine.cancel();
    entry.progress.cancel();
    const { platform } = this.options;
    this.enqueueStorage(() => platform.kvRemove(recordingKey(recordingId)));
    this.persistIndex();
    if (entry.filePath) await this.options.platform.deleteFile(entry.filePath);
  }

  /**
   * Restarts the uploads paused by a relaunch (§6): each one sends a status
   * query to its stored Upload Target; one without a target asks
   * `uploadUrlProvider`. Other uploads are left alone.
   */
  async resumeUploads(opts: {
    uploadUrlProvider: UploadUrlProvider;
  }): Promise<void> {
    await this.restored;
    for (const entry of [...this.entries.values()]) {
      entry.engine.resume(opts.uploadUrlProvider);
    }
  }

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
      minChunkSize: options.minChunkSize,
      createdAt: new Date(this.now()).toISOString(),
      interrupted: false,
      persistQueued: false,
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
    this.persist(entry);
    this.persistIndex();
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
    this.persist(entry);
    entry.progress.request();
  }

  /** The Live Recording, if any. */
  liveRecordingId(): RecordingId | null {
    for (const entry of this.entries.values()) {
      if (entry.engine.snapshot().isLive) return entry.id;
    }
    return null;
  }

  // ---- Persistence (§6)

  /**
   * Rebuilds the persisted Recordings. A Recording persisted as live is an
   * Interrupted Recording: its file is cut back to the last complete
   * Fragment. Unfinished uploads become `paused` / `awaitingResume`.
   */
  private async restore(): Promise<void> {
    const { platform } = this.options;
    const ids = parseJson<RecordingId[]>(await platform.kvGet(INDEX_KEY)) ?? [];
    for (const id of ids) {
      if (this.entries.has(id)) continue;
      const record = parseJson<PersistedRecording>(
        await platform.kvGet(recordingKey(id))
      );
      if (record?.version !== 1) continue;
      const entry = await this.restoreEntry(record);
      if (this.entries.has(id)) continue;
      this.entries.set(id, entry);
      this.persist(entry);
    }
    this.persistIndex();
  }

  private async restoreEntry(record: PersistedRecording): Promise<Entry> {
    let { recordedBytes, interrupted, status } = record;
    if (record.isLive) {
      interrupted = true;
      recordedBytes = await this.repairInterruptedFile(record);
    }
    if (status.state !== 'completed' && status.state !== 'failed') {
      status = { state: 'paused', pauseReason: 'awaitingResume' };
    }
    const entry: Entry = {
      id: record.id,
      metadata: record.metadata,
      filePath: record.filePath,
      keepRecordingFile: record.keepRecordingFile,
      allowCellular: record.allowCellular,
      minChunkSize: record.minChunkSize,
      createdAt: record.createdAt,
      stopReason: record.stopReason,
      interrupted,
      persistQueued: false,
      engine: undefined as unknown as RecordingUpload,
      progress: undefined as unknown as ProgressThrottle,
    };
    entry.progress = new ProgressThrottle(this.now, this.schedule, () =>
      this.emitProgress(entry)
    );
    entry.engine = this.createEngine(entry, {
      filePath: record.filePath ?? '',
      uploadUrlProvider: noProvider,
      minChunkSize: record.minChunkSize,
      finishedSize: recordedBytes,
      restored: {
        status,
        target: record.target,
        committedOffset: record.committedOffset,
      },
    });
    return entry;
  }

  /** The Interrupted Recording's length after truncation; 0 if the file is gone. */
  private async repairInterruptedFile(
    record: PersistedRecording
  ): Promise<number> {
    if (!record.filePath) return 0;
    try {
      return await truncateToLastCompleteFragment(
        this.options.platform,
        record.filePath,
        record.committedOffset
      );
    } catch {
      // Missing or unreadable: resuming fails it with `fileMissing`.
      return 0;
    }
  }

  /** Queues a write of `entry`'s state as it is when the write runs. */
  private persist(entry: Entry): void {
    if (entry.persistQueued) return;
    entry.persistQueued = true;
    this.enqueueStorage(async () => {
      entry.persistQueued = false;
      if (this.entries.get(entry.id) !== entry) return;
      await this.options.platform.kvSet(
        recordingKey(entry.id),
        JSON.stringify(this.toPersisted(entry))
      );
    });
  }

  private persistIndex(): void {
    this.enqueueStorage(() =>
      this.options.platform.kvSet(
        INDEX_KEY,
        JSON.stringify([...this.entries.keys()])
      )
    );
  }

  /** A failed write is dropped; the entry's next write catches up. */
  private enqueueStorage(operation: () => Promise<void>): void {
    this.storage = this.storage.then(operation).catch(() => {});
  }

  private toPersisted(entry: Entry): PersistedRecording {
    const { status, recordedBytes, committedOffset, isLive, target } =
      entry.engine.snapshot();
    return withoutUndefined({
      version: 1 as const,
      id: entry.id,
      metadata: entry.metadata,
      filePath: entry.filePath,
      createdAt: entry.createdAt,
      keepRecordingFile: entry.keepRecordingFile,
      allowCellular: entry.allowCellular,
      minChunkSize: entry.minChunkSize,
      isLive,
      interrupted: entry.interrupted,
      stopReason: entry.stopReason,
      recordedBytes,
      committedOffset,
      target,
      status,
    });
  }

  // ---- Internals

  private createEngine(
    entry: Entry,
    options: Pick<
      RecordingUploadOptions,
      | 'filePath'
      | 'uploadUrlProvider'
      | 'minChunkSize'
      | 'finishedSize'
      | 'restored'
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
      onStateChange: (status) => {
        this.persist(entry);
        this.onStateChange(entry, status);
      },
      onProgress: () => {
        this.persist(entry);
        entry.progress.request();
      },
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

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as T;
}
