import type { Recording } from '@thivatm/rn-camera';
import { describeUpload } from '../describeUpload';

const base: Recording = {
    id: 'rec-1',
    isLive: false,
    interrupted: false,
    filePath: '/data/rec-1.mp4',
    recordedBytes: 4_000_000,
    committedOffset: 1_000_000,
    uploadState: 'uploading',
    keepRecordingFile: true,
    allowCellular: true,
    createdAt: '2026-11-11T10:00:00.000Z',
};

describe('describeUpload', () => {
    it('shows progress while uploading', () => {
        expect(describeUpload(base)).toBe('Uploading 25% (1.0 / 4.0 MB)');
    });

    it('shows the pause reason', () => {
        expect(
            describeUpload({
                ...base,
                uploadState: 'paused',
                pauseReason: 'offline',
            })
        ).toBe('Paused (offline) 25% (1.0 / 4.0 MB)');
    });

    it('shows the error code and HTTP status when failed', () => {
        expect(
            describeUpload({
                ...base,
                uploadState: 'failed',
                error: {
                    code: 'urlRejected',
                    httpStatus: 410,
                    message: 'Gone',
                },
            })
        ).toBe('Failed: urlRejected (HTTP 410) Gone');
    });

    it('shows completed and waiting states plainly', () => {
        expect(
            describeUpload({
                ...base,
                uploadState: 'completed',
                committedOffset: 4_000_000,
            })
        ).toBe('Completed (4.0 MB)');
        expect(describeUpload({ ...base, uploadState: 'waitingForUrl' })).toBe(
            'Waiting for Upload URL (4.0 MB recorded)'
        );
    });
});
