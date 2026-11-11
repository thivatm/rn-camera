/**
 * @jest-environment node
 */
// Upload Queue scheduling (spec §5.5) and file retention (§7), with the
// network type and app state injected.
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
import type { ConnectivityState } from '../../engine/transport';
import {
  createRecordingUploads,
  type AppStateSource,
} from '../RecordingUploadsManager';
import type { StartRecordingOptions, UploadTarget } from '../../types';

const MIB = 1024 * 1024;
const WIFI: ConnectivityState = { isConnected: true, networkType: 'wifi' };
const CELLULAR: ConnectivityState = {
  isConnected: true,
  networkType: 'cellular',
};
const OTHER: ConnectivityState = { isConnected: true, networkType: 'other' };
const OFFLINE: ConnectivityState = { isConnected: false, networkType: 'none' };

// Waits are on conditions (a state, a server record), never on elapsed time,
// so a slow machine only makes a test slower. The deadline is a safety net
// below Jest's timeout, to fail with a clear assertion.
jest.setTimeout(60_000);
const DEADLINE_MS = 45_000;

const nextTurn = () => new Promise((r) => setTimeout(r, 1));

async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + DEADLINE_MS;
  while (!(await condition()) && Date.now() < deadline) await nextTurn();
  expect(await condition()).toBe(true);
}

/**
 * Lets a wrong implementation send what it should not, for a check that
 * nothing happened. Passing never depends on it: a correct one sends nothing
 * however long this is.
 */
const quietPeriod = () => new Promise((r) => setTimeout(r, 100));

/**
 * The requests to `uploadId` from index `from` on, apart from a Chunk that
 * was cut short (`dropped`, e.g. the one in flight when the upload paused).
 */
const answeredRequestsSince = (uploadId: string, from: number) =>
  server
    .getUpload(uploadId)
    .requests.slice(from)
    .filter((r) => r.status !== 'dropped');

function bytes(length: number, seed: number) {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = (i * 7 + seed) % 251;
  return buf;
}

let server: MockResumableServer;
let dir: string;
beforeEach(async () => {
  server = await startMockResumableServer();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-camera-sched-'));
});
afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for React Native's `AppState`, driven by the test. */
function fakeAppState(initial = 'active') {
  const listeners = new Set<(state: string) => void>();
  const appState = {
    currentState: initial,
    addEventListener(_type: 'change', listener: (state: string) => void) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    set(state: string) {
      appState.currentState = state;
      for (const listener of [...listeners]) listener(state);
    },
  };
  return appState satisfies AppStateSource;
}

function setup(
  opts: { network?: ConnectivityState; kv?: Map<string, string> } = {}
) {
  const platform = createNodePlatform(opts.network ?? WIFI, opts.kv);
  const appState = fakeAppState();
  const uploads = createRecordingUploads({
    transport: createNodeTransport(),
    platform,
    appState,
  });
  /** `${id}:${state}[/${pauseReason}]`, in order. */
  const log: string[] = [];
  const watchers: Array<{ entry: string; run: () => void }> = [];
  uploads.addListener('uploadStateChange', (e) => {
    const entry = `${e.recordingId}:${e.state}${e.pauseReason ? `/${e.pauseReason}` : ''}`;
    log.push(entry);
    for (const w of watchers.filter((x) => x.entry === entry)) w.run();
  });
  /** Captures `read()` at the moment `entry` is logged. */
  const at = <T>(entry: string, read: () => T) => {
    const captured: { value?: T } = {};
    watchers.push({ entry, run: () => (captured.value ??= read()) });
    return captured;
  };
  const statesOf = (id: string) =>
    log
      .filter((l) => l.startsWith(`${id}:`))
      .map((l) => l.slice(id.length + 1));
  const recording = async (id: string) =>
    (await uploads.getRecordings()).find((r) => r.id === id)!;
  return { uploads, platform, appState, log, at, statesOf, recording };
}

type Setup = ReturnType<typeof setup>;

/** Writes a file of `size` bytes and a server upload for it. */
function source(name: string, size: number, bytesPerSecond?: number) {
  const filePath = path.join(dir, `${name}.mp4`);
  const content = bytes(size, name.length);
  fs.writeFileSync(filePath, content);
  const upload = server.createUpload(bytesPerSecond ? { bytesPerSecond } : {});
  return { filePath, content, ...upload };
}

const provider = (target: UploadTarget) => async () => target;

