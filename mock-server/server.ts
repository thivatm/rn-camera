/**
 * Mock Mux / GCS resumable upload server (spec §5.1, §8). See README.md.
 *
 * Only erasable TypeScript syntax is used so Node (>= 22.18) can run this file
 * directly via `cli.mjs`, and Jest can import it through Babel.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const CHUNK_MULTIPLE = 256 * 1024;

/** Which requests a one-shot Fault applies to. Default `'chunk'`. */
export type FaultTarget = 'chunk' | 'statusQuery' | 'any';

/**
 * A one-shot fault, consumed by the first later request it targets.
 * - `drop`: destroy the connection without replying. With `commit: true` the
 *   server reads and commits the Chunk first, so only the reply is lost.
 * - `status`: reply with this status (e.g. 503, 408, 429) and commit nothing.
 * - `partialCommit`: commit only the first `bytes` new bytes of the Chunk and
 *   reply 308 with the (smaller) committed Range, even for a final Chunk.
 */
export type Fault =
  | { type: 'drop'; commit?: boolean; on?: FaultTarget }
  | { type: 'status'; status: number; on?: FaultTarget }
  | { type: 'partialCommit'; bytes: number; on?: FaultTarget };

export type UploadConfig = {
  /** Status for Upload Complete. Default 200. */
  completeStatus?: 200 | 201;
  /** URL expiry: every request gets this status while set. `null` clears it. */
  expired?: 404 | 410 | null;
  /** Slow throughput: request bodies are read at this rate. `null` clears it. */
  bytesPerSecond?: number | null;
  /** Appended to the upload's queue of one-shot faults. */
  faults?: Fault[];
};

export type RequestKind = 'chunk' | 'finalChunk' | 'statusQuery' | 'invalid';

export type RequestLogEntry = {
  method: string;
  kind: RequestKind;
  contentRange: string | null;
  bodyLength: number;
  headers: http.IncomingHttpHeaders;
  /** Reply status, or `'dropped'` when the connection was destroyed. */
  status: number | 'dropped';
  fault: Fault['type'] | 'expired' | null;
};

export type UploadRecord = {
  id: string;
  url: string;
  /** Bytes the server has committed, in order from byte 0. */
  bytes: Buffer;
  committedOffset: number;
  complete: boolean;
  /** Total size declared by the accepted final Chunk. */
  total: number | null;
  requests: RequestLogEntry[];
};

export type MockResumableServer = {
  /** Base URL, e.g. `http://127.0.0.1:54321`. */
  url: string;
  port: number;
  createUpload(options?: UploadConfig & { id?: string }): {
    id: string;
    url: string;
  };
  configure(id: string, config: UploadConfig): void;
  getUpload(id: string): UploadRecord;
  /** Forget every upload. */
  reset(): void;
  close(): Promise<void>;
};

export type StartOptions = { port?: number; host?: string };

type Upload = {
  id: string;
  chunks: Buffer[];
  committedOffset: number;
  total: number | null;
  completeStatus: 200 | 201;
  expired: 404 | 410 | null;
  bytesPerSecond: number | null;
  faults: Fault[];
  requests: RequestLogEntry[];
};

type ContentRange =
  | { kind: 'statusQuery' }
  | { kind: 'chunk'; start: number; end: number; total: number | null };

