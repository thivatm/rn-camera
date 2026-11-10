// Upload engine for one Recording (spec §5.1 – §5.4, §5.6). Drives the pure
// chunk sizing, backoff and state machine; all I/O goes through the
// UploadProtocol / Transport seam, so the engine never touches video bytes.
import type {
  Metadata,
  PauseReason,
  RecordingId,
  UploadError,
  UploadTarget,
  UploadUrlProvider,
} from '../types';
import { backoffDelay } from './backoff';
import {
  DEFAULT_MIN_CHUNK_SIZE,
  planNextChunk,
  type ChunkPlan,
} from './chunkSizing';
import type { NetworkType, Platform, Transport } from './transport';
import {
  createResumableProtocol,
  type ProtocolReply,
  type UploadProtocol,
} from './uploadProtocol';
import {
  INITIAL_UPLOAD_STATUS,
  transition,
  type UploadEvent,
  type UploadStatus,
} from './uploadStateMachine';

/** Runs `callback` after `ms` milliseconds; returns a function that cancels it. */
export type Schedule = (callback: () => void, ms: number) => () => void;

/** The Platform primitives the engine uses: connectivity and file size. */
export type UploadPlatform = Pick<
  Platform,
  'getFileSize' | 'getConnectivity' | 'onConnectivityChange'
>;

export type RecordingUploadOptions = {
  recordingId: RecordingId;
  metadata?: Metadata;
  /** Path of the Recording File. */
  filePath: string;
  uploadUrlProvider: UploadUrlProvider;
  transport: Transport;
  /**
   * Connectivity (offline pauses the upload) and file checks. Without it the
   * engine assumes it is always online.
   */
  platform?: UploadPlatform;
  /** Bytes, multiple of 256 KiB. Default 1 MiB. */
  minChunkSize?: number;
  /**
   * Allow Cellular (spec §5.5). When `false`, a Finished Recording's upload
   * that restarts (after a pause, or a Retry Upload) while on `cellular`
   * waits as `paused` / `awaitingWifi`; an upload that is already running
   * carries on. Default `true`.
   */
  allowCellular?: boolean;
  /**
   * Set for a Finished Recording (e.g. from the Upload Queue): its final size.
   * Omit for the Live Recording and report growth with `fileGrew`.
   */
  finishedSize?: number;
  /**
   * State persisted before a relaunch (spec §6). Requires `finishedSize`. The
   * engine starts in `status` without calling the provider; a `paused` /
   * `awaitingResume` upload waits for `resume`.
   */
  restored?: {
    status: UploadStatus;
    target: UploadTarget | null;
    committedOffset: number;
  };
  /** Timer for retry backoff. Default: `setTimeout`. */
  schedule?: Schedule;
  /** A value in `[0, 1)`, for backoff jitter. Default: `Math.random`. */
  random?: () => number;
  onStateChange?: (status: UploadStatus) => void;
  onProgress?: (progress: {
    recordedBytes: number;
    committedOffset: number;
  }) => void;
};

/** Pauses the scheduler imposes on an upload (spec §5.5). */
export type SchedulerPauseReason = 'backgrounded' | 'deprioritized';

export type RecordingUploadSnapshot = {
  status: UploadStatus;
  recordedBytes: number;
  committedOffset: number;
  isLive: boolean;
  /** The current Upload Target, once the provider returned one. */
  target: UploadTarget | null;
};

const defaultSchedule: Schedule = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

export class RecordingUpload {
  private readonly options: RecordingUploadOptions;
  private readonly protocol: UploadProtocol;
  private readonly minChunkSize: number;
  private readonly schedule: Schedule;
  private readonly random: () => number;

