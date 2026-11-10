// Node implementation of the Transport / Platform seam, standing in for the
// native `RecordingUploads` module in Jest. Not part of the published build
// (`__fixtures__` is excluded by bob, tsconfig.build.json and package.json).
/// <reference types="node" />
import fs from 'node:fs';
import http from 'node:http';
import type {
  ChunkResponse,
  ConnectivityState,
  Platform,
  Transport,
} from '../transport';
import { TransportError } from '../transport';

export function createNodeTransport(): Transport {
  /** Cancel functions of in-flight requests, by URL. */
  const inFlight = new Map<string, () => void>();
  return {
    sendChunk({ url, headers, path, start, end, contentRange }) {
      const length = end >= start ? end - start + 1 : 0;
      return new Promise<ChunkResponse>((resolve, reject) => {
        let cancelled = false;
        const req = http.request(url, {
          method: 'PUT',
          headers: {
            ...headers,
            'Content-Range': contentRange,
            'Content-Length': length,
          },
        });
        const cancel = () => {
          cancelled = true;
          req.destroy(new Error('Chunk cancelled'));
        };
        inFlight.set(url, cancel);
        const cleanUp = () => {
          if (inFlight.get(url) === cancel) inFlight.delete(url);
        };
        req.on('response', (res) => {
          res.resume();
          res.on('end', () => {
            cleanUp();
            resolve({
              status: res.statusCode ?? 0,
              headers: flatten(res.headers),
            });
          });
        });
        req.on('error', (error) => {
          cleanUp();
          reject(
            new TransportError(
              cancelled ? 'ECANCELLED' : 'ENETWORK',
              error.message
            )
          );
        });
        if (length === 0) {
          req.end();
          return;
        }
        const stream = fs.createReadStream(path, { start, end });
        stream.on('error', (error: NodeJS.ErrnoException) => {
          cleanUp();
          req.destroy();
          reject(
            new TransportError(
              error.code === 'ENOENT' ? 'ENOENT' : 'EIO',
              error.message
            )
          );
        });
        stream.pipe(req);
      });
    },
    cancelChunk(url) {
      inFlight.get(url)?.();
    },
  };
}

function flatten(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return out;
}

/**
 * Node file / storage / signal primitives. The key/value store is in memory
 * and connectivity is driven by the test through `setConnectivity`.
 */
export function createNodePlatform(
  initial: ConnectivityState = { isConnected: true, networkType: 'wifi' }
): Platform & { setConnectivity(state: ConnectivityState): void } {
  const kv = new Map<string, string>();
  const listeners = new Set<(state: ConnectivityState) => void>();
  let connectivity = initial;
  const io = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      throw new TransportError(
        e.code === 'ENOENT' ? 'ENOENT' : 'EIO',
        e.message
      );
    }
  };
  return {
    getFileSize: (path) => io(async () => (await fs.promises.stat(path)).size),
    readRange: (path, start, length) =>
      io(async () => {
        const handle = await fs.promises.open(path, 'r');
        try {
          const buf = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buf, 0, length, start);
          return buf.subarray(0, bytesRead).toString('base64');
        } finally {
          await handle.close();
        }
      }),
    truncate: (path, length) => io(() => fs.promises.truncate(path, length)),
    deleteFile: (path) => io(() => fs.promises.rm(path, { force: true })),
    getFreeDiskSpace: () =>
      io(async () => {
        const stats = await fs.promises.statfs('.');
        return stats.bavail * stats.bsize;
      }),
    kvGet: async (key) => kv.get(key) ?? null,
    kvSet: async (key, value) => {
      kv.set(key, value);
    },
    kvRemove: async (key) => {
      kv.delete(key);
    },
    getConnectivity: async () => connectivity,
    onConnectivityChange(listener) {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
    setConnectivity(state) {
      connectivity = state;
      for (const listener of listeners) listener(state);
    },
  };
}