function parseContentRange(value: string | undefined): ContentRange | null {
  if (!value) return null;
  if (/^bytes \*\/(\*|\d+)$/.test(value.trim())) return { kind: 'statusQuery' };
  const m = /^bytes (\d+)-(\d+)\/(\*|\d+)$/.exec(value.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = m[3] === '*' ? null : Number(m[3]);
  if (end < start) return null;
  return { kind: 'chunk', start, end, total };
}

function takeFault(upload: Upload, kind: RequestKind): Fault | null {
  const target = kind === 'statusQuery' ? 'statusQuery' : 'chunk';
  const index = upload.faults.findIndex(
    (f) => (f.on ?? 'chunk') === 'any' || (f.on ?? 'chunk') === target
  );
  if (index === -1 || kind === 'invalid') return null;
  return upload.faults.splice(index, 1)[0] ?? null;
}

function readBody(
  req: http.IncomingMessage,
  bytesPerSecond: number | null
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      if (bytesPerSecond) {
        req.pause();
        setTimeout(() => req.resume(), (c.length / bytesPerSecond) * 1000);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startMockResumableServer(
  options: StartOptions = {}
): Promise<MockResumableServer> {
  const host = options.host ?? '127.0.0.1';
  const uploads = new Map<string, Upload>();
  let nextId = 1;
  let baseUrl = '';

  const uploadUrl = (id: string) =>
    `${baseUrl}/upload/${encodeURIComponent(id)}`;

  function find(id: string): Upload {
    const upload = uploads.get(id);
    if (!upload) throw new Error(`Unknown upload ${id}`);
    return upload;
  }

  function configure(id: string, config: UploadConfig) {
    const upload = find(id);
    if (config.completeStatus !== undefined) {
      upload.completeStatus = config.completeStatus;
    }
    if (config.expired !== undefined) upload.expired = config.expired;
    if (config.bytesPerSecond !== undefined) {
      upload.bytesPerSecond = config.bytesPerSecond;
    }
    if (config.faults) upload.faults.push(...config.faults);
  }

  function createUpload(opts: UploadConfig & { id?: string } = {}) {
    const id = opts.id ?? `u${nextId++}`;
    uploads.set(id, {
      id,
      chunks: [],
      committedOffset: 0,
      total: null,
      completeStatus: 200,
      expired: null,
      bytesPerSecond: null,
      faults: [],
      requests: [],
    });
    configure(id, opts);
    return { id, url: uploadUrl(id) };
  }

  function getUpload(id: string): UploadRecord {
    const upload = find(id);
    return {
      id: upload.id,
      url: uploadUrl(upload.id),
      bytes: Buffer.concat(upload.chunks),
      committedOffset: upload.committedOffset,
      complete: upload.total !== null,
      total: upload.total,
      requests: [...upload.requests],
    };
  }

  function commit(upload: Upload, start: number, body: Buffer, max = Infinity) {
    const fresh = body.subarray(upload.committedOffset - start);
    const kept = fresh.subarray(0, Math.max(0, Math.min(max, fresh.length)));
    upload.chunks.push(kept);
    upload.committedOffset += kept.length;
    return kept.length === fresh.length;
  }

  async function handleUpload(
    upload: Upload,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const contentRange = req.headers['content-range'] ?? null;
    const range = parseContentRange(contentRange ?? undefined);
    const kind: RequestKind = !range
      ? 'invalid'
      : range.kind === 'statusQuery'
        ? 'statusQuery'
        : range.total === null
          ? 'chunk'
          : 'finalChunk';
    const entry: RequestLogEntry = {
      method: req.method ?? '',
      kind,
      contentRange,
      bodyLength: 0,
      headers: req.headers,
      status: 'dropped',
      fault: null,
    };
    upload.requests.push(entry);

    const send = (status: number, message?: string) => {
      entry.status = status;
      if (status === 308 && upload.committedOffset > 0) {
        res.setHeader('Range', `bytes=0-${upload.committedOffset - 1}`);
      }
      if (message) res.setHeader('Content-Type', 'text/plain');
      res.writeHead(status).end(message);
    };

    if (upload.expired) {
      entry.fault = 'expired';
      req.resume();
      return send(upload.expired);
    }

    const fault = takeFault(upload, kind);
    entry.fault = fault?.type ?? null;
    if (fault?.type === 'drop' && !fault.commit) {
      req.socket.destroy();
      return;
    }

    const body = await readBody(req, upload.bytesPerSecond);
    entry.bodyLength = body.length;

    if (req.method !== 'PUT') return send(405);
    if (!range) return send(400, 'missing or invalid Content-Range');
    if (fault?.type === 'status') return send(fault.status);

    const complete = upload.total !== null;
    if (range.kind === 'statusQuery') {
      return send(complete ? upload.completeStatus : 308);
    }
    if (complete) return send(upload.completeStatus);

    const { start, end, total } = range;
    const length = end - start + 1;
    if (body.length !== length) {
      return send(400, 'body length does not match Content-Range');
    }
    if (start > upload.committedOffset) {
      return send(400, 'Chunk starts beyond the Committed Offset');
    }
    if (total === null && length % CHUNK_MULTIPLE !== 0) {
      return send(400, 'non-final Chunk is not a multiple of 256 KiB');
    }
    if (total !== null && end !== total - 1) {
      return send(400, 'final Chunk does not end at total - 1');
    }

    const max = fault?.type === 'partialCommit' ? fault.bytes : Infinity;
    const whole = commit(upload, start, body, max);

    if (fault?.type === 'drop') {
      if (whole && total !== null) upload.total = total;
      req.socket.destroy();
      return;
    }
    if (total !== null && whole) {
      upload.total = total;
      return send(upload.completeStatus);
    }
    return send(308);
  }

  async function handleControl(
    path: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const send = (status: number, body?: unknown) => {
      if (body === undefined) {
        res.writeHead(status).end();
      } else if (Buffer.isBuffer(body)) {
        res.writeHead(status, { 'Content-Type': 'application/octet-stream' });
        res.end(body);
      } else {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      }
    };
    const raw = await readBody(req, null);
    const input = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    // Hand out Upload URLs on the host the caller used (e.g. 10.0.2.2 from
    // the Android emulator), not the address the server is bound to.
    const withCallerHost = <T extends { url?: string }>(value: T): T => {
      const callerHost = req.headers.host;
      if (!callerHost || !value.url?.startsWith(baseUrl)) return value;
      return {
        ...value,
        url: `http://${callerHost}${value.url.slice(baseUrl.length)}`,
      };
    };

    if (path === '/__control/reset' && req.method === 'POST') {
      reset();
      return send(204);
    }
    if (path === '/__control/uploads' && req.method === 'POST') {
      return send(201, withCallerHost(createUpload(input)));
    }
    const m = /^\/__control\/uploads\/([^/]+)(\/bytes)?$/.exec(path);
    const id = m ? decodeURIComponent(m[1]!) : '';
    if (!m || !uploads.has(id)) return send(404, { error: 'unknown upload' });
    if (m[2]) {
      return req.method === 'GET' ? send(200, getUpload(id).bytes) : send(405);
    }
    if (req.method === 'PATCH') configure(id, input);
    else if (req.method !== 'GET') return send(405);
    const summary: Partial<UploadRecord> = getUpload(id);
    delete summary.bytes;
    return send(200, withCallerHost(summary));
  }

  function reset() {
    uploads.clear();
    nextId = 1;
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse) {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const uploadMatch = /^\/upload\/([^/]+)$/.exec(path);
    if (uploadMatch) {
      const upload = uploads.get(decodeURIComponent(uploadMatch[1]!));
      if (upload) return handleUpload(upload, req, res);
    } else if (path.startsWith('/__control/')) {
      return handleControl(path, req, res);
    }
    req.resume();
    res.writeHead(404).end();
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err));
      }
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, host, resolve)
  );
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://${host}:${port}`;

  return {
    url: baseUrl,
    port,
    createUpload,
    configure,
    getUpload,
    reset,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