/** Records `name` to its full size and stops it: it joins the Upload Queue. */
function recordAndStop(
  s: Setup,
  name: string,
  src: ReturnType<typeof source>,
  options: Partial<StartRecordingOptions> = {}
) {
  startLive(s, name, src, options);
  s.uploads.reportFileGrowth(name, src.content.length);
  s.uploads.reportRecordingStopped(name, {
    finalSize: src.content.length,
    reason: 'user',
  });
}

function startLive(
  s: Setup,
  name: string,
  src: ReturnType<typeof source>,
  options: Partial<StartRecordingOptions> = {}
) {
  s.uploads.registerLiveRecording({
    recordingId: name,
    filePath: src.filePath,
    options: { uploadUrlProvider: provider({ url: src.url }), ...options },
  });
}

describe('Live Recording priority', () => {
  test('a Live Recording deprioritizes the queued upload, which resumes once the Live Recording is uploaded', async () => {
    const s = setup();
    const a = source('a', 20 * MIB, 40 * MIB);
    recordAndStop(s, 'a', a);
    await until(() => server.getUpload(a.id).committedOffset > 0);

    const atPause = s.at(
      'a:paused/deprioritized',
      () => server.getUpload(a.id).requests.length
    );
    const atLiveDone = s.at(
      'b:completed',
      () => server.getUpload(a.id).requests.length
    );
    const b = source('b', 1000);
    startLive(s, 'b', b);
    await until(() => atPause.value !== undefined);
    await quietPeriod();

    s.uploads.reportFileGrowth('b', 1000);
    s.uploads.reportRecordingStopped('b', { finalSize: 1000, reason: 'user' });
    await until(() => s.log.includes('a:completed'));
    expect(server.getUpload(a.id).complete).toBe(true);
    // Nothing for A while B was live.
    expect(
      server
        .getUpload(a.id)
        .requests.slice(atPause.value, atLiveDone.value)
        .filter((r) => r.status !== 'dropped')
    ).toEqual([]);

    expect(server.getUpload(b.id).complete).toBe(true);
    expect(server.getUpload(a.id).bytes.equals(a.content)).toBe(true);
    expect(s.statesOf('a')).toEqual([
      'uploading',
      'paused/deprioritized',
      'uploading',
      'finalizing',
      'completed',
    ]);
    // B finished before A picked up again.
    expect(s.log.indexOf('b:completed')).toBeLessThan(
      s.log.lastIndexOf('a:uploading')
    );
  });

  test('uploads resumed while a Live Recording exists stay deprioritized', async () => {
    const kv = await persistedWithoutTargets(['a']);
    const s = setup({ kv });
    const live = source('live', 1000);
    startLive(s, 'live', live);
    const a = server.createUpload();
    const atLiveDone = s.at('live:completed', () => ({
      states: s.statesOf('a'),
      requests: server.getUpload(a.id).requests.length,
    }));
    await s.uploads.resumeUploads({ uploadUrlProvider: provider(a) });
    await until(() => s.statesOf('a').length > 0);
    await quietPeriod();

    s.uploads.reportFileGrowth('live', 1000);
    s.uploads.reportRecordingStopped('live', {
      finalSize: 1000,
      reason: 'user',
    });
    await until(() => s.log.includes('a:completed'));
    expect(server.getUpload(a.id).complete).toBe(true);
    expect(atLiveDone.value).toEqual({
      states: ['paused/deprioritized'],
      requests: 0,
    });
  });

  test('deleteRecording rejects on the Live Recording', async () => {
    const s = setup();
    startLive(s, 'live', source('live', 1000));
    await expect(s.uploads.deleteRecording('live')).rejects.toThrow(/live/);
    expect(await s.uploads.getRecordings()).toHaveLength(1);
  });
});

/**
 * A key/value store as a killed app left it: Finished Recordings `names`,
 * created in that order, none of which got an Upload Target.
 */
async function persistedWithoutTargets(
  names: string[],
  options: Partial<StartRecordingOptions> = {}
) {
  const kv = new Map<string, string>();
  const first = setup({ kv });
  for (const name of names) {
    const filePath = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(filePath, bytes(3 * MIB, name.length));
    first.uploads.registerLiveRecording({
      recordingId: name,
      filePath,
      options: {
        uploadUrlProvider: () => new Promise<UploadTarget>(() => {}),
        ...options,
      },
    });
    first.uploads.reportRecordingStopped(name, {
      finalSize: 3 * MIB,
      reason: 'user',
    });
  }
  // Every Recording is stored as stopped.
  await until(() =>
    names.every(
      (name) =>
        JSON.parse(kv.get(`rnCamera.uploads.recording.${name}`) ?? '{}')
          .isLive === false
    )
  );
  first.platform.setConnectivity(OFFLINE);
  return new Map(kv);
}