  private provider: UploadUrlProvider;
  private status: UploadStatus = INITIAL_UPLOAD_STATUS;
  private target: UploadTarget | null = null;
  private recordedBytes: number;
  private committedOffset = 0;
  private isLive: boolean;
  /** Guards the one-request-in-flight rule. */
  private pumping = false;
  private started = false;
  private cancelled = false;
  /**
   * Bumped whenever the running send loop must stop (pause, Retry Upload).
   * A loop, request or provider call from an older epoch changes nothing.
   */
  private epoch = 0;
  /** Ask the server for its Committed Offset before sending more (§5.1). */
  private needsStatusQuery = false;
  /** Consecutive retryable failures, for the backoff delay. */
  private attempt = 0;
  /** Ends a pending backoff wait early. */
  private stopBackoff: (() => void) | null = null;
  private online = true;
  private networkType: NetworkType | null = null;
  /** Connectivity was reported at least once (always, without a platform). */
  private connectivityKnown: boolean;
  /** A pause imposed by the scheduler (spec §5.5), see `setHold`. */
  private hold: SchedulerPauseReason | null = null;
  /**
   * The upload was paused (or is a Retry Upload of a Finished Recording):
   * restarting it is subject to Allow Cellular.
   */
  private restarting = false;
  /** `resume` was called on a `paused` / `awaitingResume` upload. */
  private resumeRequested = false;
  private connectivitySubscription: { remove(): void } | null = null;
  private readonly settledWaiters: Array<(status: UploadStatus) => void> = [];

  constructor(options: RecordingUploadOptions) {
    this.options = options;
    this.provider = options.uploadUrlProvider;
    this.protocol = createResumableProtocol(options.transport);
    this.minChunkSize = options.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;
    this.schedule = options.schedule ?? defaultSchedule;
    this.random = options.random ?? Math.random;
    this.isLive = options.finishedSize === undefined;
    this.recordedBytes = options.finishedSize ?? 0;
    this.connectivityKnown = !options.platform;
    if (options.restored) {
      if (this.isLive) throw new Error('A restored upload needs finishedSize');
      this.status = options.restored.status;
      this.restarting = true;
      this.target = options.restored.target;
      this.committedOffset = options.restored.committedOffset;
    }
  }

  /** Calls the Upload URL Provider, then uploads as the file grows. Call once. */
  start(): void {
    if (this.started) throw new Error('RecordingUpload already started');
    this.started = true;
    this.watchConnectivity();
    this.requestTarget(this.provider);
  }

  /**
   * Restarts a restored `paused` / `awaitingResume` upload (spec §6): a status
   * query to its stored Upload Target, or, without one, a call to
   * `uploadUrlProvider`. A no-op in any other state.
   */
  resume(uploadUrlProvider: UploadUrlProvider): void {
    if (
      this.cancelled ||
      this.status.state !== 'paused' ||
      this.status.pauseReason !== 'awaitingResume'
    ) {
      return;
    }
    this.started = true;
    this.provider = uploadUrlProvider;
    this.resumeRequested = true;
    if (this.target) this.needsStatusQuery = true;
    this.watchConnectivity();
    this.reevaluate();
  }

  /**
   * The scheduler's pause (spec §5.5): `backgrounded` or `deprioritized`
   * stops a running upload and keeps a paused or not-yet-started one from
   * starting; `null` lets it (re)start. A restored upload still waits for
   * `resume`.
   */
  setHold(reason: SchedulerPauseReason | null): void {
    if (this.cancelled || this.hold === reason) return;
    this.hold = reason;
    this.reevaluate();
  }

  /** The Recording File is now `recordedBytes` long. */
  fileGrew(recordedBytes: number): void {
    if (this.cancelled) return;
    if (!this.isLive) throw new Error('fileGrew after recordingStopped');
    this.recordedBytes = Math.max(this.recordedBytes, recordedBytes);
    this.pump();
  }

  /** The Recording stopped; the Recording File is `finalSize` long and will not grow. */
  recordingStopped(finalSize: number): void {
    if (this.cancelled) return;
    this.recordedBytes = finalSize;
    this.isLive = false;
    this.pump();
  }

