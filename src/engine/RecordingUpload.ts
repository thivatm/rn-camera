// Upload engine for one Recording (spec §5.1, §5.2, §5.6). Drives the pure
// chunk sizing and state machine; all I/O goes through the UploadProtocol /
// Transport seam, so the engine never touches video bytes.
import type {
  Metadata,
  RecordingId,
  UploadError,
  UploadTarget,
  UploadUrlProvider,
} from '../types';
import {
  DEFAULT_MIN_CHUNK_SIZE,
  planNextChunk,
  type ChunkPlan,
} from './chunkSizing';
import type { Transport } from './transport';
import { createResumableProtocol, type UploadProtocol } from './uploadProtocol';
import {
  INITIAL_UPLOAD_STATUS,
  transition,
  type UploadEvent,
  type UploadStatus,
} from './uploadStateMachine';

export type RecordingUploadOptions = {
  recordingId: RecordingId;
  metadata?: Metadata;
  /** Path of the Recording File. */
  filePath: string;
  uploadUrlProvider: UploadUrlProvider;
  transport: Transport;
  /** Bytes, multiple of 256 KiB. Default 1 MiB. */
  minChunkSize?: number;
  /**
   * Set for a Finished Recording (e.g. from the Upload Queue): its final size.
   * Omit for the Live Recording and report growth with `fileGrew`.
   */
  finishedSize?: number;
  onStateChange?: (status: UploadStatus) => void;
  onProgress?: (progress: {
    recordedBytes: number;
    committedOffset: number;
  }) => void;
};

export type RecordingUploadSnapshot = {
  status: UploadStatus;
  recordedBytes: number;
  committedOffset: number;
  isLive: boolean;
};

export class RecordingUpload {
  private readonly options: RecordingUploadOptions;
  private readonly protocol: UploadProtocol;
  private readonly minChunkSize: number;

  private status: UploadStatus = INITIAL_UPLOAD_STATUS;
  private target: UploadTarget | null = null;
  private recordedBytes: number;
  private committedOffset = 0;
  private isLive: boolean;
  /** Guards the one-request-in-flight rule. */
  private pumping = false;
  private started = false;
  private readonly settledWaiters: Array<(status: UploadStatus) => void> = [];

  constructor(options: RecordingUploadOptions) {
    this.options = options;
    this.protocol = createResumableProtocol(options.transport);
    this.minChunkSize = options.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;
    this.isLive = options.finishedSize === undefined;
    this.recordedBytes = options.finishedSize ?? 0;
  }

  /** Calls the Upload URL Provider, then uploads as the file grows. Call once. */
  start(): void {
    if (this.started) throw new Error('RecordingUpload already started');
    this.started = true;
    const { recordingId, metadata, uploadUrlProvider } = this.options;
    Promise.resolve()
      .then(() => uploadUrlProvider({ recordingId, metadata }))
      .then(
        (target) => {
          this.target = target;
          this.dispatch({ type: 'uploadTargetReceived' });
          this.pump();
        },
        (error: unknown) => {
          this.dispatch({
            type: 'uploadUrlProviderFailed',
            message: errorMessage(error),
          });
        }
      );
  }

  /** The Recording File is now `recordedBytes` long. */
  fileGrew(recordedBytes: number): void {
    if (!this.isLive) throw new Error('fileGrew after recordingStopped');
    this.recordedBytes = Math.max(this.recordedBytes, recordedBytes);
    this.pump();
  }

  /** The Recording stopped; the Recording File is `finalSize` long and will not grow. */
  recordingStopped(finalSize: number): void {
    this.recordedBytes = finalSize;
    this.isLive = false;
    this.pump();
  }

  snapshot(): RecordingUploadSnapshot {
    return {
      status: this.status,
      recordedBytes: this.recordedBytes,
      committedOffset: this.committedOffset,
      isLive: this.isLive,
    };
  }

  /** Resolves once the upload is `completed` or `failed`. */
  settled(): Promise<UploadStatus> {
    if (isSettled(this.status)) return Promise.resolve(this.status);
    return new Promise((resolve) => this.settledWaiters.push(resolve));
  }

  private dispatch(event: UploadEvent): void {
    const next = transition(this.status, event);
    if (next === this.status) return;
    const changed = next.state !== this.status.state;
    this.status = next;
    if (changed) this.options.onStateChange?.(next);
    if (isSettled(next)) {
      for (const resolve of this.settledWaiters.splice(0)) resolve(next);
    }
  }

  /** Sends Chunks, one at a time, until there is nothing to send right now. */
  private pump(): void {
    if (this.pumping || !this.target) return;
    this.pumping = true;
    this.sendChunks(this.target)
      .catch((error: unknown) => {
        // Ticket 05 replaces this with retry / backoff (spec §5.4).
        this.fail({ code: 'unknown', message: errorMessage(error) });
      })
      .finally(() => {
        this.pumping = false;
        // Growth or a stop reported after the loop's last check.
        if (isSending(this.status) && this.nextChunk()) this.pump();
      });
  }

  private async sendChunks(target: UploadTarget): Promise<void> {
    while (isSending(this.status)) {
      const chunk = this.nextChunk();
      if (!chunk) return;
      if (chunk.isFinal) this.dispatch({ type: 'finalChunkStarted' });

      const reply = await this.protocol.sendChunk(
        target,
        this.options.filePath,
        chunk
      );
      switch (reply.type) {
        case 'committed':
          this.setCommittedOffset(reply.committedOffset);
          break;
        case 'complete':
          this.setCommittedOffset(this.recordedBytes);
          this.dispatch({ type: 'uploadCompleted' });
          return;
        case 'rejected':
          // Ticket 05 maps statuses to retry / urlRejected (spec §5.4).
          this.fail({
            code: 'unknown',
            httpStatus: reply.httpStatus,
            message: `Upload URL answered ${reply.httpStatus}`,
          });
          return;
      }
    }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
