import { planNextChunk } from '../chunkSizing';

const KIB = 1024;
const MIB = 1024 * KIB;

const live = (
    committedOffset: number,
    recordedBytes: number,
    minChunkSize = MIB
) =>
    planNextChunk({
        committedOffset,
        recordedBytes,
        isLive: true,
        minChunkSize,
    });

const stopped = (committedOffset: number, recordedBytes: number) =>
    planNextChunk({
        committedOffset,
        recordedBytes,
        isLive: false,
        minChunkSize: MIB,
    });

describe('§5.2 chunk sizing while recording', () => {
    test('waits while the Backlog is below minChunkSize', () => {
        expect(live(0, MIB - 1)).toBeNull();
        expect(live(0, 0)).toBeNull();
    });

    test('a Backlog of exactly minChunkSize sends the largest 256 KiB multiple strictly below it', () => {
        expect(live(0, MIB)).toEqual({
            start: 0,
            end: 768 * KIB,
            isFinal: false,
        });
    });

    test('a Backlog one byte over a 256 KiB multiple sends that multiple', () => {
        expect(live(0, MIB + 1)).toEqual({
            start: 0,
            end: MIB,
            isFinal: false,
        });
    });

    test('a Backlog just under a 256 KiB multiple rounds down', () => {
        expect(live(0, 1280 * KIB - 1)).toEqual({
            start: 0,
            end: MIB,
            isFinal: false,
        });
    });

    test('Chunks start at the Committed Offset', () => {
        expect(live(512 * KIB, 512 * KIB + MIB + 10)).toEqual({
            start: 512 * KIB,
            end: 512 * KIB + MIB,
            isFinal: false,
        });
    });

    test('a Backlog above 8 MiB (catching up) is capped at 8 MiB', () => {
        expect(live(0, 20 * MIB)).toEqual({
            start: 0,
            end: 8 * MIB,
            isFinal: false,
        });
        expect(live(0, 8 * MIB + 1)).toEqual({
            start: 0,
            end: 8 * MIB,
            isFinal: false,
        });
    });

    test('a Backlog of exactly 8 MiB holds back one 256 KiB step', () => {
        expect(live(0, 8 * MIB)).toEqual({
            start: 0,
            end: 8 * MIB - 256 * KIB,
            isFinal: false,
        });
    });

    test('a custom minChunkSize of 256 KiB never sends an empty Chunk', () => {
        expect(live(0, 256 * KIB, 256 * KIB)).toBeNull();
        expect(live(0, 256 * KIB + 1, 256 * KIB)).toEqual({
            start: 0,
            end: 256 * KIB,
            isFinal: false,
        });
    });
});

describe('§5.2 chunk sizing on stop (drain)', () => {
    test('a Backlog of up to 8 MiB is sent as the final Chunk', () => {
        expect(stopped(MIB, MIB + 1)).toEqual({
            start: MIB,
            end: MIB + 1,
            isFinal: true,
        });
        expect(stopped(0, 8 * MIB)).toEqual({
            start: 0,
            end: 8 * MIB,
            isFinal: true,
        });
    });

    test('a Backlog above 8 MiB drains in 8 MiB Chunks first', () => {
        expect(stopped(0, 8 * MIB + 1)).toEqual({
            start: 0,
            end: 8 * MIB,
            isFinal: false,
        });
    });

    test('a Backlog below minChunkSize is still sent once stopped', () => {
        expect(stopped(0, 10)).toEqual({ start: 0, end: 10, isFinal: true });
    });

    test('nothing to send when there is no Backlog', () => {
        expect(stopped(MIB, MIB)).toBeNull();
    });
});