  /**
   * Retry Upload (spec §5.3): only for a `failed` upload, otherwise a no-op.
   * Gets a fresh Upload Target from `uploadUrlProvider` (default: the
   * original provider) and re-uploads from byte 0; the old URL's Committed
   * Offset does not carry over.
   */
  retryUpload(uploadUrlProvider?: UploadUrlProvider): void {
    if (this.cancelled || this.status.state !== 'failed') return;
    if (uploadUrlProvider) this.provider = uploadUrlProvider;
    if (!this.isLive) this.restarting = true;
    this.epoch++;
    this.target = null;
    this.needsStatusQuery = false;
    this.attempt = 0;
    this.setCommittedOffset(0);
    this.dispatch({ type: 'retryRequested' });
    this.watchConnectivity();
    this.requestTarget(this.provider);
  }

  /**
   * Stops the upload for good (e.g. the Recording was deleted): cancels the
   * in-flight request, any backoff wait and the provider call. No callback
   * fires afterwards and every later call is a no-op.
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.epoch++;
    this.stopBackoff?.();
    if (this.pumping && this.target) {
      this.options.transport.cancelChunk(this.target.url);
    }
    this.connectivitySubscription?.remove();
    this.connectivitySubscription = null;
  }

  snapshot(): RecordingUploadSnapshot {
    return {
      status: this.status,
      recordedBytes: this.recordedBytes,
      committedOffset: this.committedOffset,
      isLive: this.isLive,
      target: this.target,
    };
  }

  /** Resolves once the upload is `completed` or `failed`. */
  settled(): Promise<UploadStatus> {
    if (isSettled(this.status)) return Promise.resolve(this.status);
    return new Promise((resolve) => this.settledWaiters.push(resolve));
  }

  private requestTarget(provider: UploadUrlProvider): void {
    const { recordingId, metadata } = this.options;
    const epoch = this.epoch;
    Promise.resolve()
      .then(() => provider({ recordingId, metadata }))
      .then(
        (target) => {
          if (epoch !== this.epoch) return;
          this.target = target;
          this.reevaluate();
        },
        (error: unknown) => {
          if (epoch !== this.epoch) return;
          this.dispatch({
            type: 'uploadUrlProviderFailed',
            message: errorMessage(error),
          });
        }
      );
  }

  private dispatch(event: UploadEvent): void {
    if (this.cancelled) return;
    const next = transition(this.status, event);
    if (next === this.status) return;
    const changed =
      next.state !== this.status.state ||
      next.pauseReason !== this.status.pauseReason;
    this.status = next;
    if (next.state === 'paused') this.restarting = true;
    if (changed) this.options.onStateChange?.(next);
    if (isSettled(next)) {
      this.connectivitySubscription?.remove();
      this.connectivitySubscription = null;
      for (const resolve of this.settledWaiters.splice(0)) resolve(next);
    }
  }

  private watchConnectivity(): void {
    const { platform } = this.options;
    if (!platform || this.connectivitySubscription) return;
    let changed = false;
    this.connectivitySubscription = platform.onConnectivityChange((state) => {
      changed = true;
      this.setConnectivity(state.isConnected, state.networkType);
    });
    platform.getConnectivity().then(
      (state) => {
        if (!changed)
          this.setConnectivity(state.isConnected, state.networkType);
      },
      () => {
        // Unknown: assume online on any network.
        if (!changed) this.setConnectivity(true, null);
      }
    );
  }

  private setConnectivity(online: boolean, networkType: NetworkType | null) {
    if (this.cancelled) return;
    this.online = online;
    this.networkType = networkType;
    this.connectivityKnown = true;
    this.reevaluate();
  }

