/**
 * @jest-environment node
 */
// Persistence and relaunch (spec §4 "app killed mid-capture", §6). A
// "relaunch" is a second manager over a copy of the first one's key/value
// store, taken at the moment the app is "killed".
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
import { createRecordingUploads } from '../RecordingUploadsManager';
import type { UploadTarget } from '../../types';

const MIB = 1024 * 1024;
const OFFLINE = { isConnected: false, networkType: 'none' } as const;

// Top-level boxes of the fixture: see engine/__tests__/fragmentedMp4.test.ts.
const FIXTURE = path.join(
  __dirname,
  '../../engine/__fixtures__/fragmented.mp4'
);
const SECOND_FRAGMENT_END = 17580;

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function until(condition: () => boolean) {
  for (let i = 0; i < 400 && !condition(); i++) await tick();
  expect(condition()).toBe(true);
}

function bytes(length: number, seed: number) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = (i * 7 + seed) % 251;
  return buf;
}

let server: MockResumableServer;
let dir: string;
beforeEach(async () => {
  server = await startMockResumableServer();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-camera-persist-'));
});
afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** An app process: a manager over the Node seam and a key/value store. */
function launch(kv = new Map<string, string>()) {
  const platform = createNodePlatform(undefined, kv);
  const uploads = createRecordingUploads({
    transport: createNodeTransport(),
    platform,
  });
  return {
    uploads,
    kv,
    /**
     * Kills this process: what it persisted so far is what the next launch
     * sees. Going offline stops its engines from sending anything more.
     */
    kill() {
      const persisted = new Map(kv);
      platform.setConnectivity(OFFLINE);
      return persisted;
    },
  };
}

/** Waits for pending key/value writes. */
const settleWrites = () => tick(30);

const provider = (target: UploadTarget) => async () => target;
const failingProvider = async (): Promise<UploadTarget> => {
  throw new Error('provider must not be called');
};

describe('relaunch after the app was killed mid-capture', () => {
  test('the Live Recording comes back interrupted, truncated to its last complete Fragment, and uploads on resumeUploads', async () => {
    const { id, url } = server.createUpload();
    const filePath = path.join(dir, 'rec.mp4');
    // Killed in the middle of writing the third Fragment.
    fs.writeFileSync(filePath, fs.readFileSync(FIXTURE).subarray(0, 20000));

    const first = launch();
    first.uploads.registerLiveRecording({
      recordingId: 'rec-1',
      filePath,
      options: { uploadUrlProvider: provider({ url }), metadata: { n: 1 } },
    });
    first.uploads.reportFileGrowth('rec-1', 20000);
    await settleWrites();

    const second = launch(first.kill());
    const states: unknown[] = [];
    second.uploads.addListener('uploadStateChange', (e) => states.push(e));

    expect(await second.uploads.getRecordings()).toEqual([
      expect.objectContaining({
        id: 'rec-1',
        metadata: { n: 1 },
        isLive: false,
        interrupted: true,
        filePath,
        recordedBytes: SECOND_FRAGMENT_END,
        committedOffset: 0,
        uploadState: 'paused',
        pauseReason: 'awaitingResume',
      }),
    ]);
    expect(fs.statSync(filePath).size).toBe(SECOND_FRAGMENT_END);
    expect(second.uploads.liveRecordingId()).toBeNull();

    // Nothing happens until resumeUploads.
    await tick(50);
    expect(server.getUpload(id).requests).toHaveLength(0);

    await second.uploads.resumeUploads({ uploadUrlProvider: failingProvider });
    await until(() => states.length === 3);

    expect(server.getUpload(id).complete).toBe(true);
    expect(
      server
        .getUpload(id)
        .bytes.equals(fs.readFileSync(FIXTURE).subarray(0, SECOND_FRAGMENT_END))
    ).toBe(true);
    expect(server.getUpload(id).requests[0]!.kind).toBe('statusQuery');
    expect(states).toEqual([
      { recordingId: 'rec-1', metadata: { n: 1 }, state: 'uploading' },
      { recordingId: 'rec-1', metadata: { n: 1 }, state: 'finalizing' },
      { recordingId: 'rec-1', metadata: { n: 1 }, state: 'completed' },
    ]);
  });
});

