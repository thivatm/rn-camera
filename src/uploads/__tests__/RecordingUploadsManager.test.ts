/**
 * @jest-environment node
 */
/// <reference types="node" />
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
} from '../../engine/__fixtures__/nodeTransport';
import {
  createRecordingUploads,
  type UploadErrorEvent,
} from '../RecordingUploadsManager';
import type { Metadata } from '../../types';

const MIB = 1024 * 1024;

function bytes(length: number, seed: number) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = (i * 7 + seed) % 251;
  return buf;
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function until(condition: () => boolean) {
  for (let i = 0; i < 400 && !condition(); i++) await tick();
  expect(condition()).toBe(true);
}

let server: MockResumableServer;
let dir: string;

beforeEach(async () => {
  server = await startMockResumableServer();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-camera-uploads-'));
});
afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A manager over the Node seam. */
function manager(
  overrides: Partial<Parameters<typeof createRecordingUploads>[0]> = {}
) {
  const platform = createNodePlatform();
  const uploads = createRecordingUploads({
    transport: createNodeTransport(),
    platform,
    ...overrides,
  });
  return { uploads, platform };
}

function newFile(name = 'rec.mp4') {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, '');
  return filePath;
}

describe('getRecordings', () => {
  test('a registered Live Recording is listed as a §3.1 Recording with defaults', async () => {
    const { uploads } = manager({ now: () => Date.UTC(2026, 0, 1) });
    const { url } = server.createUpload();
    const filePath = newFile();
    uploads.registerLiveRecording({
      recordingId: 'rec-1',
      filePath,
      options: {
        uploadUrlProvider: async () => ({ url }),
        metadata: { title: 'hello' },
      },
    });
    await tick(20);

    expect(await uploads.getRecordings()).toEqual([
      {
        id: 'rec-1',
        metadata: { title: 'hello' },
        isLive: true,
        interrupted: false,
        filePath,
        recordedBytes: 0,
        committedOffset: 0,
        uploadState: 'uploading',
        keepRecordingFile: true,
        allowCellular: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });
});

/** Appends `length` bytes to the Recording File and returns its new size. */
function append(filePath: string, length: number, seed = 1) {
  fs.appendFileSync(filePath, bytes(length, seed));
  return fs.statSync(filePath).size;
}

describe('capture-facing API and events', () => {
  test('growth and stop upload the file; state and progress events carry metadata', async () => {
    const { uploads } = manager();
    const { id, url } = server.createUpload();
    const filePath = newFile();
    const states: unknown[] = [];
    const progress: unknown[] = [];
    uploads.addListener('uploadStateChange', (e) => states.push(e));
    uploads.addListener('uploadProgress', (e) => progress.push(e));

    uploads.registerLiveRecording({
      recordingId: 'rec-1',
      filePath,
      options: {
        uploadUrlProvider: async () => ({ url }),
        metadata: { n: 1 },
      },
    });
    uploads.reportFileGrowth('rec-1', append(filePath, 2 * MIB + 3));
    await until(() => server.getUpload(id).committedOffset === 2 * MIB);
    uploads.reportRecordingStopped('rec-1', {
      finalSize: append(filePath, 10),
      reason: 'user',
    });
    await until(() => states.length === 3);

    expect(server.getUpload(id).complete).toBe(true);
    expect(states).toEqual([
      { recordingId: 'rec-1', metadata: { n: 1 }, state: 'uploading' },
      { recordingId: 'rec-1', metadata: { n: 1 }, state: 'finalizing' },
      { recordingId: 'rec-1', metadata: { n: 1 }, state: 'completed' },
    ]);
    await until(() => progress.length > 0);
    await tick(300); // let the throttle deliver the trailing event
    expect(progress[progress.length - 1]).toEqual({
      recordingId: 'rec-1',
      metadata: { n: 1 },
      recordedBytes: 2 * MIB + 13,
      committedOffset: 2 * MIB + 13,
    });
    const [recording] = await uploads.getRecordings();
    expect(recording).toMatchObject({
      isLive: false,
      stopReason: 'user',
      uploadState: 'completed',
      committedOffset: 2 * MIB + 13,
    });
  });
});

/** A Recording of `size` bytes, registered and stopped right away. */
function stoppedRecording(
  uploads: ReturnType<typeof manager>['uploads'],
  recordingId: string,
  uploadUrlProvider: () => Promise<{ url: string }>,
  { size = MIB + 5, metadata }: { size?: number; metadata?: Metadata } = {}
) {
  const filePath = newFile(`${recordingId}.mp4`);
  uploads.registerLiveRecording({
    recordingId,
    filePath,
    options: { uploadUrlProvider, metadata },
  });
  uploads.reportRecordingStopped(recordingId, {
    finalSize: append(filePath, size),
    reason: 'user',
  });
  return filePath;
}

async function stateOf(
  uploads: ReturnType<typeof manager>['uploads'],
  recordingId: string
) {
  const recordings = await uploads.getRecordings();
  return recordings.find((r) => r.id === recordingId)?.uploadState;
}

describe('uploadError and retryUpload', () => {
  test('a failing provider sends uploadError; retryUpload uploads with the new provider', async () => {
    const { uploads } = manager();
    const errors: UploadErrorEvent[] = [];
    uploads.addListener('uploadError', (e) => errors.push(e));
    stoppedRecording(
      uploads,
      'rec-1',
      async () => {
        throw new Error('backend down');
      },
      { metadata: { n: 2 } }
    );
    await until(() => errors.length === 1);
    expect(errors[0]).toEqual({
      recordingId: 'rec-1',
      metadata: { n: 2 },
      error: { code: 'urlProviderFailed', message: 'backend down' },
    });
    expect((await uploads.getRecordings())[0]).toMatchObject({
      uploadState: 'failed',
      error: { code: 'urlProviderFailed' },
    });

    const { id, url } = server.createUpload();
    await uploads.retryUpload('rec-1', {
      uploadUrlProvider: async () => ({ url }),
    });
    await until(() => server.getUpload(id).complete);
    await tick(20);
    const [recording] = await uploads.getRecordings();
    expect(recording?.uploadState).toBe('completed');
    expect(recording?.error).toBeUndefined();
  });

  test('a 4xx from the Upload URL is a urlRejected uploadError', async () => {
    const { uploads } = manager();
    const errors: UploadErrorEvent[] = [];
    uploads.addListener('uploadError', (e) => errors.push(e));
    const { url } = server.createUpload({ expired: 410 });
    stoppedRecording(uploads, 'rec-1', async () => ({ url }));
    await until(() => errors.length === 1);
    expect(errors[0]?.error).toMatchObject({
      code: 'urlRejected',
      httpStatus: 410,
    });
  });

  test('retryUpload rejects for an unknown Recording', async () => {
    const { uploads } = manager();
    await expect(
      uploads.retryUpload('nope', {
        uploadUrlProvider: async () => ({ url: 'http://x' }),
      })
    ).rejects.toThrow('Unknown Recording nope');
  });
});

describe('deleteRecording', () => {
  test('cancels an upload in progress and removes the file and the Recording', async () => {
    const { uploads } = manager();
    const { id, url } = server.createUpload({ bytesPerSecond: 256 * 1024 });
    const events: unknown[] = [];
    uploads.addListener('uploadStateChange', (e) => events.push(e));
    uploads.addListener('uploadProgress', (e) => events.push(e));
    const filePath = stoppedRecording(uploads, 'rec-1', async () => ({ url }), {
      size: 4 * MIB,
    });
    await until(() => server.getUpload(id).requests.length > 0);

    await uploads.deleteRecording('rec-1');
    expect(fs.existsSync(filePath)).toBe(false);
    expect(await uploads.getRecordings()).toEqual([]);
    const seen = events.length;
    const requests = server.getUpload(id).requests.length;
    await tick(400);
    expect(events).toHaveLength(seen);
    expect(server.getUpload(id).requests).toHaveLength(requests);
    expect(server.getUpload(id).complete).toBe(false);
  });

  test('removes a completed Recording, leaving the others', async () => {
    const { uploads } = manager();
    const a = server.createUpload();
    const b = server.createUpload();
    const fileA = stoppedRecording(uploads, 'a', async () => ({ url: a.url }));
    stoppedRecording(uploads, 'b', async () => ({ url: b.url }));
    await until(() => server.getUpload(a.id).complete);
    await until(() => server.getUpload(b.id).complete);
    await tick(20);
    expect(await stateOf(uploads, 'a')).toBe('completed');

    await uploads.deleteRecording('a');
    expect(fs.existsSync(fileA)).toBe(false);
    expect((await uploads.getRecordings()).map((r) => r.id)).toEqual(['b']);
  });

  test('rejects for the Live Recording and for an unknown id', async () => {
    const { uploads } = manager();
    const { url } = server.createUpload();
    const filePath = newFile();
    uploads.registerLiveRecording({
      recordingId: 'live',
      filePath,
      options: { uploadUrlProvider: async () => ({ url }) },
    });
    await expect(uploads.deleteRecording('live')).rejects.toThrow(
      'Recording live is live'
    );
    expect(fs.existsSync(filePath)).toBe(true);
    await expect(uploads.deleteRecording('nope')).rejects.toThrow(
      'Unknown Recording nope'
    );
  });
});

/** A manual clock: `advance(ms)` moves time and fires the timers that are due. */
function manualClock() {
  let time = 0;
  let timers: Array<{ at: number; run: () => void }> = [];
  return {
    now: () => time,
    schedule(callback: () => void, ms: number) {
      const timer = { at: time + ms, run: callback };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    advance(ms: number) {
      time += ms;
      const due = timers.filter((t) => t.at <= time);
      timers = timers.filter((t) => t.at > time);
      for (const t of due) t.run();
    },
  };
}

/** A Live Recording whose provider never answers, so only growth moves progress. */
function pendingLiveRecording(
  uploads: ReturnType<typeof manager>['uploads'],
  recordingId: string
) {
  uploads.registerLiveRecording({
    recordingId,
    filePath: newFile(`${recordingId}.mp4`),
    options: { uploadUrlProvider: () => new Promise(() => {}) },
  });
}

describe('uploadProgress throttling (§5.5)', () => {
  test('at most one event per 250 ms per Recording; the latest values arrive at the window end', () => {
    const clock = manualClock();
    const { uploads } = manager({ now: clock.now, schedule: clock.schedule });
    const events: Array<{ recordingId: string; recordedBytes: number }> = [];
    uploads.addListener('uploadProgress', (e) => events.push(e));
    pendingLiveRecording(uploads, 'a');
    pendingLiveRecording(uploads, 'b');

    uploads.reportFileGrowth('a', 100);
    uploads.reportFileGrowth('b', 1);
    clock.advance(100);
    uploads.reportFileGrowth('a', 200);
    clock.advance(100);
    uploads.reportFileGrowth('a', 300);
    expect(events).toEqual([
      expect.objectContaining({ recordingId: 'a', recordedBytes: 100 }),
      expect.objectContaining({ recordingId: 'b', recordedBytes: 1 }),
    ]);

    clock.advance(49);
    expect(events).toHaveLength(2);
    clock.advance(1);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({ recordingId: 'a', recordedBytes: 300 });

    clock.advance(1000);
    expect(events).toHaveLength(3);
    uploads.reportFileGrowth('a', 400);
    expect(events).toHaveLength(4);
  });
});

describe('addListener', () => {
  test('a removed listener gets no more events; others still do', async () => {
    const { uploads } = manager();
    const removed: unknown[] = [];
    const kept: unknown[] = [];
    const subscriptions = [
      uploads.addListener('uploadStateChange', (e) => removed.push(e)),
      uploads.addListener('uploadProgress', (e) => removed.push(e)),
      uploads.addListener('uploadError', (e) => removed.push(e)),
    ];
    uploads.addListener('uploadError', (e) => kept.push(e));
    for (const s of subscriptions) s.remove();

    stoppedRecording(uploads, 'rec-1', async () => {
      throw new Error('no');
    });
    await until(() => kept.length === 1);
    expect(removed).toEqual([]);
  });
});

describe('resumeUploads', () => {
  test('resolves (stub until relaunch support)', async () => {
    const { uploads } = manager();
    await expect(
      uploads.resumeUploads({ uploadUrlProvider: async () => ({ url: '' }) })
    ).resolves.toBeUndefined();
  });
});
