// Thin adapter from the `RecordingUploads` Turbo Module to the engine's
// Transport / Platform seam.
import type { Spec } from '../specs/NativeRecordingUploads';
import type {
    ConnectivityState,
    NetworkType,
    Platform,
    Transport,
} from './transport';

export function createNativeTransport(native: Spec): Transport {
    return {
        async sendChunk(request) {
            const response = await native.sendChunk(request);
            return {
                status: response.status,
                headers: response.headers as Record<string, string>,
            };
        },
        cancelChunk: (url) => native.cancelChunk(url),
    };
}

export function createNativePlatform(native: Spec): Platform {
    const toState = (state: {
        isConnected: boolean;
        networkType: string;
    }): ConnectivityState => ({
        isConnected: state.isConnected,
        networkType: state.networkType as NetworkType,
    });
    return {
        getFileSize: (path) => native.getFileSize(path),
        readRange: (path, start, length) =>
            native.readRange(path, start, length),
        truncate: (path, length) => native.truncate(path, length),
        deleteFile: (path) => native.deleteFile(path),
        getFreeDiskSpace: () => native.getFreeDiskSpace(),
        kvGet: (key) => native.kvGet(key),
        kvSet: (key, value) => native.kvSet(key, value),
        kvRemove: (key) => native.kvRemove(key),
        getConnectivity: async () => toState(await native.getConnectivity()),
        onConnectivityChange: (listener) =>
            native.onConnectivityChange((state) => listener(toState(state))),
    };
}
