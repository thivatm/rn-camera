/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    startMockResumableServer,
    type MockResumableServer,
} from '../../../mock-server/server';
import {
    createNodePlatform,
    createNodeTransport,
} from '../__fixtures__/nodeTransport';
import {
    RecordingUpload,
    type RecordingUploadOptions,
} from '../RecordingUpload';
import { TransportError, type Transport } from '../transport';
import type { UploadState } from '../../types';

const KIB = 1024;
const MIB = 1024 * KIB;

function bytes(length: number, seed: number) {
    const buf = Buffer.alloc(length);
    for (let i = 0; i < length; i++) buf[i] = (i * 7 + seed) % 251;
    return buf;
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

let server: MockResumableServer;
let dir: string;
let filePath: string;

beforeEach(async () => {
    server = await startMockResumableServer();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-camera-retry-'));
    filePath = path.join(dir, 'recording.mp4');
});
afterEach(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake clock: records each backoff delay and fires it on the next turn of
 * the event loop instead of waiting. With `manual`, timers wait for `fire()`.
 */
function fakeClock({ manual = false } = {}) {
    const delays: number[] = [];
    const pending: Array<() => void> = [];
    let cancelledCount = 0;
    return {
        delays,
        get pending() {
            return pending.length;
        },
        get cancelled() {
            return cancelledCount;
        },
        /** Fires every pending timer. */
        fire() {
            for (const run of pending.splice(0)) run();
        },
        schedule(callback: () => void, ms: number) {
            delays.push(ms);
            let cancelled = false;
            const run = () => {
                if (!cancelled) callback();
            };
            if (manual) pending.push(run);
            else setImmediate(run);
            return () => {
                if (!cancelled) cancelledCount++;
                cancelled = true;
                const index = pending.indexOf(run);
                if (index >= 0) pending.splice(index, 1);
            };
        },
    };
}

/** Appends to the Recording File and returns its new size. */
function append(buf: Buffer) {
    fs.appendFileSync(filePath, buf);
    return fs.statSync(filePath).size;
}

/** Polls until `condition` holds. */
async function until(condition: () => boolean) {
    for (let i = 0; i < 400 && !condition(); i++) await tick();
    expect(condition()).toBe(true);
}

/** A Finished Recording of `size` bytes, uploaded with a fake clock. */
function finishedUpload(
    url: string,
    size: number,
    extra: Partial<RecordingUploadOptions> = {},
    clock = fakeClock()
) {
    fs.writeFileSync(filePath, bytes(size, size % 13));
    const states: UploadState[] = [];
    const upload = new RecordingUpload({
        recordingId: 'rec',
        filePath,
        uploadUrlProvider: async () => ({ url }),
        transport: createNodeTransport(),
        finishedSize: size,
        schedule: clock.schedule,
        random: () => 0.5,
        onStateChange: (status) => states.push(status.state),
        ...extra,
    });
    return { upload, clock, states };
}

function expectServerHasFile(id: string) {
    const record = server.getUpload(id);
    expect(record.complete).toBe(true);
    expect(record.bytes.equals(fs.readFileSync(filePath))).toBe(true);
}

const kinds = (id: string) => server.getUpload(id).requests.map((r) => r.kind);

describe('retryable failures: backoff, status query, resend', () => {
    test.each([503, 500, 408, 429])(
        'a %i on a Chunk is retried after a status query',
        async (status) => {
            const { id, url } = server.createUpload({
                faults: [{ type: 'status', status }],
            });
            const { upload, clock } = finishedUpload(url, 3 * MIB);
            upload.start();
            expect(await upload.settled()).toEqual({ state: 'completed' });
            expectServerHasFile(id);
            expect(clock.delays).toHaveLength(1);
            expect(kinds(id)).toEqual([
                'finalChunk',
                'statusQuery',
                'finalChunk',
            ]);
        }
    );

    test('a dropped connection is a network error: retried, byte for byte', async () => {
        const { id, url } = server.createUpload({ faults: [{ type: 'drop' }] });
        const { upload, clock } = finishedUpload(url, 3 * MIB + 7);
        upload.start();
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expectServerHasFile(id);
        expect(clock.delays).toEqual([1000]);
        expect(kinds(id)).toEqual(['finalChunk', 'statusQuery', 'finalChunk']);
    });

    test('a lost reply: the status query finds the Chunk committed and moves on', async () => {
        const { id, url } = server.createUpload({
            faults: [{ type: 'drop', commit: true }],
        });
        const { upload } = finishedUpload(url, 8 * MIB + 5);
        upload.start();
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expectServerHasFile(id);
        expect(
            server.getUpload(id).requests.map((r) => r.contentRange)
        ).toEqual([
            `bytes 0-${8 * MIB - 1}/*`,
            'bytes */*',
            `bytes ${8 * MIB}-${8 * MIB + 4}/${8 * MIB + 5}`,
        ]);
    });

    test('a lost reply to the final Chunk: the status query finds Upload Complete', async () => {
        const { id, url } = server.createUpload({
            faults: [{ type: 'drop', commit: true }],
        });
        const { upload, states } = finishedUpload(url, MIB + 5);
        upload.start();
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expectServerHasFile(id);
        expect(kinds(id)).toEqual(['finalChunk', 'statusQuery']);
        expect(states).toEqual(['uploading', 'finalizing', 'completed']);
        expect(upload.snapshot().committedOffset).toBe(MIB + 5);
    });

    test('a partial commit of a Chunk resends from the Committed Offset', async () => {
        const { id, url } = server.createUpload({
            faults: [{ type: 'partialCommit', bytes: 512 * KIB }],
        });
        const size = 8 * MIB + 5;
        const { upload } = finishedUpload(url, size);
        upload.start();
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expectServerHasFile(id);
        expect(
            server.getUpload(id).requests.map((r) => r.contentRange)
        ).toEqual([
            `bytes 0-${8 * MIB - 1}/*`,
            `bytes ${512 * KIB}-${size - 1}/${size}`,
        ]);
    });

    test('failures of the status query itself are retried with growing delays', async () => {
        const { id, url } = server.createUpload({
            faults: [
                { type: 'status', status: 503 },
                { type: 'drop', on: 'statusQuery' },
                { type: 'status', status: 502, on: 'statusQuery' },
            ],
        });
        const { upload, clock } = finishedUpload(url, 2 * MIB);
        upload.start();
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expectServerHasFile(id);
        expect(clock.delays).toEqual([1000, 2000, 4000]);
        expect(kinds(id)).toEqual([
            'finalChunk',
            'statusQuery',
            'statusQuery',
            'statusQuery',
            'finalChunk',
        ]);
    });

    test('a successful Chunk resets the backoff', async () => {
        const { id, url } = server.createUpload({
            faults: [
                { type: 'status', status: 503 },
                { type: 'status', status: 503 },
            ],
        });
        // Two Chunks: 8 MiB fails twice, then the final one fails once.
        let injected = false;
        const { upload, clock } = finishedUpload(url, 9 * MIB, {
            onCommittedOffsetChange: ({ committedOffset }) => {
                if (committedOffset === 8 * MIB && !injected) {
                    injected = true;
                    server.configure(id, {
                        faults: [{ type: 'status', status: 503 }],
                    });
                }
            },
        });
        upload.start();
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expectServerHasFile(id);
        expect(clock.delays).toEqual([1000, 2000, 1000]);
    });
});

describe('other server behaviour', () => {
    test('201 for Upload Complete completes', async () => {
        const { id, url } = server.createUpload({ completeStatus: 201 });
        const { upload } = finishedUpload(url, MIB + 1);
        upload.start();
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expectServerHasFile(id);
    });

    test('a slow Live Recording upload survives a mix of faults, byte for byte', async () => {
        const { id, url } = server.createUpload({
            bytesPerSecond: 64 * MIB,
            faults: [
                { type: 'drop', commit: true },
                { type: 'status', status: 503, on: 'statusQuery' },
                { type: 'partialCommit', bytes: 256 * KIB },
                { type: 'status', status: 429 },
                { type: 'drop' },
            ],
        });
        fs.writeFileSync(filePath, Buffer.alloc(0));
        const upload = new RecordingUpload({
            recordingId: 'rec',
            filePath,
            uploadUrlProvider: async () => ({ url }),
            transport: createNodeTransport(),
            schedule: fakeClock().schedule,
        });
        upload.start();
        for (let i = 0; i < 25; i++) {
            upload.fileGrew(append(bytes(301 * KIB + i, i)));
            await tick();
        }
        upload.recordingStopped(append(bytes(9, 9)));
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expectServerHasFile(id);
        const faults = server.getUpload(id).requests.filter((r) => r.fault);
        expect(faults).toHaveLength(5);
    });
});

describe('offline', () => {
    const OFFLINE = { isConnected: false, networkType: 'none' } as const;
    const WIFI = { isConnected: true, networkType: 'wifi' } as const;

    test('going offline mid-Chunk pauses; coming back resumes from the Committed Offset', async () => {
        const { id, url } = server.createUpload({ bytesPerSecond: 32 * MIB });
        const platform = createNodePlatform(WIFI);
        let goOffline = false;
        const { upload, states } = finishedUpload(url, 9 * MIB, {
            platform,
            onCommittedOffsetChange: ({ committedOffset }) => {
                if (committedOffset === 8 * MIB) goOffline = true;
            },
        });
        upload.start();
        await until(() => goOffline);
        platform.setConnectivity(OFFLINE);
        expect(upload.snapshot().status).toEqual({
            state: 'paused',
            pauseReason: 'offline',
        });
        await tick(50);
        const requestsWhileOffline = server.getUpload(id).requests.length;
        await tick(50);
        expect(server.getUpload(id).requests).toHaveLength(
            requestsWhileOffline
        );
        expect(server.getUpload(id).complete).toBe(false);

        platform.setConnectivity(WIFI);
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expectServerHasFile(id);
        expect(states).toEqual([
            'uploading',
            'finalizing',
            'paused',
            'uploading',
            'finalizing',
            'completed',
        ]);
        // The resumed loop asks where the server got to before resending.
        const log = kinds(id).slice(requestsWhileOffline);
        expect(log[0]).toBe('statusQuery');
    });

    test('offline when the Upload Target arrives: paused, nothing sent until online', async () => {
        const { id, url } = server.createUpload();
        const platform = createNodePlatform(OFFLINE);
        const { upload } = finishedUpload(url, MIB, { platform });
        upload.start();
        await until(() => upload.snapshot().status.state === 'paused');
        expect(upload.snapshot().status.pauseReason).toBe('offline');
        await tick(20);
        expect(server.getUpload(id).requests).toHaveLength(0);
        platform.setConnectivity(WIFI);
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expectServerHasFile(id);
    });

    test('going offline during a backoff wait cancels it', async () => {
        const { id, url } = server.createUpload({
            faults: [{ type: 'status', status: 503 }],
        });
        const platform = createNodePlatform(WIFI);
        const clock = fakeClock({ manual: true });
        const { upload } = finishedUpload(url, MIB, { platform }, clock);
        upload.start();
        await until(() => clock.pending === 1);
        platform.setConnectivity(OFFLINE);
        expect(clock.cancelled).toBe(1);
        expect(upload.snapshot().status.state).toBe('paused');
        platform.setConnectivity(WIFI);
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expectServerHasFile(id);
    });
});

describe('Recording File missing or empty', () => {
    test('a missing Recording File fails with fileMissing', async () => {
        const { id, url } = server.createUpload();
        const { upload, clock } = finishedUpload(url, MIB);
        fs.rmSync(filePath);
        upload.start();
        expect(await upload.settled()).toMatchObject({
            state: 'failed',
            error: { code: 'fileMissing' },
        });
        expect(clock.delays).toEqual([]);
        expect(server.getUpload(id).complete).toBe(false);
    });

    test('a Recording stopped at 0 bytes whose file is gone fails with fileMissing', async () => {
        const { url } = server.createUpload();
        const upload = new RecordingUpload({
            recordingId: 'rec',
            filePath,
            uploadUrlProvider: async () => ({ url }),
            transport: createNodeTransport(),
            platform: createNodePlatform(),
        });
        upload.start();
        upload.recordingStopped(0);
        expect(await upload.settled()).toMatchObject({
            state: 'failed',
            error: { code: 'fileMissing' },
        });
    });

    test('an empty Recording cannot be uploaded: it fails instead of hanging', async () => {
        const { id, url } = server.createUpload();
        fs.writeFileSync(filePath, Buffer.alloc(0));
        const upload = new RecordingUpload({
            recordingId: 'rec',
            filePath,
            uploadUrlProvider: async () => ({ url }),
            transport: createNodeTransport(),
            platform: createNodePlatform(),
            finishedSize: 0,
        });
        upload.start();
        expect(await upload.settled()).toEqual({
            state: 'failed',
            error: { code: 'unknown', message: 'Recording File is empty' },
        });
        expect(server.getUpload(id).requests).toHaveLength(0);
    });
});

describe('Recording File unreadable (EIO)', () => {
    /** A Transport whose Chunks fail to read the Recording File, as native does for a short file. */
    function unreadableFileTransport(): Transport {
        const node = createNodeTransport();
        return {
            sendChunk: (request) =>
                request.end >= request.start
                    ? Promise.reject(
                          new TransportError(
                              'EIO',
                              'Recording File ended before byte 9'
                          )
                      )
                    : node.sendChunk(request),
            cancelChunk: node.cancelChunk,
        };
    }

    test('fails with unknown, without retrying, while the file is still there', async () => {
        const { url } = server.createUpload();
        const { upload, clock } = finishedUpload(url, 10, {
            transport: unreadableFileTransport(),
            platform: createNodePlatform(),
        });
        upload.start();
        expect(await upload.settled()).toEqual({
            state: 'failed',
            error: {
                code: 'unknown',
                message: 'Recording File ended before byte 9',
            },
        });
        expect(clock.delays).toEqual([]);
    });

    test('fails with fileMissing when the file is gone', async () => {
        const { url } = server.createUpload();
        const { upload } = finishedUpload(url, 10, {
            transport: unreadableFileTransport(),
            platform: createNodePlatform(),
        });
        fs.rmSync(filePath);
        upload.start();
        expect(await upload.settled()).toMatchObject({
            state: 'failed',
            error: { code: 'fileMissing' },
        });
    });
});

describe('Retry Upload', () => {
    test('after urlRejected, a fresh Upload Target restarts the upload at byte 0', async () => {
        const first = server.createUpload();
        const second = server.createUpload();
        const states: UploadState[] = [];
        const progress: number[] = [];
        fs.writeFileSync(filePath, Buffer.alloc(0));
        const upload = new RecordingUpload({
            recordingId: 'rec',
            filePath,
            uploadUrlProvider: async () => ({ url: first.url }),
            transport: createNodeTransport(),
            schedule: fakeClock().schedule,
            onStateChange: (status) => states.push(status.state),
            onCommittedOffsetChange: ({ committedOffset }) =>
                progress.push(committedOffset),
        });
        upload.start();
        upload.fileGrew(append(bytes(3 * MIB, 1)));
        await until(() => upload.snapshot().committedOffset > 0);
        server.configure(first.id, { expired: 410 });
        upload.fileGrew(append(bytes(2 * MIB, 2)));
        await upload.settled();
        expect(upload.snapshot().status.error?.code).toBe('urlRejected');

        const provider = jest.fn(async () => ({ url: second.url }));
        upload.retryUpload(provider);
        expect(upload.snapshot()).toMatchObject({
            status: { state: 'waitingForUrl' },
            committedOffset: 0,
        });
        upload.recordingStopped(append(bytes(17, 3)));
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expect(provider).toHaveBeenCalledWith({ recordingId: 'rec' });
        expectServerHasFile(second.id);
        expect(server.getUpload(second.id).requests[0]?.contentRange).toMatch(
            /^bytes 0-/
        );
        expect(states).toEqual([
            'uploading',
            'failed',
            'waitingForUrl',
            'uploading',
            'finalizing',
            'completed',
        ]);
        expect(progress[progress.indexOf(0, 1)]).toBe(0);
    });

    test('without a new provider, Retry Upload asks the original one again', async () => {
        const first = server.createUpload({ expired: 404 });
        const second = server.createUpload();
        const urls = [first.url, second.url];
        const { upload } = finishedUpload(first.url, MIB, {
            uploadUrlProvider: async () => ({ url: urls.shift()! }),
        });
        upload.start();
        expect((await upload.settled()).state).toBe('failed');
        upload.retryUpload();
        expect(await upload.settled()).toEqual({ state: 'completed' });
        expectServerHasFile(second.id);
    });

    test('a provider failure on retry fails with urlProviderFailed', async () => {
        const { url } = server.createUpload({ expired: 410 });
        const { upload } = finishedUpload(url, MIB);
        upload.start();
        await upload.settled();
        upload.retryUpload(async () => {
            throw new Error('no more URLs');
        });
        expect(await upload.settled()).toEqual({
            state: 'failed',
            error: { code: 'urlProviderFailed', message: 'no more URLs' },
        });
    });

    test('Retry Upload does nothing unless the upload failed', async () => {
        const { url } = server.createUpload();
        const provider = jest.fn(async () => ({ url }));
        const { upload } = finishedUpload(url, MIB, {
            uploadUrlProvider: provider,
        });
        upload.start();
        upload.retryUpload();
        expect(await upload.settled()).toEqual({ state: 'completed' });
        upload.retryUpload();
        expect(upload.snapshot().status).toEqual({ state: 'completed' });
        expect(provider).toHaveBeenCalledTimes(1);
    });
});

describe('URL rejected', () => {
    test.each([404, 410] as const)(
        'an expired Upload URL (%i) fails with urlRejected at once',
        async (status) => {
            const { id, url } = server.createUpload({ expired: status });
            const { upload, clock } = finishedUpload(url, MIB);
            upload.start();
            expect(await upload.settled()).toEqual({
                state: 'failed',
                error: {
                    code: 'urlRejected',
                    httpStatus: status,
                    message: `Upload URL answered ${status}`,
                },
            });
            expect(clock.delays).toEqual([]);
            expect(kinds(id)).toEqual(['finalChunk']);
        }
    );

    test('any other 4xx fails with urlRejected', async () => {
        const { url } = server.createUpload({
            faults: [{ type: 'status', status: 403 }],
        });
        const { upload } = finishedUpload(url, MIB);
        upload.start();
        expect(await upload.settled()).toMatchObject({
            state: 'failed',
            error: { code: 'urlRejected', httpStatus: 403 },
        });
    });

    test('a URL that expires during a retry fails at the status query', async () => {
        const { id, url } = server.createUpload({ faults: [{ type: 'drop' }] });
        const clock = fakeClock({ manual: true });
        const { upload } = finishedUpload(url, MIB, {}, clock);
        upload.start();
        await until(() => clock.pending === 1);
        server.configure(id, { expired: 410 });
        clock.fire();
        expect(await upload.settled()).toMatchObject({
            state: 'failed',
            error: { code: 'urlRejected', httpStatus: 410 },
        });
        expect(kinds(id)).toEqual(['finalChunk', 'statusQuery']);
    });
});