  /**
   * Applies the pause rules (spec §5.5) to the current status. A running
   * upload pauses when held or offline, but never for Wi-Fi; one that is
   * about to (re)start also waits for Wi-Fi when it may not use cellular.
   */
  private reevaluate(): void {
    if (this.cancelled) return;
    const { status } = this;
    if (isSending(status)) {
      const reason = this.hold ?? (this.online ? null : 'offline');
      if (reason) this.pause(reason);
      return;
    }
    const startable =
      (status.state === 'waitingForUrl' && this.target !== null) ||
      (status.state === 'paused' &&
        (status.pauseReason !== 'awaitingResume' || this.resumeRequested));
    if (!startable || !this.connectivityKnown) return;

    const reason = this.startBlocker();
    if (reason) {
      if (status.state !== 'paused' || status.pauseReason !== reason) {
        this.dispatch({ type: 'paused', reason });
      }
      return;
    }
    this.resumeRequested = false;
    if (status.state === 'waitingForUrl') {
      this.dispatch({ type: 'uploadTargetReceived' });
      this.pump();
    } else if (this.target) {
      this.dispatch({ type: 'resumed' });
      this.pump();
    } else {
      this.dispatch({ type: 'targetRequested' });
      this.requestTarget(this.provider);
    }
  }

  /** Why an upload that is not running may not start now, if anything. */
  private startBlocker(): PauseReason | null {
    if (this.hold) return this.hold;
    if (!this.online) return 'offline';
    const allowCellular = this.options.allowCellular ?? true;
    if (
      this.restarting &&
      !this.isLive &&
      !allowCellular &&
      this.networkType === 'cellular'
    ) {
      return 'awaitingWifi';
    }
    return null;
  }

  /** Stops sending: cancels the in-flight request and any backoff wait. */
  private pause(reason: PauseReason): void {
    this.epoch++;
    this.dispatch({ type: 'paused', reason });
    this.stopBackoff?.();
    if (this.pumping) {
      // A cancelled request may still have been committed.
      this.needsStatusQuery = true;
      if (this.target) this.options.transport.cancelChunk(this.target.url);
    }
  }

  /** Sends Chunks, one at a time, until there is nothing to send right now. */
  private pump(): void {
    if (this.cancelled || this.pumping || !this.target) return;
    if (!isSending(this.status)) return;
    this.pumping = true;
    const epoch = this.epoch;
    this.sendChunks(this.target, epoch)
      .catch((error: unknown) => {
        if (epoch === this.epoch) {
          this.fail({ code: 'unknown', message: errorMessage(error) });
        }
      })
      .finally(() => {
        this.pumping = false;
        // Growth, a stop or a resume reported after the loop's last check.
        if (isSending(this.status) && this.hasWork()) this.pump();
      });
  }

  private hasWork(): boolean {
    return (
      this.needsStatusQuery ||
      this.nextChunk() !== null ||
      this.isEmptyRecording()
    );
  }

  /** Stopped with no bytes: there is no non-empty final Chunk to send (§5.2). */
  private isEmptyRecording(): boolean {
    return !this.isLive && this.recordedBytes === 0;
  }

