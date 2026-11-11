import { createUploadUrlProvider } from '../uploadUrlProvider';

function respond(status: number, body: unknown) {
  return jest.fn(
    async (_input: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status })
  );
}

describe('createUploadUrlProvider', () => {
  it('POSTs the recording to the backend and returns its Upload URL', async () => {
    const fetchImpl = respond(200, { url: 'https://storage.example/upload/1' });
    const provider = createUploadUrlProvider(
      'https://backend.example/uploads',
      fetchImpl
    );

    const target = await provider({
      recordingId: 'rec-1',
      metadata: { title: 'hello' },
    });

    expect(target).toEqual({ url: 'https://storage.example/upload/1' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://backend.example/uploads');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      recordingId: 'rec-1',
      metadata: { title: 'hello' },
    });
  });

  it('throws with the HTTP status when the backend refuses', async () => {
    const provider = createUploadUrlProvider(
      'https://backend.example/uploads',
      respond(500, { error: 'boom' })
    );

    await expect(provider({ recordingId: 'rec-1' })).rejects.toThrow(
      /HTTP 500/
    );
  });

  it('throws when the reply has no url', async () => {
    const provider = createUploadUrlProvider(
      'https://backend.example/uploads',
      respond(200, { id: 'x' })
    );

    await expect(provider({ recordingId: 'rec-1' })).rejects.toThrow(/url/);
  });

  it('passes through headers the backend returns', async () => {
    const provider = createUploadUrlProvider(
      'https://backend.example/uploads',
      respond(201, {
        url: 'https://storage.example/upload/2',
        headers: { 'x-token': 'abc' },
      })
    );

    await expect(provider({ recordingId: 'rec-2' })).resolves.toEqual({
      url: 'https://storage.example/upload/2',
      headers: { 'x-token': 'abc' },
    });
  });
});
