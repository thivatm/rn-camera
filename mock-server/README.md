# Mock resumable server

A Node test server that speaks the GCS-style resumable upload protocol (spec §5.1) with fault injection (spec §8). Jest tests use it in-process; XCTest and JUnit runs start it as a CLI and drive it over HTTP.

Needs Node >= 22.18 (runs `server.ts` with built-in type stripping). No dependencies.

## Protocol

Upload URLs look like `<base>/upload/<id>` and must be created first (unknown ids get `404`).

| Request (`PUT`)                                                 | Reply                                                                                     |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Chunk, `Content-Range: bytes a-b/*`                             | `308`, `Range: bytes=0-N` (N = Committed Offset - 1)                                      |
| Final Chunk, `Content-Range: bytes a-b/<total>`                 | `200` (or `201`, see `completeStatus`): Upload Complete                                   |
| Status query, `Content-Range: bytes */*` (or `bytes */<total>`) | `308` with `Range`, `308` without `Range` (nothing committed), or `200`/`201` if complete |
| Any `PUT` after Upload Complete                                 | `200`/`201`                                                                               |

The server rejects with `400`: a missing or malformed `Content-Range`, a body that doesn't match the range, a non-final Chunk that isn't a multiple of 256 KiB, a Chunk that starts beyond the Committed Offset, or a final Chunk that doesn't end at `total - 1`. Bytes below the Committed Offset are accepted and ignored. Committed bytes are stored so tests can compare them with the source file.

## Faults

Configured per upload, either at creation or later.

- `expired: 404 | 410`: URL expiry. Every request gets this status until set back to `null`.
- `bytesPerSecond: number`: slow throughput. Request bodies are read at this rate until set to `null`.
- `completeStatus: 200 | 201`: status for Upload Complete.
- `faults: Fault[]`: one-shot faults, appended to a queue. Each is used by the first later request it targets (`on: 'chunk'` (default, Chunks and final Chunks), `'statusQuery'` or `'any'`):
    - `{ type: 'drop' }`: destroy the connection without replying; nothing is committed.
    - `{ type: 'drop', commit: true }`: commit the Chunk, then destroy the connection (the reply is lost).
    - `{ type: 'status', status: 503 }`: reply with that status (`503`, `408`, `429`, ...); nothing is committed.
    - `{ type: 'partialCommit', bytes: n }`: commit only the first `n` new bytes and reply `308` with the smaller `Range`. On a final Chunk the upload stays incomplete.

## From Jest

```ts
/** @jest-environment node */
import { startMockResumableServer } from '../../mock-server/server';

const server = await startMockResumableServer(); // random port on 127.0.0.1
const { id, url } = server.createUpload({
    faults: [{ type: 'status', status: 503 }],
});
// ...upload to `url`...
server.configure(id, { expired: 410 });
const { bytes, committedOffset, complete, total, requests } =
    server.getUpload(id);
server.reset();
await server.close();
```

`requests` logs every request to the upload: `method`, `kind` (`chunk`, `finalChunk`, `statusQuery`, `invalid`), `contentRange`, `bodyLength`, `headers`, `status` (or `'dropped'`), and `fault`.

## As a CLI (XCTest, JUnit)

```sh
yarn mock-server --port 8787            # or: node mock-server/cli.mjs --port 8787 --host 127.0.0.1
# prints: listening on http://127.0.0.1:8787   (--port 0 picks a free port)
```

Control endpoint (JSON bodies take the same fields as `createUpload` / `configure`):

| Request                                          | Effect                                                        |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `POST /__control/uploads` `{ "id"?, ...config }` | Create an upload. `201 { "id", "url" }`                       |
| `PATCH /__control/uploads/<id>` `{ ...config }`  | Change config; `faults` are appended. `200` summary           |
| `GET /__control/uploads/<id>`                    | `200 { id, url, committedOffset, complete, total, requests }` |
| `GET /__control/uploads/<id>/bytes`              | Committed bytes as `application/octet-stream`                 |
| `POST /__control/reset`                          | Forget every upload. `204`                                    |

Upload URLs returned by the control endpoint use the `Host` the caller sent, so a device can use them directly. The Android emulator reaches the host at `10.0.2.2`; start the server with `--host 0.0.0.0` for that.
