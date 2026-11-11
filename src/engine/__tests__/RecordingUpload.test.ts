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
import { createNodeTransport } from '../__fixtures__/nodeTransport';
import { RecordingUpload } from '../RecordingUpload';
import type { ChunkRequest, Transport } from '../transport';
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-camera-engine-'));
  filePath = path.join(dir, 'recording.mp4');
  fs.writeFileSync(filePath, Buffer.alloc(0));
});
afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Appends to the Recording File and returns its new size. */
function append(buf: Buffer) {
  fs.appendFileSync(filePath, buf);
  return fs.statSync(filePath).size;
}

/** Counts concurrent `sendChunk` calls to check one request is in flight. */
function observed(transport: Transport) {
  const stats = { inFlight: 0, maxInFlight: 0, requests: [] as ChunkRequest[] };
  const wrapped: Transport = {
    async sendChunk(request) {
      stats.requests.push(request);
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        return await transport.sendChunk(request);
      } finally {
        stats.inFlight--;
      }
    },
    cancelChunk: (url) => transport.cancelChunk(url),
  };
  return { transport: wrapped, stats };
}

test('uploads a Recording File that grows while uploading, byte for byte', async () => {
  const { id, url } = server.createUpload({ bytesPerSecond: 40 * MIB });
  const { transport, stats } = observed(createNodeTransport());
  const states: UploadState[] = [];
  const upload = new RecordingUpload({
    recordingId: 'rec-1',
    filePath,
    uploadUrlProvider: async () => ({
      url,
      headers: { 'x-upload-token': 'secret' },
    }),
    transport,
    onStateChange: (status) => states.push(status.state),
  });
  upload.start();

  // ~11 MiB in uneven appends (like Fragments), interleaved with uploading.
  for (let i = 0; i < 40; i++) {
    upload.fileGrew(append(bytes(277 * KIB + i * 13, i)));
    await tick();
  }
  const finalSize = append(bytes(3 * KIB + 17, 99));
  upload.recordingStopped(finalSize);

  const status = await upload.settled();
  expect(status).toEqual({ state: 'completed' });
  expect(states).toEqual(['uploading', 'finalizing', 'completed']);

  const record = server.getUpload(id);
  expect(record.complete).toBe(true);
  expect(record.total).toBe(finalSize);
  expect(record.bytes.equals(fs.readFileSync(filePath))).toBe(true);
  expect(upload.snapshot().committedOffset).toBe(finalSize);

  expect(stats.maxInFlight).toBe(1);
  expect(stats.requests.length).toBeGreaterThan(2);
  for (const entry of record.requests) {
    expect(entry.headers['x-upload-token']).toBe('secret');
  }
  // Only the last request is the final Chunk; the rest are 308s.
  const kinds = record.requests.map((r) => r.kind);
  expect(kinds.pop()).toBe('finalChunk');
  expect(new Set(kinds)).toEqual(new Set(['chunk']));
});

test('the Backlog builds up while waiting for the Upload URL', async () => {
  const { id, url } = server.createUpload();
  let provide!: (target: { url: string }) => void;
  const upload = new RecordingUpload({
    recordingId: 'rec-2',
    filePath,
    uploadUrlProvider: () => new Promise((resolve) => (provide = resolve)),
    transport: createNodeTransport(),
  });
  upload.start();
  upload.fileGrew(append(bytes(3 * MIB + 5, 1)));
  await tick();
  expect(upload.snapshot().status).toEqual({ state: 'waitingForUrl' });
  expect(server.getUpload(id).requests).toHaveLength(0);

  provide({ url });
  upload.recordingStopped(append(bytes(10, 2)));
  expect(await upload.settled()).toEqual({ state: 'completed' });
  expect(server.getUpload(id).bytes.equals(fs.readFileSync(filePath))).toBe(
    true
  );
});

test('the Committed Offset comes from the server, not from bytes sent', async () => {
  const { id, url } = server.createUpload({
    faults: [{ type: 'partialCommit', bytes: 256 * KIB }],
  });
  const upload = new RecordingUpload({
    recordingId: 'rec-3',
    filePath,
    uploadUrlProvider: async () => ({ url }),
    transport: createNodeTransport(),
  });
  upload.start();
  const size = append(bytes(2 * MIB, 3));
  upload.recordingStopped(size);
  expect(await upload.settled()).toEqual({ state: 'completed' });
  expect(server.getUpload(id).bytes.equals(fs.readFileSync(filePath))).toBe(
    true
  );
  const ranges = server.getUpload(id).requests.map((r) => r.contentRange);
  // The final Chunk was cut short by the server, so it is resent from 256 KiB.
  expect(ranges).toEqual([
    `bytes 0-${2 * MIB - 1}/${2 * MIB}`,
    `bytes ${256 * KIB}-${2 * MIB - 1}/${2 * MIB}`,
  ]);
});

test('a throwing Upload URL Provider fails with urlProviderFailed', async () => {
  const upload = new RecordingUpload({
    recordingId: 'rec-4',
    filePath,
    uploadUrlProvider: async () => {
      throw new Error('backend down');
    },
    transport: createNodeTransport(),
  });
  upload.start();
  expect(await upload.settled()).toEqual({
    state: 'failed',
    error: { code: 'urlProviderFailed', message: 'backend down' },
  });
  // The Recording continues regardless.
  expect(() => upload.fileGrew(append(bytes(10, 4)))).not.toThrow();
  expect(upload.snapshot().recordedBytes).toBe(10);
});

test('a Finished Recording (Upload Queue) uploads in Chunks of up to 8 MiB', async () => {
  const { id, url } = server.createUpload();
  const size = append(bytes(17 * MIB + 3, 5));
  const upload = new RecordingUpload({
    recordingId: 'rec-5',
    filePath,
    uploadUrlProvider: async () => ({ url }),
    transport: createNodeTransport(),
    finishedSize: size,
  });
  upload.start();
  expect(await upload.settled()).toEqual({ state: 'completed' });
  expect(server.getUpload(id).requests.map((r) => r.bodyLength)).toEqual([
    8 * MIB,
    8 * MIB,
    MIB + 3,
  ]);
});