describe('an Interrupted Recording whose server holds as much as the repaired file, or more', () => {
  const CHUNK = 256 * 1024;
  /**
   * Two complete Fragments, then a third whose `moof` was cut short: its
   * header claims more bytes than were written. `length` bytes in all.
   */
  function killedMidFragment(length: number) {
    const buf = Buffer.alloc(length);
    fs.readFileSync(FIXTURE).copy(buf, 0, 0, SECOND_FRAGMENT_END);
    buf.writeUInt32BE(0x7fffffff, SECOND_FRAGMENT_END);
    buf.write('moof', SECOND_FRAGMENT_END + 4, 'latin1');
    return buf;
  }

  /** Records `content` live until the server committed `committed` bytes. */
  async function recordUntilCommitted(
    content: Buffer,
    committed: number,
    persistBeforeCommit: boolean
  ) {
    const { id, url } = server.createUpload();
    const filePath = path.join(dir, 'rec.mp4');
    fs.writeFileSync(filePath, content);
    const first = launch();
    first.uploads.registerLiveRecording({
      recordingId: 'rec-1',
      filePath,
      options: { uploadUrlProvider: provider({ url }), minChunkSize: CHUNK },
    });
    await settleWrites();
    const early = new Map(first.kv);
    first.uploads.reportFileGrowth('rec-1', content.length);
    await until(() => server.getUpload(id).committedOffset === committed);
    await settleWrites();
    const persisted = first.kill();
    return { id, filePath, persisted: persistBeforeCommit ? early : persisted };
  }

  test('server Committed Offset == repaired size: the upload completes by resending the last byte as the final Chunk', async () => {
    const content = killedMidFragment(2 * CHUNK + 1000);
    const { id, filePath, persisted } = await recordUntilCommitted(
      content,
      2 * CHUNK,
      false
    );

    const second = launch(persisted);
    expect(await second.uploads.getRecordings()).toEqual([
      expect.objectContaining({
        interrupted: true,
        recordedBytes: 2 * CHUNK,
        committedOffset: 2 * CHUNK,
      }),
    ]);
    expect(fs.statSync(filePath).size).toBe(2 * CHUNK);

    await second.uploads.resumeUploads({ uploadUrlProvider: failingProvider });
    await until(() => server.getUpload(id).complete);

    const upload = server.getUpload(id);
    expect(upload.total).toBe(2 * CHUNK);
    expect(upload.bytes.equals(content.subarray(0, 2 * CHUNK))).toBe(true);
    expect(upload.requests.at(-1)!.contentRange).toBe(
      `bytes ${2 * CHUNK - 1}-${2 * CHUNK - 1}/${2 * CHUNK}`
    );
    await until(
      () =>
        JSON.parse(second.kv.get('rnCamera.uploads.recording.rec-1') ?? '{}')
          .status?.state === 'completed'
    );
  });

  test('server Committed Offset > repaired size: the upload fails with `unknown`', async () => {
    const content = killedMidFragment(2 * CHUNK + 1000);
    // The app was killed before it persisted the server's Committed Offset,
    // so the repair cuts the file below what the server holds.
    const { id, filePath, persisted } = await recordUntilCommitted(
      content,
      2 * CHUNK,
      true
    );

    const second = launch(persisted);
    await second.uploads.getRecordings();
    expect(fs.statSync(filePath).size).toBe(SECOND_FRAGMENT_END);
    const errors: unknown[] = [];
    second.uploads.addListener('uploadError', (e) => errors.push(e.error));

    await second.uploads.resumeUploads({ uploadUrlProvider: failingProvider });
    await until(() => errors.length === 1);

    expect(errors[0]).toEqual({
      code: 'unknown',
      message: expect.stringMatching(/Committed Offset .* beyond/),
    });
    expect(server.getUpload(id).complete).toBe(false);
    expect(await second.uploads.getRecordings()).toEqual([
      expect.objectContaining({ uploadState: 'failed' }),
    ]);
  });

  test('the Committed Offset is persisted after every server-confirmed Chunk', async () => {
    const content = killedMidFragment(3 * CHUNK + 1000);
    const { id, url } = server.createUpload();
    const filePath = path.join(dir, 'rec.mp4');
    fs.writeFileSync(filePath, content);
    const first = launch();
    const offsets = new Set<number>();
    const kvSet = first.kv.set.bind(first.kv);
    first.kv.set = (key, value) => {
      if (key === 'rnCamera.uploads.recording.rec-1') {
        offsets.add(JSON.parse(value).committedOffset);
      }
      return kvSet(key, value);
    };
    first.uploads.registerLiveRecording({
      recordingId: 'rec-1',
      filePath,
      options: { uploadUrlProvider: provider({ url }), minChunkSize: CHUNK },
    });
    for (const size of [CHUNK + 1, 2 * CHUNK + 1, 3 * CHUNK + 1]) {
      first.uploads.reportFileGrowth('rec-1', size);
      await until(() => server.getUpload(id).committedOffset === size - 1);
    }
    await settleWrites();
    expect([...offsets]).toEqual([0, CHUNK, 2 * CHUNK, 3 * CHUNK]);
  });
});

