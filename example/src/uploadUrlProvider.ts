import type { UploadTarget, UploadUrlProvider } from '@thivatm/rn-camera';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * An `UploadUrlProvider` that asks the developer's own backend for an Upload
 * URL. The backend creates a Mux direct upload and replies `{ url }`; the app
 * never holds Mux credentials.
 *
 * Request: `POST <backendUrl>` with JSON `{ recordingId, metadata }`.
 */
export function createUploadUrlProvider(
  backendUrl: string,
  fetchImpl: Fetch = fetch
): UploadUrlProvider {
  return async ({ recordingId, metadata }) => {
    const response = await fetchImpl(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingId, metadata }),
    });
    if (!response.ok) {
      throw new Error(`Upload URL backend replied HTTP ${response.status}`);
    }
    const body: Partial<UploadTarget> = await response.json();
    if (typeof body.url !== 'string' || body.url.length === 0) {
      throw new Error('Upload URL backend reply has no "url"');
    }
    return body.headers
      ? { url: body.url, headers: body.headers }
      : { url: body.url };
  };
}