describe('Upload Queue', () => {
  test('drains FIFO, oldest first, one Recording at a time', async () => {
    const kv = await persistedWithoutTargets(['a', 'b', 'c']);
    const s = setup({ kv });
    const urls = new Map<string, { id: string; url: string }>();
    for (const name of ['a', 'b', 'c']) urls.set(name, server.createUpload());

    await s.uploads.resumeUploads({
      uploadUrlProvider: async ({ recordingId }) => ({
        url: urls.get(recordingId)!.url,
      }),
    });
    await until(() => s.log.includes('c:completed'));

    expect(s.statesOf('b')[0]).toBe('paused/deprioritized');
    expect(s.statesOf('c')[0]).toBe('paused/deprioritized');
    const at = (entry: string) => s.log.indexOf(entry);
    expect(at('a:waitingForUrl')).toBeLessThan(at('a:completed'));
    expect(at('a:completed')).toBeLessThan(at('b:waitingForUrl'));
    expect(at('b:completed')).toBeLessThan(at('c:waitingForUrl'));
  });
});

describe('app backgrounded', () => {
  test('pauses every upload as backgrounded; the foreground picks them up again, Live Recording first', async () => {
    const s = setup();
    const a = source('a', 1000);
    recordAndStop(s, 'a', a);
    const live = source('live', 20 * MIB, 40 * MIB);
    startLive(s, 'live', live);
    s.uploads.reportFileGrowth('live', 20 * MIB);
    await until(() => server.getUpload(live.id).committedOffset > 0);

    const atBackground = server.getUpload(live.id).requests.length;
    s.appState.set('background');
    expect((await s.recording('live')).pauseReason).toBe('backgrounded');
    expect((await s.recording('a')).pauseReason).toBe('backgrounded');
    await quietPeriod();
    expect(answeredRequestsSince(live.id, atBackground)).toEqual([]);
    expect(server.getUpload(a.id).requests).toHaveLength(0);

    s.appState.set('active');
    expect((await s.recording('live')).uploadState).toBe('uploading');
    expect((await s.recording('a')).pauseReason).toBe('deprioritized');

    s.uploads.reportRecordingStopped('live', {
      finalSize: 20 * MIB,
      reason: 'user',
    });
    await until(() => s.log.includes('a:completed'));
    expect(server.getUpload(a.id).complete).toBe(true);
    expect(server.getUpload(live.id).bytes.equals(live.content)).toBe(true);
  });

  test('an upload whose turn comes while backgrounded waits for the foreground', async () => {
    const s = setup();
    s.appState.set('background');
    const a = source('a', 1000);
    recordAndStop(s, 'a', a);
    await until(() => s.statesOf('a').length > 0);
    await quietPeriod();
    expect(s.statesOf('a')).toEqual(['paused/backgrounded']);
    expect(server.getUpload(a.id).requests).toHaveLength(0);

    s.appState.set('active');
    await until(() => s.log.includes('a:completed'));
    expect(server.getUpload(a.id).complete).toBe(true);
  });
});

