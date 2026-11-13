// Repairs an Interrupted Recording's file (spec §4, ADR 0002). A fragmented
// MP4 is an init segment (`ftyp`, `moov`) followed by Fragments (`moof` +
// `mdat`). If the app was killed mid-write the last Fragment may be cut
// short; walking the top-level box headers with small range reads finds the
// end of the last complete one.
import type { Platform } from './transport';

/** Enough for a box header with a 64-bit `largesize`. */
const HEADER_READ = 16;

/**
 * Truncates the file at `path` to the end of its last complete Fragment (or
 * of its init segment if no Fragment is complete, or to 0 if not even that
 * is) and returns the new length. Never cuts below `keepAtLeast` (bytes the
 * server already committed cannot be taken back). Rejects (e.g. `ENOENT`) if
 * the file cannot be read.
 */
export async function truncateToLastCompleteFragment(
    platform: Pick<Platform, 'getFileSize' | 'readRange' | 'truncate'>,
    path: string,
    keepAtLeast = 0
): Promise<number> {
    const fileSize = await platform.getFileSize(path);
    const keep = Math.min(
        fileSize,
        Math.max(
            keepAtLeast,
            await lastCompleteFragmentEnd(platform, path, fileSize)
        )
    );
    if (keep < fileSize) await platform.truncate(path, keep);
    return keep;
}

async function lastCompleteFragmentEnd(
    platform: Pick<Platform, 'readRange'>,
    path: string,
    fileSize: number
): Promise<number> {
    let keep = 0;
    let offset = 0;
    let sawMoov = false;
    let sawFragment = false;
    let inFragment = false;
    while (offset + 8 <= fileSize) {
        const header = base64ToBytes(
            await platform.readRange(path, offset, HEADER_READ)
        );
        const box = parseBoxHeader(header);
        if (!box || offset + box.size > fileSize) break;
        const end = offset + box.size;
        if (box.type === 'moof') {
            sawFragment = true;
            inFragment = true;
        } else if (box.type === 'mdat' && inFragment) {
            keep = end;
        } else if (!sawFragment) {
            // The init segment (`ftyp`, `moov`, ...) is usable once `moov` is whole.
            if (box.type === 'moov') sawMoov = true;
            if (sawMoov) keep = end;
        } else {
            // `styp`/`sidx`/`mfra`/...: not part of a complete moof + mdat pair.
            inFragment = false;
        }
        offset = end;
    }
    return keep;
}

/** `null` for a header that is cut short or makes no sense. */
function parseBoxHeader(
    bytes: Uint8Array
): { size: number; type: string } | null {
    if (bytes.length < 8) return null;
    const size32 = readUint32(bytes, 0);
    const type = String.fromCharCode(
        bytes[4]!,
        bytes[5]!,
        bytes[6]!,
        bytes[7]!
    );
    let size: number;
    let headerSize = 8;
    if (size32 === 1) {
        if (bytes.length < 16) return null;
        size = readUint32(bytes, 8) * 2 ** 32 + readUint32(bytes, 12);
        headerSize = 16;
    } else {
        // 0 means "to the end of the file": a box still being written.
        size = size32;
    }
    if (size < headerSize) return null;
    return { size, type };
}

function readUint32(bytes: Uint8Array, at: number): number {
    return (
        bytes[at]! * 0x1000000 +
        bytes[at + 1]! * 0x10000 +
        bytes[at + 2]! * 0x100 +
        bytes[at + 3]!
    );
}

/** Built into Hermes and Node; not in the `ESNext` lib the build type-checks against. */
declare const atob: (base64: string) => string;

/** Base64 (from `readRange`) to bytes. */
function base64ToBytes(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