  /** `fileMissing` if the Recording File is gone, else `unknown`. */
  private async failEmptyRecording(): Promise<void> {
    const { platform, filePath } = this.options;
    if (platform) {
      try {
        await platform.getFileSize(filePath);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
          this.fail({ code: 'fileMissing', message: errorMessage(error) });
          return;
        }
      }
    }
    this.fail({ code: 'unknown', message: 'Recording File is empty' });
  }

  private async sendChunks(target: UploadTarget, epoch: number): Promise<void> {
    const { filePath } = this.options;
    const stale = () => epoch !== this.epoch || !isSending(this.status);
    while (!stale()) {
      if (this.needsStatusQuery) {
        const reply = await this.request(epoch, () =>
          this.protocol.queryStatus(target, filePath)
        );
        if (!reply || stale()) continue;
        if (reply.type === 'rejected') {
          await this.handleRejected(reply.httpStatus, epoch);
          continue;
        }
        this.needsStatusQuery = false;
        if (reply.type === 'complete') return this.complete();
        this.setCommittedOffset(reply.committedOffset);
        continue;
      }

      const chunk = this.nextChunk();
      if (!chunk) {
        if (this.isEmptyRecording()) await this.failEmptyRecording();
        return;
      }
      if (chunk.isFinal) this.dispatch({ type: 'finalChunkStarted' });

      const reply = await this.request(epoch, () =>
        this.protocol.sendChunk(target, filePath, chunk)
      );
      if (!reply || stale()) continue;
      switch (reply.type) {
        case 'committed':
          this.attempt = 0;
          this.setCommittedOffset(reply.committedOffset);
          break;
        case 'complete':
          this.attempt = 0;
          return this.complete();
        case 'rejected':
          await this.handleRejected(reply.httpStatus, epoch);
          break;
      }
    }
  }

  /**
   * Runs one request. A network failure backs off and returns `null`, after
   * which the loop queries status and resends; so does a request cut short
   * by a pause or Retry Upload. Other errors propagate.
   */
  private async request(
    epoch: number,
    send: () => Promise<ProtocolReply>
  ): Promise<ProtocolReply | null> {
    try {
      return await send();
    } catch (error) {
      if (epoch !== this.epoch) return null;
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENETWORK' || code === 'ECANCELLED') {
        await this.backOff(epoch);
        return null;
      }
      if (code === 'ENOENT') {
        this.fail({ code: 'fileMissing', message: errorMessage(error) });
        return null;
      }
      throw error;
    }
  }

  /** `408`, `429`, `5xx` back off and retry; any other status fails (§5.4). */
  private async handleRejected(httpStatus: number, epoch: number) {
    if (isRetryableStatus(httpStatus)) {
      await this.backOff(epoch);
      return;
    }
    this.fail({
      code: 'urlRejected',
      httpStatus,
      message: `Upload URL answered ${httpStatus}`,
    });
  }

  /** Waits out the next backoff delay; the next request is a status query. */
  private backOff(epoch: number): Promise<void> {
    this.needsStatusQuery = true;
    if (epoch !== this.epoch) return Promise.resolve();
    const delay = backoffDelay(this.attempt++, this.random);
    return new Promise((resolve) => {
      const cancel = this.schedule(() => {
        this.stopBackoff = null;
        resolve();
      }, delay);
      this.stopBackoff = () => {
        this.stopBackoff = null;
        cancel();
        resolve();
      };
    });
  }

  /** The server reported Upload Complete. */
  private complete(): void {
    if (this.isLive) {
      this.fail({
        code: 'unknown',
        message: 'Upload URL reported Upload Complete while still recording',
      });
      return;
    }
    this.setCommittedOffset(this.recordedBytes);
    if (this.status.state === 'uploading') {
      this.dispatch({ type: 'finalChunkStarted' });
    }
    this.dispatch({ type: 'uploadCompleted' });
  }

  private nextChunk(): ChunkPlan | null {
    return planNextChunk({
      committedOffset: this.committedOffset,
      recordedBytes: this.recordedBytes,
      isLive: this.isLive,
      minChunkSize: this.minChunkSize,
    });
  }

  private setCommittedOffset(committedOffset: number): void {
    if (this.cancelled) return;
    this.committedOffset = committedOffset;
    this.options.onProgress?.({
      recordedBytes: this.recordedBytes,
      committedOffset,
    });
  }

  private fail(error: UploadError): void {
    if (isSending(this.status)) this.dispatch({ type: 'uploadFailed', error });
  }
}

function isSending(status: UploadStatus): boolean {
  return status.state === 'uploading' || status.state === 'finalizing';
}

function isSettled(status: UploadStatus): boolean {
  return status.state === 'completed' || status.state === 'failed';
}

function isRetryableStatus(httpStatus: number): boolean {
  return httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
