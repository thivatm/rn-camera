/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodePlatform } from '../__fixtures__/nodeTransport';
import { truncateToLastCompleteFragment } from '../fragmentedMp4';

// ffmpeg output (`+frag_keyframe+empty_moov+default_base_moof`): top-level
// boxes ftyp@0, moov@28, moof@1255, mdat@1567, moof@9496, mdat@9784,
// moof@17580, mdat@17864, moof@25606, mdat@25982, mfra@33693 (33917 bytes).
const FIXTURE = path.join(__dirname, '../__fixtures__/fragmented.mp4');
const INIT_END = 1255;
const FRAGMENT_ENDS = [9496, 17580, 25606, 33693] as const;

let dir: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-camera-fmp4-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(bytes: Buffer) {
    const file = path.join(dir, 'rec.mp4');
    fs.writeFileSync(file, bytes);
    return file;
}

/** The fixture cut to its first `length` bytes. */
function cut(length: number) {
    return write(fs.readFileSync(FIXTURE).subarray(0, length));
}

async function truncate(file: string) {
    const length = await truncateToLastCompleteFragment(
        createNodePlatform(),
        file
    );
    expect(fs.statSync(file).size).toBe(length);
    return length;
}

describe('truncateToLastCompleteFragment', () => {
    test.each([
        ['mid-mdat of the third Fragment', 20000, FRAGMENT_ENDS[1]],
        ['mid-moof of the second Fragment', 9500, FRAGMENT_ENDS[0]],
        ['right after a moof header', 17580 + 8, FRAGMENT_ENDS[1]],
        ['inside a box header', 25606 + 3, FRAGMENT_ENDS[2]],
        ['exactly at a Fragment boundary', FRAGMENT_ENDS[2], FRAGMENT_ENDS[2]],
        ['mid-first Fragment: keeps the init segment', 2000, INIT_END],
        ['mid-moov: nothing usable', 600, 0],
    ])('cut %s', async (_name, length, expected) => {
        expect(await truncate(cut(length))).toBe(expected);
    });

    test('a whole file keeps every Fragment; the trailing mfra goes', async () => {
        expect(await truncate(cut(33917))).toBe(FRAGMENT_ENDS[3]);
    });

    test('never cuts below bytes the server already committed', async () => {
        const file = cut(20000);
        const length = await truncateToLastCompleteFragment(
            createNodePlatform(),
            file,
            18000
        );
        expect(length).toBe(18000);
        expect(fs.statSync(file).size).toBe(18000);
    });

    test('reads 64-bit `largesize` box headers', async () => {
        const box = (type: string, payload: number, large = false) => {
            const header = Buffer.alloc(large ? 16 : 8);
            if (large) {
                header.writeUInt32BE(1, 0);
                header.writeBigUInt64BE(BigInt(16 + payload), 8);
            } else {
                header.writeUInt32BE(8 + payload, 0);
            }
            header.write(type, 4, 'latin1');
            return Buffer.concat([header, Buffer.alloc(payload, 7)]);
        };
        const complete = Buffer.concat([
            box('ftyp', 4),
            box('moov', 20),
            box('moof', 12),
            box('mdat', 100, true),
        ]);
        const file = write(
            Buffer.concat([
                complete,
                box('moof', 12),
                box('mdat', 100, true),
            ]).subarray(0, complete.length + 20 + 16 + 50)
        );
        expect(await truncate(file)).toBe(complete.length);
    });

    test('a missing file rejects with ENOENT', async () => {
        await expect(
            truncateToLastCompleteFragment(
                createNodePlatform(),
                path.join(dir, 'gone.mp4')
            )
        ).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
