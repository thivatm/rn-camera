// The Transport / Platform seam between the shared TS upload engine and the
// thin native primitives (see `src/specs/NativeRecordingUploads.ts`). Native
// adapters wrap the Turbo Module; Jest uses a Node implementation
// (`__fixtures__/nodeTransport.ts`). Video bytes never cross into JS.

/**
 * One `PUT` of a byte range of the Recording File (spec §5.1). `start` and
 * `end` are inclusive; `end < start` is an empty range (a status query).
 */
export type ChunkRequest = {
    url: string;
    /** The Upload Target's headers, sent on every request. */
    headers: Record<string, string>;
    path: string;
    start: number;
    end: number;
    contentRange: string;
};

export type ChunkResponse = {
    status: number;
    /** Lower-cased header names. */
    headers: Record<string, string>;
};

/** Codes a Transport / Platform rejection carries in `error.code`. */
export type TransportErrorCode = 'ENOENT' | 'ECANCELLED' | 'ENETWORK' | 'EIO';

export class TransportError extends Error {
    readonly code: TransportErrorCode;
    constructor(code: TransportErrorCode, message: string) {
        super(message);
        this.name = 'TransportError';
        this.code = code;
    }
}

export interface Transport {
    /** Rejects with a `TransportError`-shaped error on network failure or cancellation. */
    sendChunk(request: ChunkRequest): Promise<ChunkResponse>;
    /** Cancels the in-flight `sendChunk` to `url`, if any. */
    cancelChunk(url: string): void;
}

export type NetworkType = 'wifi' | 'cellular' | 'other' | 'none';

export type ConnectivityState = {
    isConnected: boolean;
    networkType: NetworkType;
};

/** File, storage and signal primitives (used by later tickets: retry, queue, persistence). */
export interface Platform {
    getFileSize(path: string): Promise<number>;
    /** Up to `length` bytes from `start`, base64-encoded. For small reads only. */
    readRange(path: string, start: number, length: number): Promise<string>;
    truncate(path: string, length: number): Promise<void>;
    /** A missing file is not an error. */
    deleteFile(path: string): Promise<void>;
    getFreeDiskSpace(): Promise<number>;
    kvGet(key: string): Promise<string | null>;
    kvSet(key: string, value: string): Promise<void>;
    kvRemove(key: string): Promise<void>;
    getConnectivity(): Promise<ConnectivityState>;
    onConnectivityChange(listener: (state: ConnectivityState) => void): {
        remove(): void;
    };
}
