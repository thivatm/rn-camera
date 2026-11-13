/**
 * @jest-environment node
 */
import http from 'node:http';
import { startMockResumableServer, type MockResumableServer } from '../server';

const KIB = 1024;

type Reply = { status: number; headers: http.IncomingHttpHeaders };

function put(url: string, contentRange: string, body = Buffer.alloc(0)) {
    return new Promise<Reply>((resolve, reject) => {
        const req = http.request(
            url,
            {
                method: 'PUT',
                headers: {
                    'Content-Range': contentRange,
                    'Content-Length': body.length,
                },
            },
            (res) => {
                res.resume();
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                    })
                );
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

function bytes(length: number, seed = 0) {
    const buf = Buffer.alloc(length);
    for (let i = 0; i < length; i++) buf[i] = (i + seed) % 251;
    return buf;
}

let server: MockResumableServer;
beforeEach(async () => {
    server = await startMockResumableServer();
});
afterEach(async () => {
    await server.close();
});

describe('§5.1 protocol', () => {
    test('a Chunk is answered 308 with the committed Range', async () => {
        const { url } = server.createUpload();
        const reply = await put(
            url,
            `bytes 0-${256 * KIB - 1}/*`,
            bytes(256 * KIB)
        );
        expect(reply.status).toBe(308);
        expect(reply.headers.range).toBe('bytes=0-262143');
    });

    test('a final Chunk completes the upload with 200 and the bytes match the source', async () => {
        const source = bytes(256 * KIB + 1000);
        const { id, url } = server.createUpload();
        await put(url, 'bytes 0-262143/*', source.subarray(0, 256 * KIB));
        const reply = await put(
            url,
            `bytes 262144-263143/263144`,
            source.subarray(256 * KIB)
        );
        expect(reply.status).toBe(200);
        const upload = server.getUpload(id);
        expect(upload.complete).toBe(true);
        expect(upload.total).toBe(263144);
        expect(upload.bytes.equals(source)).toBe(true);
    });

    test('an upload can be configured to complete with 201', async () => {
        const { url } = server.createUpload({ completeStatus: 201 });
        const reply = await put(url, 'bytes 0-9/10', bytes(10));
        expect(reply.status).toBe(201);
    });

    test('status query before any bytes: 308 with no Range', async () => {
        const { url } = server.createUpload();
        const reply = await put(url, 'bytes */*');
        expect(reply.status).toBe(308);
        expect(reply.headers.range).toBeUndefined();
    });

    test('status query mid-upload: 308 with Range bytes=0-N', async () => {
        const { url } = server.createUpload();
        await put(url, 'bytes 0-524287/*', bytes(512 * KIB));
        const reply = await put(url, 'bytes */*');
        expect(reply.status).toBe(308);
        expect(reply.headers.range).toBe('bytes=0-524287');
    });

    test('status query after Upload Complete: 200 (or the configured 201)', async () => {
        const a = server.createUpload();
        await put(a.url, 'bytes 0-9/10', bytes(10));
        expect((await put(a.url, 'bytes */*')).status).toBe(200);

        const b = server.createUpload({ completeStatus: 201 });
        await put(b.url, 'bytes 0-9/10', bytes(10));
        expect((await put(b.url, 'bytes */*')).status).toBe(201);
    });

    test('a non-final Chunk that is not a multiple of 256 KiB is rejected with 400', async () => {
        const { id, url } = server.createUpload();
        const reply = await put(url, 'bytes 0-999/*', bytes(1000));
        expect(reply.status).toBe(400);
        expect(server.getUpload(id).committedOffset).toBe(0);
    });

    test('bytes below the Committed Offset are ignored when resent', async () => {
        const source = bytes(512 * KIB + 10);
        const { id, url } = server.createUpload();
        await put(url, 'bytes 0-262143/*', source.subarray(0, 256 * KIB));
        // Resend from 0, overlapping what is already committed.
        const reply = await put(
            url,
            'bytes 0-524287/*',
            source.subarray(0, 512 * KIB)
        );
        expect(reply.headers.range).toBe('bytes=0-524287');
        await put(
            url,
            'bytes 524288-524297/524298',
            source.subarray(512 * KIB)
        );
        expect(server.getUpload(id).bytes.equals(source)).toBe(true);
    });

    test('a Chunk that starts beyond the Committed Offset is rejected with 400', async () => {
        const { url } = server.createUpload();
        const reply = await put(url, 'bytes 262144-524287/*', bytes(256 * KIB));
        expect(reply.status).toBe(400);
    });

    test('a body that does not match Content-Range is rejected with 400', async () => {
        const { url } = server.createUpload();
        expect((await put(url, 'bytes 0-262143/*', bytes(10))).status).toBe(
            400
        );
    });

    test('a missing or malformed Content-Range is rejected with 400', async () => {
        const { url } = server.createUpload();
        expect((await put(url, 'garbage')).status).toBe(400);
    });

    test('an unknown Upload URL is 404', async () => {
        const reply = await put(`${server.url}/upload/nope`, 'bytes */*');
        expect(reply.status).toBe(404);
    });

    test('every request is logged with its headers', async () => {
        const { id, url } = server.createUpload();
        await put(url, 'bytes */*');
        expect(server.getUpload(id).requests).toEqual([
            expect.objectContaining({
                contentRange: 'bytes */*',
                status: 308,
                bodyLength: 0,
                headers: expect.objectContaining({
                    'content-range': 'bytes */*',
                }),
            }),
        ]);
    });
});

describe('fault injection', () => {
    test('dropped connection: no reply and nothing committed', async () => {
        const { id, url } = server.createUpload({ faults: [{ type: 'drop' }] });
        await expect(
            put(url, 'bytes 0-262143/*', bytes(256 * KIB))
        ).rejects.toThrow();
        expect(server.getUpload(id).committedOffset).toBe(0);
        // One-shot: the next request goes through.
        expect((await put(url, 'bytes */*')).status).toBe(308);
    });

    test('dropped connection after commit: the reply is lost but the bytes are committed', async () => {
        const { id, url } = server.createUpload({
            faults: [{ type: 'drop', commit: true }],
        });
        await expect(
            put(url, 'bytes 0-262143/*', bytes(256 * KIB))
        ).rejects.toThrow();
        expect(server.getUpload(id).committedOffset).toBe(256 * KIB);
        expect((await put(url, 'bytes */*')).headers.range).toBe(
            'bytes=0-262143'
        );
    });

    test.each([503, 408, 429])(
        '%i is returned once and nothing is committed',
        async (status) => {
            const { id, url } = server.createUpload({
                faults: [{ type: 'status', status }],
            });
            const chunk = bytes(256 * KIB);
            expect((await put(url, 'bytes 0-262143/*', chunk)).status).toBe(
                status
            );
            expect(server.getUpload(id).committedOffset).toBe(0);
            expect((await put(url, 'bytes 0-262143/*', chunk)).status).toBe(
                308
            );
        }
    );

    test('faults target Chunks by default and skip status queries', async () => {
        const { url } = server.createUpload({
            faults: [{ type: 'status', status: 503 }],
        });
        expect((await put(url, 'bytes */*')).status).toBe(308);
        expect((await put(url, 'bytes 0-9/10', bytes(10))).status).toBe(503);
    });

    test('a fault can target status queries', async () => {
        const { url } = server.createUpload({
            faults: [{ type: 'status', status: 503, on: 'statusQuery' }],
        });
        expect((await put(url, 'bytes 0-9/10', bytes(10))).status).toBe(200);
        expect((await put(url, 'bytes */*')).status).toBe(503);
    });

    test('faults are consumed in order', async () => {
        const { url } = server.createUpload({
            faults: [
                { type: 'status', status: 503 },
                { type: 'status', status: 429 },
            ],
        });
        const chunk = bytes(256 * KIB);
        expect((await put(url, 'bytes 0-262143/*', chunk)).status).toBe(503);
        expect((await put(url, 'bytes 0-262143/*', chunk)).status).toBe(429);
        expect((await put(url, 'bytes 0-262143/*', chunk)).status).toBe(308);
    });

    test.each([404, 410] as const)(
        'URL expiry: every request gets %i until cleared',
        async (status) => {
            const { id, url } = server.createUpload();
            await put(url, 'bytes 0-262143/*', bytes(256 * KIB));
            server.configure(id, { expired: status });
            expect(
                (await put(url, 'bytes 262144-524287/*', bytes(256 * KIB)))
                    .status
            ).toBe(status);
            expect((await put(url, 'bytes */*')).status).toBe(status);
            expect(server.getUpload(id).committedOffset).toBe(256 * KIB);
            server.configure(id, { expired: null });
            expect((await put(url, 'bytes */*')).status).toBe(308);
        }
    );

    test('partial commit: fewer bytes committed than sent, reported in Range', async () => {
        const source = bytes(512 * KIB);
        const { id, url } = server.createUpload({
            faults: [{ type: 'partialCommit', bytes: 100_000 }],
        });
        const reply = await put(url, 'bytes 0-524287/*', source);
        expect(reply.status).toBe(308);
        expect(reply.headers.range).toBe('bytes=0-99999');
        expect(
            server.getUpload(id).bytes.equals(source.subarray(0, 100_000))
        ).toBe(true);
    });

    test('partial commit of a final Chunk leaves the upload incomplete', async () => {
        const source = bytes(1000);
        const { id, url } = server.createUpload({
            faults: [{ type: 'partialCommit', bytes: 600 }],
        });
        const reply = await put(url, 'bytes 0-999/1000', source);
        expect(reply.status).toBe(308);
        expect(reply.headers.range).toBe('bytes=0-599');
        expect(server.getUpload(id).complete).toBe(false);
        // The client resends from the Committed Offset and completes.
        expect(
            (await put(url, 'bytes 600-999/1000', source.subarray(600))).status
        ).toBe(200);
        expect(server.getUpload(id).bytes.equals(source)).toBe(true);
    });

    test('slow throughput: the body is read at the configured rate', async () => {
        const { url } = server.createUpload({ bytesPerSecond: 512 * KIB });
        const started = Date.now();
        const reply = await put(url, 'bytes 0-262143/*', bytes(256 * KIB));
        expect(reply.status).toBe(308);
        expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    });
});

async function control(method: string, path: string, json?: unknown) {
    return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
        const req = http.request(
            `${server.url}${path}`,
            { method, headers: { 'Content-Type': 'application/json' } },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        body: Buffer.concat(chunks),
                    })
                );
            }
        );
        req.on('error', reject);
        req.end(json === undefined ? undefined : JSON.stringify(json));
    });
}

