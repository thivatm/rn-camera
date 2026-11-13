import { RecordingUploads } from '../index';
import NativeRecordingUploads from '../specs/NativeRecordingUploads';
import { getRecordingUploadsManager } from '../uploads';

jest.mock('../specs/NativeRecordingUploads', () => ({
    __esModule: true,
    default: {
        sendChunk: jest.fn(() => new Promise(() => {})),
        cancelChunk: jest.fn(),
        getFileSize: jest.fn(),
        readRange: jest.fn(),
        truncate: jest.fn(),
        deleteFile: jest.fn(async () => {}),
        getFreeDiskSpace: jest.fn(),
        kvGet: jest.fn(),
        kvSet: jest.fn(),
        kvRemove: jest.fn(),
        getConnectivity: jest.fn(async () => ({
            isConnected: true,
            networkType: 'wifi',
        })),
        onConnectivityChange: jest.fn(() => ({ remove: jest.fn() })),
    },
}));

jest.mock('../specs/NativeCameraPermissions', () => ({
    __esModule: true,
    default: {},
}));

const native = jest.mocked(NativeRecordingUploads);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('RecordingUploads (§3.3) over the native module', () => {
    test('a Recording registered by capture is listed, uploads through native, and is deleted through native', async () => {
        const states: string[] = [];
        const sub = RecordingUploads.addListener('uploadStateChange', (e) =>
            states.push(e.state)
        );
        const manager = getRecordingUploadsManager();
        manager.registerLiveRecording({
            recordingId: 'rec-1',
            filePath: '/data/rec-1.mp4',
            options: { uploadUrlProvider: async () => ({ url: 'https://u' }) },
        });
        manager.reportRecordingStopped('rec-1', {
            finalSize: 10,
            reason: 'user',
        });
        await flush();

        expect(states).toEqual(['uploading', 'finalizing']);
        expect(native.sendChunk).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'https://u',
                path: '/data/rec-1.mp4',
                contentRange: 'bytes 0-9/10',
            })
        );
        const [recording] = await RecordingUploads.getRecordings();
        expect(recording).toMatchObject({
            id: 'rec-1',
            uploadState: 'finalizing',
        });

        await RecordingUploads.deleteRecording('rec-1');
        expect(native.cancelChunk).toHaveBeenCalledWith('https://u');
        expect(native.deleteFile).toHaveBeenCalledWith('/data/rec-1.mp4');
        expect(await RecordingUploads.getRecordings()).toEqual([]);
        sub.remove();
    });

    test('retryUpload and resumeUploads are exposed', async () => {
        const uploadUrlProvider = async () => ({ url: 'https://u' });
        await expect(
            RecordingUploads.retryUpload('missing', { uploadUrlProvider })
        ).rejects.toThrow('Unknown Recording missing');
        await expect(
            RecordingUploads.resumeUploads({ uploadUrlProvider })
        ).resolves.toBeUndefined();
    });
});
