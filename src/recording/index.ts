import { getNativePlatform, getRecordingUploadsManager } from '../uploads';
import { LiveRecordings } from './LiveRecordings';

let liveRecordings: LiveRecordings | null = null;

/** The app-wide coordinator: at most one Live Recording across all cameras. */
export function getLiveRecordings(): LiveRecordings {
  if (!liveRecordings) {
    // Native modules are looked up lazily: they throw where not linked.
    liveRecordings = new LiveRecordings({
      events: () => require('../specs/NativeStreamingCameraRecorder').default,
      uploads: getRecordingUploadsManager,
      freeDiskSpace: () => getNativePlatform().getFreeDiskSpace(),
    });
  }
  return liveRecordings;
}

export {
  LiveRecordings,
  RecordingError,
  LOW_STORAGE_BYTES,
  type RecordingErrorCode,
  type RecordingStoppedInfo,
} from './LiveRecordings';
