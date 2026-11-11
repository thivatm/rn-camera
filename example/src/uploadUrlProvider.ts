import type { UploadTarget, UploadUrlProvider } from '@thivatm/rn-camera';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * An `UploadUrlProvider` that asks the developer's own backend for an Upload
 * URL. The backend creates a Mux direct upload and replies `{ url }`; the app
 * never holds Mux credentials.
 *
 * Request: `POST <endpoint>` with JSON `{ recordingId, metadata }`.
 */
export function createUploadUrlProvider(
  endpoint: string,
  fetchImpl: Fetch = fetch
): UploadUrlProvider {
  return async ({ recordingId, metadata }) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingId, metadata }),
    });
    if (!response.ok) {
      throw new Error(`Upload URL endpoint replied HTTP ${response.status}`);
    }
    const body: Partial<UploadTarget> = await response.json();
    if (typeof body.url !== 'string' || body.url.length === 0) {
      throw new Error('Upload URL endpoint reply has no "url"');
    }
    return body.headers
      ? { url: body.url, headers: body.headers }
      : { url: body.url };
  };
}
