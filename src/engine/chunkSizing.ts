// Chunk sizing (spec §5.2). Pure: no I/O.

const KIB = 1024;
const MIB = 1024 * KIB;

/** Every Chunk except the final one is a multiple of this. */
export const CHUNK_MULTIPLE = 256 * KIB;
/** Largest Chunk ever sent. */
export const MAX_CHUNK_SIZE = 8 * MIB;
/** Default `minChunkSize`. */
export const DEFAULT_MIN_CHUNK_SIZE = MIB;

export type ChunkSizingInput = {
    committedOffset: number;
    /** Current size of the Recording File. */
    recordedBytes: number;
    /** `true` while this is the Live Recording (the file may still grow). */
    isLive: boolean;
    minChunkSize: number;
};

/**
 * The next Chunk to send. `start` is inclusive and `end` is exclusive (like
 * `Array.prototype.slice`); `isFinal` means it ends the Recording File and
 * completes the upload.
 */
export type ChunkPlan = { start: number; end: number; isFinal: boolean };

/**
 * Which Chunk to send next, or `null` to wait (live) / nothing to send.
 *
 * - Live: wait until the Backlog reaches `minChunkSize`, then send the largest
 *   256 KiB multiple strictly below the Backlog, capped at 8 MiB. A large
 *   Backlog (catching up after a pause) therefore goes out in 8 MiB Chunks.
 * - Stopped: drain in 8 MiB Chunks; whatever is left (1 byte to 8 MiB) is the
 *   final Chunk, so it is never empty.
 */
export function planNextChunk({
    committedOffset,
    recordedBytes,
    isLive,
    minChunkSize,
}: ChunkSizingInput): ChunkPlan | null {
    const backlog = recordedBytes - committedOffset;
    if (backlog <= 0) return null;

    if (!isLive) {
        if (backlog <= MAX_CHUNK_SIZE) {
            return {
                start: committedOffset,
                end: recordedBytes,
                isFinal: true,
            };
        }
        return chunk(committedOffset, MAX_CHUNK_SIZE);
    }

    if (backlog < minChunkSize) return null;
    const size = Math.min(
        Math.floor((backlog - 1) / CHUNK_MULTIPLE) * CHUNK_MULTIPLE,
        MAX_CHUNK_SIZE
    );
    return size > 0 ? chunk(committedOffset, size) : null;
}

function chunk(start: number, size: number): ChunkPlan {
    return { start, end: start + size, isFinal: false };
}