describe('Allow Cellular = false', () => {
  const noCellular = { allowCellular: false };

  test('a running upload carries on when the network switches to cellular', async () => {
    const s = setup();
    const a = source('a', 20 * MIB, 40 * MIB);
    recordAndStop(s, 'a', a, noCellular);
    await until(() => server.getUpload(a.id).committedOffset > 0);
    s.platform.setConnectivity(CELLULAR);
    await until(() => s.log.includes('a:completed'));
    expect(server.getUpload(a.id).complete).toBe(true);
    expect(s.statesOf('a')).toEqual(['uploading', 'finalizing', 'completed']);
  });

  test('after going offline, it waits for Wi-Fi rather than restart on cellular; other networks are fine', async () => {
    const s = setup();
    const a = source('a', 20 * MIB, 40 * MIB);
    recordAndStop(s, 'a', a, noCellular);
    await until(() => server.getUpload(a.id).committedOffset > 0);

    const atOffline = server.getUpload(a.id).requests.length;
    s.platform.setConnectivity(OFFLINE);
    s.platform.setConnectivity(CELLULAR);
    expect(await s.recording('a')).toMatchObject({
      uploadState: 'paused',
      pauseReason: 'awaitingWifi',
    });
    await quietPeriod();
    expect(answeredRequestsSince(a.id, atOffline)).toEqual([]);

    s.platform.setConnectivity(OTHER);
    await until(() => s.log.includes('a:completed'));
    expect(server.getUpload(a.id).complete).toBe(true);
    expect(server.getUpload(a.id).bytes.equals(a.content)).toBe(true);
    expect(s.statesOf('a').slice(0, 4)).toEqual([
      'uploading',
      'paused/offline',
      'paused/awaitingWifi',
      'uploading',
    ]);
  });

  test('a deprioritized upload whose turn comes on cellular waits for Wi-Fi; the Live Recording uses cellular', async () => {
    const s = setup({ network: CELLULAR });
    const a = source('a', 20 * MIB, 40 * MIB);
    recordAndStop(s, 'a', a, noCellular);
    await until(() => server.getUpload(a.id).committedOffset > 0);

    const b = source('b', 1000);
    recordAndStop(s, 'b', b, noCellular);
    await until(() => s.log.includes('b:completed'));
    expect(server.getUpload(b.id).complete).toBe(true);
    await until(() => s.statesOf('a').includes('paused/awaitingWifi'));
    expect(s.statesOf('a')).toEqual([
      'uploading',
      'paused/deprioritized',
      'paused/awaitingWifi',
    ]);

    s.platform.setConnectivity(WIFI);
    await until(() => s.log.includes('a:completed'));
    expect(server.getUpload(a.id).complete).toBe(true);
  });

  test('after a relaunch, resumeUploads on cellular waits for Wi-Fi', async () => {
    const kv = await persistedWithoutTargets(['a'], noCellular);
    const s = setup({ kv, network: CELLULAR });
    const a = server.createUpload();
    await s.uploads.resumeUploads({ uploadUrlProvider: provider(a) });
    await until(() => s.statesOf('a').length > 0);
    await quietPeriod();
    expect(s.statesOf('a')).toEqual(['paused/awaitingWifi']);
    expect(server.getUpload(a.id).requests).toHaveLength(0);

    s.platform.setConnectivity(WIFI);
    await until(() => s.log.includes('a:completed'));
    expect(server.getUpload(a.id).complete).toBe(true);
  });

  test('Allow Cellular = true (default) restarts on cellular', async () => {
    const s = setup();
    const a = source('a', 20 * MIB, 40 * MIB);
    recordAndStop(s, 'a', a);
    await until(() => server.getUpload(a.id).committedOffset > 0);
    s.platform.setConnectivity(OFFLINE);
    s.platform.setConnectivity(CELLULAR);
    await until(() => s.log.includes('a:completed'));
    expect(server.getUpload(a.id).complete).toBe(true);
    expect(s.statesOf('a')).not.toContain('paused/awaitingWifi');
  });
});

describe('Keep Recording File', () => {
  test('false: the file is deleted after Upload Complete and filePath becomes null', async () => {
    const s = setup();
    const a = source('a', 1000);
    recordAndStop(s, 'a', a, { keepRecordingFile: false });
    await until(() => !fs.existsSync(a.filePath));
    expect(server.getUpload(a.id).complete).toBe(true);
    await until(async () => (await s.recording('a')).filePath === null);
    expect(await s.recording('a')).toMatchObject({ uploadState: 'completed' });
  });

  test('false: a failed upload keeps its file', async () => {
    const s = setup();
    const filePath = path.join(dir, 'a.mp4');
    fs.writeFileSync(filePath, bytes(1000, 1));
    const { url } = server.createUpload({ expired: 410 });
    recordAndStop(
      s,
      'a',
      { filePath, url, id: '', content: bytes(1000, 1) },
      { keepRecordingFile: false }
    );
    await until(() => s.log.includes('a:failed'));
    await quietPeriod();
    expect(fs.existsSync(filePath)).toBe(true);
    expect((await s.recording('a')).filePath).toBe(filePath);
  });

  test('true (default): the file stays after Upload Complete', async () => {
    const s = setup();
    const a = source('a', 1000);
    recordAndStop(s, 'a', a);
    await until(() => s.log.includes('a:completed'));
    await quietPeriod();
    expect(fs.existsSync(a.filePath)).toBe(true);
    expect((await s.recording('a')).filePath).toBe(a.filePath);
  });
});
