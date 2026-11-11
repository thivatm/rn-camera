import type { Recording } from '@thivatm/rn-camera';

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);

function progress(r: Recording): string {
  const percent =
    r.recordedBytes > 0
      ? Math.floor((r.committedOffset / r.recordedBytes) * 100)
      : 0;
  return `${percent}% (${mb(r.committedOffset)} / ${mb(r.recordedBytes)} MB)`;
}

/** One-line upload status for the Recordings list. */
export function describeUpload(r: Recording): string {
  switch (r.uploadState) {
    case 'waitingForUrl':
      return `Waiting for Upload URL (${mb(r.recordedBytes)} MB recorded)`;
    case 'uploading':
      return `Uploading ${progress(r)}`;
    case 'paused':
      return `Paused (${r.pauseReason ?? 'unknown'}) ${progress(r)}`;
    case 'finalizing':
      return `Finalizing ${progress(r)}`;
    case 'completed':
      return `Completed (${mb(r.recordedBytes)} MB)`;
    case 'failed': {
      const e = r.error;
      if (!e) return 'Failed';
      const http = e.httpStatus ? ` (HTTP ${e.httpStatus})` : '';
      return `Failed: ${e.code}${http} ${e.message}`;
    }
  }
}
