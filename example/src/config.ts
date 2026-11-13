import { Platform } from 'react-native';
import { createUploadUrlProvider } from './uploadUrlProvider';

/**
 * The URL of your backend that creates an Upload URL. It receives
 * `POST { recordingId, metadata }` and replies `{ url }` (plus optional
 * `headers`).
 *
 * The default points at the repo's mock resumable server
 * (`yarn mock-server`), which answers `POST /__control/uploads` with `{ url }`.
 * Android emulators reach the host machine at 10.0.2.2. On a real device use
 * your machine's LAN address or a deployed backend.
 */
export const UPLOAD_URL_BACKEND = Platform.select({
    ios: 'http://localhost:3000/uploads',
    android: 'http://10.0.2.2:8787/__control/uploads',
    default: 'http://localhost:8787/__control/uploads',
});

export const uploadUrlProvider = createUploadUrlProvider(UPLOAD_URL_BACKEND);