describe('HTTP control endpoint', () => {
    test('create, fault, upload, inspect and read back bytes', async () => {
        const created = await control('POST', '/__control/uploads', {
            id: 'rec-1',
            faults: [{ type: 'status', status: 503 }],
        });
        expect(created.status).toBe(201);
        const { id, url } = JSON.parse(created.body.toString());
        expect(id).toBe('rec-1');
        expect(url).toBe(`${server.url}/upload/rec-1`);

        const source = bytes(1000);
        expect((await put(url, 'bytes 0-999/1000', source)).status).toBe(503);
        await control('PATCH', '/__control/uploads/rec-1', {
            completeStatus: 201,
        });
        expect((await put(url, 'bytes 0-999/1000', source)).status).toBe(201);

        const info = await control('GET', '/__control/uploads/rec-1');
        expect(JSON.parse(info.body.toString())).toMatchObject({
            id: 'rec-1',
            committedOffset: 1000,
            complete: true,
            total: 1000,
            requests: [
                { kind: 'finalChunk', status: 503, fault: 'status' },
                { kind: 'finalChunk', status: 201, fault: null },
            ],
        });

        const stored = await control('GET', '/__control/uploads/rec-1/bytes');
        expect(stored.body.equals(source)).toBe(true);
    });

    test('Upload URLs use the Host the control request was sent to', async () => {
        const created = await new Promise<string>((resolve, reject) => {
            const req = http.request(
                `${server.url}/__control/uploads`,
                { method: 'POST', headers: { Host: '10.0.2.2:8787' } },
                (res) => {
                    let body = '';
                    res.on('data', (c) => (body += c));
                    res.on('end', () => resolve(body));
                }
            );
            req.on('error', reject);
            req.end();
        });
        expect(JSON.parse(created).url).toBe('http://10.0.2.2:8787/upload/u1');
    });

    test('reset forgets every upload', async () => {
        const { url } = server.createUpload();
        expect((await control('POST', '/__control/reset')).status).toBe(204);
        expect((await put(url, 'bytes */*')).status).toBe(404);
    });

    test('unknown upload is 404', async () => {
        expect((await control('GET', '/__control/uploads/x')).status).toBe(404);
    });
});
