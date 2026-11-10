// Upload state machine (spec §5.6). Pure: no I/O.
import type { PauseReason, UploadError, UploadState } from '../types';

export type UploadStatus = {
  state: UploadState;
  pauseReason?: PauseReason;
  error?: UploadError;
};

export type UploadEvent =
  /** The Upload URL Provider returned an Upload Target. */
  | { type: 'uploadTargetReceived' }
  /** The Upload URL Provider threw or rejected. */
  | { type: 'uploadUrlProviderFailed'; message: string }
  /** The Recording stopped and the final Chunk is being sent. */
  | { type: 'finalChunkStarted' }
  /** Upload Complete (the Upload URL answered `200`/`201`). */
  | { type: 'uploadCompleted' }
  | { type: 'uploadFailed'; error: UploadError };

export const INITIAL_UPLOAD_STATUS: UploadStatus = { state: 'waitingForUrl' };

/**
 * The status after `event`. Throws when `event` cannot happen in the current
 * state: that is an engine bug, not a runtime condition.
 */
export function transition(
  status: UploadStatus,
  event: UploadEvent
): UploadStatus {
  switch (status.state) {
    case 'waitingForUrl':
      if (event.type === 'uploadTargetReceived') return { state: 'uploading' };
      if (event.type === 'uploadUrlProviderFailed') {
        return {
          state: 'failed',
          error: { code: 'urlProviderFailed', message: event.message },
        };
      }
      break;
    case 'uploading':
    case 'finalizing':
      if (event.type === 'finalChunkStarted') return { state: 'finalizing' };
      if (event.type === 'uploadCompleted' && status.state === 'finalizing') {
        return { state: 'completed' };
      }
      if (event.type === 'uploadFailed') {
        return { state: 'failed', error: event.error };
      }
      break;
    case 'paused':
    case 'completed':
    case 'failed':
      break;
  }
  throw new Error(`Invalid upload transition: ${status.state} + ${event.type}`);
}