describe('state survives a relaunch', () => {
  test('a stopped Recording resumes from the server Committed Offset, with the stored headers', async () => {
    // Slow enough that each 8 MiB Chunk takes about 200 ms.
    const { id, url } = server.createUpload({ bytesPerSecond: 40 * MIB });
    const filePath = path.join(dir, 'rec.mp4');
    const content = bytes(20 * MIB + 123, 3);
    fs.writeFileSync(filePath, content);

    const first = launch();
    first.uploads.registerLiveRecording({
      recordingId: 'rec-1',
      filePath,
      options: {
        uploadUrlProvider: provider({ url, headers: { 'x-token': 'secret' } }),
        allowCellular: false,
        keepRecordingFile: false,
        minChunkSize: 512 * 1024,
      },
    });
    first.uploads.reportRecordingStopped('rec-1', {
      finalSize: content.length,
      reason: 'user',
    });
    await until(() => server.getUpload(id).committedOffset === 8 * MIB);
    await settleWrites();
    const persisted = new Map(first.kv);

    // The server commits more after the last write the app persisted.
    await until(() => server.getUpload(id).committedOffset === 16 * MIB);
    first.kill();
    await tick(20);
    const requestsBefore = server.getUpload(id).requests.length;

    const second = launch(persisted);
    expect(await second.uploads.getRecordings()).toEqual([
      expect.objectContaining({
        id: 'rec-1',
        isLive: false,
        interrupted: false,
        stopReason: 'user',
        recordedBytes: content.length,
        committedOffset: 8 * MIB,
        uploadState: 'paused',
        pauseReason: 'awaitingResume',
        allowCellular: false,
        keepRecordingFile: false,
      }),
    ]);

    await second.uploads.resumeUploads({ uploadUrlProvider: failingProvider });
    await until(() => server.getUpload(id).complete);

    const upload = server.getUpload(id);
    expect(upload.bytes.equals(content)).toBe(true);
    const resumed = upload.requests.slice(requestsBefore);
    expect(resumed[0]!.kind).toBe('statusQuery');
    expect(resumed[1]!.contentRange).toMatch(new RegExp(`^bytes ${16 * MIB}-`));
    expect(resumed.every((r) => r.headers['x-token'] === 'secret')).toBe(true);
  });

  test('a finished Recording keeps its stop reason and is not interrupted', async () => {
    const { url } = server.createUpload();
    const filePath = path.join(dir, 'rec.mp4');
    fs.writeFileSync(filePath, fs.readFileSync(FIXTURE));

    const first = launch();
    first.uploads.registerLiveRecording({
      recordingId: 'rec-1',
      filePath,
      options: { uploadUrlProvider: provider({ url }) },
    });
    first.kill(); // offline: the upload pauses, nothing is sent
    first.uploads.reportRecordingStopped('rec-1', {
      finalSize: fs.statSync(filePath).size,
      reason: 'backgrounded',
    });
    await settleWrites();

    const second = launch(new Map(first.kv));
    expect(await second.uploads.getRecordings()).toEqual([
      expect.objectContaining({
        isLive: false,
        interrupted: false,
        stopReason: 'backgrounded',
        recordedBytes: fs.readFileSync(FIXTURE).length,
        uploadState: 'paused',
        pauseReason: 'awaitingResume',
      }),
    ]);
    // A Finished Recording's file is not truncated.
    expect(fs.statSync(filePath).size).toBe(fs.readFileSync(FIXTURE).length);
  });

  test('completed and failed uploads keep their state; resumeUploads leaves them alone', async () => {
    const done = server.createUpload();
    const doneFile = path.join(dir, 'done.mp4');
    fs.writeFileSync(doneFile, bytes(1000, 1));
    const rejected = server.createUpload({ expired: 410 });
    const failedFile = path.join(dir, 'failed.mp4');
    fs.writeFileSync(failedFile, bytes(1000, 2));

    const first = launch();
    first.uploads.registerLiveRecording({
      recordingId: 'done',
      filePath: doneFile,
      options: { uploadUrlProvider: provider({ url: done.url }) },
    });
    first.uploads.reportRecordingStopped('done', {
      finalSize: 1000,
      reason: 'user',
    });
    first.uploads.registerLiveRecording({
      recordingId: 'failed',
      filePath: failedFile,
      options: { uploadUrlProvider: provider({ url: rejected.url }) },
    });
    first.uploads.reportRecordingStopped('failed', {
      finalSize: 1000,
      reason: 'user',
    });
    await until(() => server.getUpload(done.id).complete);
    await until(() => server.getUpload(rejected.id).requests.length > 0);
    await settleWrites();

    const second = launch(first.kill());
    await second.uploads.resumeUploads({ uploadUrlProvider: failingProvider });
    await tick(50);

    const recordings = await second.uploads.getRecordings();
    expect(recordings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'done',
          uploadState: 'completed',
          committedOffset: 1000,
          recordedBytes: 1000,
        }),
        expect.objectContaining({
          id: 'failed',
          uploadState: 'failed',
          error: expect.objectContaining({
            code: 'urlRejected',
            httpStatus: 410,
          }),
        }),
      ])
    );
    expect(recordings).toHaveLength(2);
    expect(server.getUpload(done.id).requests).toHaveLength(1);
    expect(server.getUpload(rejected.id).requests).toHaveLength(1);
  });

  test('a Recording that never got an Upload Target asks the provider on resumeUploads', async () => {
    const { id, url } = server.createUpload();
    const filePath = path.join(dir, 'rec.mp4');
    fs.writeFileSync(filePath, fs.readFileSync(FIXTURE));

    const first = launch();
    first.uploads.registerLiveRecording({
      recordingId: 'rec-1',
      filePath,
      options: {
        uploadUrlProvider: () => new Promise<UploadTarget>(() => {}),
        metadata: { n: 2 },
      },
    });
    first.uploads.reportRecordingStopped('rec-1', {
      finalSize: fs.statSync(filePath).size,
      reason: 'user',
    });
    await settleWrites();

    const second = launch(first.kill());
    expect(await second.uploads.getRecordings()).toEqual([
      expect.objectContaining({
        uploadState: 'paused',
        pauseReason: 'awaitingResume',
      }),
    ]);
    const asked: unknown[] = [];
    await second.uploads.resumeUploads({
      uploadUrlProvider: async (ctx) => {
        asked.push(ctx);
        return { url };
      },
    });
    await until(() => server.getUpload(id).complete);

    expect(asked).toEqual([{ recordingId: 'rec-1', metadata: { n: 2 } }]);
    expect(server.getUpload(id).bytes.equals(fs.readFileSync(FIXTURE))).toBe(
      true
    );
  });

  test('deleteRecording removes the stored state', async () => {
    const filePath = path.join(dir, 'rec.mp4');
    fs.writeFileSync(filePath, bytes(1000, 1));
    const first = launch();
    first.uploads.registerLiveRecording({
      recordingId: 'rec-1',
      filePath,
      options: {
        uploadUrlProvider: provider({
          url: server.createUpload().url,
          headers: { authorization: 'Bearer secret' },
        }),
      },
    });
    first.uploads.reportRecordingStopped('rec-1', {
      finalSize: 1000,
      reason: 'user',
    });
    await first.uploads.deleteRecording('rec-1');
    await settleWrites();

    expect([...first.kv.values()].join()).not.toContain('secret');
    const second = launch(first.kill());
    expect(await second.uploads.getRecordings()).toEqual([]);
  });
});
