// The internal `UploadProtocol` seam (spec §1) and its one v1 implementation,
// the Mux / GCS resumable protocol (spec §5.1).
import type { UploadTarget } from '../types';
import type { ChunkPlan } from './chunkSizing';
import type { ChunkResponse, Transport } from './transport';

/** What the Upload URL said about a request. */
export type ProtocolReply =
  /** Not complete yet; the server holds bytes `[0, committedOffset)`. */
  | { type: 'committed'; committedOffset: number }
  /** Upload Complete. */
  | { type: 'complete'; httpStatus: number }
  /** Any other HTTP status. */
  | { type: 'rejected'; httpStatus: number };

export interface UploadProtocol {
  /** Sends one Chunk of the Recording File at `filePath`. `total` is the file size, for the final Chunk. */
  sendChunk(
    target: UploadTarget,
    filePath: string,
    chunk: ChunkPlan
  ): Promise<ProtocolReply>;
  /** Asks the Upload URL for its Committed Offset. */
  queryStatus(target: UploadTarget, filePath: string): Promise<ProtocolReply>;
}

export function createResumableProtocol(transport: Transport): UploadProtocol {
  return {
    async sendChunk(target, filePath, { start, end, isFinal }) {
      const last = end - 1;
      const response = await transport.sendChunk({
        url: target.url,
        headers: target.headers ?? {},
        path: filePath,
        start,
        end: last,
        contentRange: `bytes ${start}-${last}/${isFinal ? end : '*'}`,
      });
      return parseReply(response);
    },
    async queryStatus(target, filePath) {
      const response = await transport.sendChunk({
        url: target.url,
        headers: target.headers ?? {},
        path: filePath,
        start: 0,
        end: -1,
        contentRange: 'bytes */*',
      });
      return parseReply(response);
    },
  };
}

function parseReply({ status, headers }: ChunkResponse): ProtocolReply {
  if (status === 200 || status === 201) {
    return { type: 'complete', httpStatus: status };
  }
  if (status === 308) {
    return { type: 'committed', committedOffset: parseRange(headers.range) };
  }
  return { type: 'rejected', httpStatus: status };
}

/** `Range: bytes=0-N` → N+1; no `Range` → 0. */
export function parseRange(range: string | undefined): number {
  if (range === undefined) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range.trim());
  if (!match) throw new Error(`Unexpected Range header: ${range}`);
  return Number(match[1]) + 1;
}
