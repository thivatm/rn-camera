import {
    TurboModuleRegistry,
    type CodegenTypes,
    type TurboModule,
} from 'react-native';

/**
 * One Chunk `PUT` (spec §5.1). `start` and `end` are inclusive byte offsets
 * into the Recording File at `path`; `end < start` is an empty range, which
 * sends a status query. `headers` is the Upload Target's headers
 * (`{ [name: string]: string }`).
 */
export type ChunkRequest = {
    url: string;
    headers: CodegenTypes.UnsafeObject;
    path: string;
    start: number;
    end: number;
    contentRange: string;
};

/** Server reply. `headers` has lower-cased names (`{ [name: string]: string }`). */
export type ChunkResponse = {
    status: number;
    headers: CodegenTypes.UnsafeObject;
};

/** `networkType` is `'wifi' | 'cellular' | 'other' | 'none'`. */
export type ConnectivityState = {
    isConnected: boolean;
    networkType: string;
};

/**
 * Codegen spec for the `RecordingUploads` Turbo Module: the thin native
 * primitives behind the shared TS upload engine (chunk transport, file and
 * storage primitives, connectivity signals). See the Transport / Platform seam
 * in the v1 architecture notes.
 */
export interface Spec extends TurboModule {
    /** Streams the byte range from the file into a `PUT`. Rejects on network errors or cancellation. */
    sendChunk(request: ChunkRequest): Promise<ChunkResponse>;
    /** Cancels the in-flight `sendChunk` to `url`, if any. */
    cancelChunk(url: string): void;

    getFileSize(path: string): Promise<number>;
    /** Reads up to `length` bytes from `start`, base64-encoded. For small reads (MP4 box headers). */
    readRange(path: string, start: number, length: number): Promise<string>;
    truncate(path: string, length: number): Promise<void>;
    /** Deletes the file; a missing file is not an error. */
    deleteFile(path: string): Promise<void>;
    /** Bytes free on the volume holding Recording Files. */
    getFreeDiskSpace(): Promise<number>;

    /** App-private key/value store for persisted upload state (spec §6). */
    kvGet(key: string): Promise<string | null>;
    kvSet(key: string, value: string): Promise<void>;
    kvRemove(key: string): Promise<void>;

    getConnectivity(): Promise<ConnectivityState>;
    readonly onConnectivityChange: CodegenTypes.EventEmitter<ConnectivityState>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('RecordingUploads');
