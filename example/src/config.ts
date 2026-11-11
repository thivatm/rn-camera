import { Platform } from 'react-native';
import { createUploadUrlProvider } from './uploadUrlProvider';

/**
 * Your backend endpoint that creates an Upload URL. It receives
 * `POST { recordingId, metadata }` and replies `{ url }` (plus optional
 * `headers`). See `example/backend/mux-upload-url.mjs` for a Mux version.
 *
 * The default points at the repo's mock resumable server
 * (`yarn mock-server`), which answers `POST /__control/uploads` with `{ url }`.
 * Android emulators reach the host machine at 10.0.2.2. On a real device use
 * your machine's LAN address or a deployed backend.
 */
export const UPLOAD_URL_ENDPOINT = Platform.select({
  android: 'http://10.0.2.2:8787/__control/uploads',
  default: 'http://localhost:8787/__control/uploads',
});

export const uploadUrlProvider = createUploadUrlProvider(UPLOAD_URL_ENDPOINT);
