# @thivatm/rn-camera

A React Native camera that records video and uploads it in **Chunks** to a resumable **Upload URL** (for example a Mux direct upload) **while it is still recording**, so the upload finishes moments after recording stops.

- Camera preview and video recording, owned by the library.
- Uploads speak the Mux / GCS resumable protocol (`PUT` + `Content-Range`, `308`).
- Uploads resume after network loss, app backgrounding and app relaunch (foreground only, see [Foreground-only uploading](#foreground-only-uploading)).
- An **Upload Queue** for Finished Recordings, **Allow Cellular** and **Keep Recording File** options.

Terms in **bold** are defined in [GLOSSARY.md](GLOSSARY.md).

## Requirements

| | |
|---|---|
| React Native | New Architecture only (Turbo Modules + Fabric), bare React Native. No Expo support in v1. |
| iOS | 15.1+ |
| Android | API 24+ |

## Installation

```sh
yarn add @thivatm/rn-camera
cd ios && pod install
```

### iOS: `Info.plist`

Your app owns the permission strings. Add both keys (the microphone key is needed unless every camera uses `audio={false}`):

```xml
<key>NSCameraUsageDescription</key>
<string>Records video to upload.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Records audio with the video.</string>
```

### Android: manifest

The library's manifest declares `CAMERA`, `RECORD_AUDIO`, `INTERNET` and `ACCESS_NETWORK_STATE`. These merge into your app automatically. It also declares `android.hardware.camera.any` with `required="false"`, so Play still lists your app on devices without a camera.

If you only record with `audio={false}`, remove `RECORD_AUDIO` in your app's `AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
          xmlns:tools="http://schemas.android.com/tools">
  <uses-permission android:name="android.permission.RECORD_AUDIO" tools:node="remove" />
</manifest>
```

## Quick start

```tsx
import { useEffect, useRef } from 'react';
import {
  StreamingCamera,
  requestPermissions,
  type StreamingCameraRef,
  type UploadUrlProvider,
} from '@thivatm/rn-camera';

// Your backend creates the Upload URL. The app never holds Mux credentials.
const uploadUrlProvider: UploadUrlProvider = async ({ recordingId, metadata }) => {
  const res = await fetch('https://api.example.com/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recordingId, metadata }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { url } = await res.json();
  return { url };
};

export function Recorder() {
  const camera = useRef<StreamingCameraRef>(null);

  useEffect(() => {
    requestPermissions({ audio: true });
  }, []);

  const start = () => camera.current?.startRecording({ uploadUrlProvider });
  const stop = () => camera.current?.stopRecording();

  return <StreamingCamera ref={camera} style={{ flex: 1 }} />;
}
```

## Upload URLs

The library never creates Upload URLs and never calls the Mux API. You pass an **Upload URL Provider**: an async function that asks *your* backend for an Upload URL and returns an `UploadTarget` (`{ url, headers? }`). `headers` are sent on every Chunk request. They are stored in app-private storage until the Recording is deleted.

For Mux, your backend calls [`POST /video/v1/uploads`](https://docs.mux.com/api-reference#video/operation/create-direct-upload) and returns `data.url`. [`example/backend/mux-upload-url.mjs`](example/backend/mux-upload-url.mjs) is a minimal Node version.

### Upload URL validity

Each Upload URL must stay valid for the whole recording plus the time it takes to upload what's left after recording stops. Set Mux's `timeout` (default 3600 s, one hour) longer than your longest recording plus that remaining upload time.

The upload starts as soon as recording starts, so the URL's clock starts then too. If the URL expires (`404`/`410`), the upload ends `failed` with `urlRejected`, and you need `retryUpload`, which re-uploads from byte 0 to a fresh URL.

### When the provider is called

- `startRecording` calls `uploadUrlProvider` right away but doesn't wait for it. Recording starts at once. The Recording stays in `waitingForUrl` and its Backlog grows until the provider resolves.
- If the provider throws, the upload goes to `failed` with `urlProviderFailed`. Recording carries on regardless.
- `resumeUploads` and `retryUpload` also take a provider, because the one passed to `startRecording` is gone after an app relaunch.

## API

Everything is exported from `@thivatm/rn-camera`.

### `<StreamingCamera>`

```tsx
<StreamingCamera
  ref={cameraRef}
  position="back"
  torch={false}
  zoom={1}
  enablePinchToZoom
  enableTapToFocus
  video={{ codec: 'h264', resolution: '1080p', fps: 30, bitrate: 6_000_000 }}
  audio
  onError={(e) => {}}
  onRecordingStopped={({ recordingId, reason }) => {}}
/>
```

Accepts every `ViewProps` prop, plus:

| Prop | Type | Default | |
|---|---|---|---|
| `position` | `'front' \| 'back'` | `'back'` | Ignored while recording. You can't switch cameras during a recording. |
| `torch` | `boolean` | `false` | |
| `zoom` | `number` | `1` | |
| `enablePinchToZoom` | `boolean` | `false` | Pinch zoom goes up to 10x. |
| `enableTapToFocus` | `boolean` | `false` | |
| `video.codec` | `'h264' \| 'hevc'` | `'h264'` | Mux transcodes HEVC to H.264 for playback, so HEVC uploads are smaller. |
| `video.resolution` | `'720p' \| '1080p'` | `'1080p'` | |
| `video.fps` | `number` | `30` | |
| `video.bitrate` | `number` (bits/s) | 6 Mbps at 1080p, 3 Mbps at 720p | |
| `audio` | `boolean` | `true` | AAC audio. `false` means no microphone permission is needed. |
| `onError` | `(e: CameraError) => void` | | |
| `onRecordingStopped` | `(e: { recordingId, reason: StopReason }) => void` | | Fires when a Live Recording becomes a Finished Recording, for any reason. |

- Without the camera permission (and the microphone permission when `audio` is on), the component renders nothing and calls `onError` with `permissionMissing`. It checks again when the app returns to the foreground.
- Orientation is fixed when recording starts.
- Unmounting the component during a Live Recording stops it with `reason: 'user'`. The upload carries on.

`CameraError`:

```ts
type CameraError = {
  code: 'permissionMissing' | 'cameraUnavailable' | 'unknown';
  message: string;
};
```

#### Ref: `StreamingCameraRef`

```ts
startRecording(options: StartRecordingOptions): Promise<{ recordingId: RecordingId }>;
stopRecording(): Promise<void>; // reason 'user'; resolves once the Recording is Finished
```

`startRecording` rejects with a `RecordingError` (`error.code`):

| code | when |
|---|---|
| `recordingInProgress` | A Live Recording already exists. Only one is allowed at a time, across all cameras. |
| `cameraNotReady` | The camera isn't showing, for example because a permission is missing. |
| `recordingFailed` | Capture failed to start. |

`StartRecordingOptions`:

| Option | Type | Default | |
|---|---|---|---|
| `uploadUrlProvider` | `UploadUrlProvider` | required | See [Upload URLs](#upload-urls). |
| `keepRecordingFile` | `boolean` | `true` | `false` deletes the Recording File after Upload Complete, and *only* then. It is never deleted because an upload failed. |
| `allowCellular` | `boolean` | `true` | See [Allow Cellular](#allow-cellular). |
| `metadata` | `Record<string, unknown>` | | JSON-serialisable. Passed to the provider and included in every event. The library doesn't read it. |
| `maxDurationSeconds` | `number` | none | Stops with `maxDuration` when reached. |
| `minChunkSize` | `number` (bytes) | 1 MiB | Must be a multiple of 256 KiB. While recording, a Chunk is sent once the Backlog reaches this size. |

#### Stop reasons

Every stop produces a valid Finished Recording and fires `onRecordingStopped`.

| `StopReason` | trigger |
|---|---|
| `user` | `stopRecording()` or component unmount |
| `interrupted` | phone call or audio session interruption |
| `lowStorage` | free disk space below 200 MB |
| `maxDuration` | `maxDurationSeconds` reached |
| `backgrounded` | app moved to the background |

If the app is killed mid-capture, the Recording appears on the next launch with `interrupted: true`. It is cut back to the last complete Fragment (at most about 2 s of video is lost) and uploads as normal.

### `RecordingUploads`

Uploads are separate from the component and keep running after it unmounts.

```ts
RecordingUploads.getRecordings(): Promise<Recording[]>;
RecordingUploads.resumeUploads(opts: { uploadUrlProvider: UploadUrlProvider }): Promise<void>;
RecordingUploads.retryUpload(id: RecordingId, opts: { uploadUrlProvider: UploadUrlProvider }): Promise<void>;
RecordingUploads.deleteRecording(id: RecordingId): Promise<void>;
RecordingUploads.addListener(event, listener): { remove(): void };
```

- **`getRecordings`** returns every Recording the library knows about, including the Live Recording.
- **`resumeUploads`**: after an app relaunch, every unfinished upload waits in `paused` / `awaitingResume`. The library does nothing on its own at launch. Call `resumeUploads` to restart them, oldest first. Each sends a status query to its stored Upload URL and continues from the server's **Committed Offset**. Recordings that never got a URL ask `uploadUrlProvider`.
- **`retryUpload`** (**Retry Upload**) applies to a `failed` upload, and does nothing in any other state. It gets a fresh Upload URL from the provider and re-uploads from byte 0. A Committed Offset never carries over between URLs.
- **`deleteRecording`** works in any upload state. It cancels the upload and deletes the Recording File and the stored state, including headers. It rejects for the Live Recording and for an unknown id.

Events:

```ts
RecordingUploads.addListener('uploadProgress', (e: {
  recordingId: RecordingId; metadata?: Metadata; recordedBytes: number; committedOffset: number;
}) => {});

RecordingUploads.addListener('uploadStateChange', (e: {
  recordingId: RecordingId; metadata?: Metadata; state: UploadState; pauseReason?: PauseReason;
}) => {});

RecordingUploads.addListener('uploadError', (e: {
  recordingId: RecordingId; metadata?: Metadata; error: UploadError;
}) => {});
```

`uploadProgress` fires at most once every 250 ms per Recording. Progress is `committedOffset / recordedBytes`. `recordedBytes` keeps growing while the Recording is live.

### Permissions

```ts
requestPermissions(opts: { audio: boolean }): Promise<PermissionStatus>;
getPermissionStatus(): Promise<PermissionStatus>;

type PermissionState = 'granted' | 'denied' | 'undetermined' | 'restricted';
type PermissionStatus = { camera: PermissionState; microphone: PermissionState };
```

`requestPermissions` prompts for the camera, and for the microphone when `audio` is `true`. It doesn't prompt again for a permission that's already decided. `getPermissionStatus` never prompts. Android never returns `restricted`. Your app owns all permission UI, such as explaining the need first or linking to Settings.

### Types

```ts
type RecordingId = string; // UUID generated by the library
type Metadata = Record<string, unknown>;

type UploadTarget = { url: string; headers?: Record<string, string> };
type UploadUrlProvider = (ctx: { recordingId: RecordingId; metadata?: Metadata }) => Promise<UploadTarget>;

type Recording = {
  id: RecordingId;
  metadata?: Metadata;
  isLive: boolean;
  interrupted: boolean;      // app was killed mid-capture
  stopReason?: StopReason;   // set once Finished
  filePath: string | null;   // null once the file is deleted
  recordedBytes: number;
  committedOffset: number;   // bytes the server has confirmed
  uploadState: UploadState;
  pauseReason?: PauseReason;
  error?: UploadError;
  keepRecordingFile: boolean;
  allowCellular: boolean;
  createdAt: string;         // ISO 8601
};

type UploadState = 'waitingForUrl' | 'uploading' | 'paused' | 'finalizing' | 'completed' | 'failed';
type PauseReason = 'offline' | 'backgrounded' | 'deprioritized' | 'awaitingWifi' | 'awaitingResume';
type StopReason = 'user' | 'interrupted' | 'lowStorage' | 'maxDuration' | 'backgrounded';

type UploadError = {
  code: 'urlProviderFailed' | 'urlRejected' | 'fileMissing' | 'unknown';
  httpStatus?: number;
  message: string;
};
```

Also exported: `VideoOptions`, `CameraPosition`, `CameraError`, `RecordingError`, `RecordingErrorCode`, `RecordingStoppedInfo`, `StreamingCameraProps`, `StreamingCameraRef`, and the event types `UploadProgressEvent`, `UploadStateChangeEvent`, `UploadErrorEvent`, `RecordingUploadsEvents`, `RecordingUploadsEventName` and `Subscription`.

## How uploads behave

### Upload states

```
waitingForUrl ──url──▶ uploading ──stop & backlog drained──▶ finalizing ──200/201──▶ completed
      │                  ▲   │
      │ provider fails   │   │ offline / backgrounded / deprioritized / awaitingWifi / awaitingResume
      ▼                  │   ▼
    failed ◀──4xx────── paused
      │
      └──retryUpload──▶ waitingForUrl (byte 0)
```

**Upload Complete** (`completed`) means the Upload URL accepted the final Chunk. It says nothing about whether Mux has finished processing the video.

### Errors and retries

| condition | behaviour |
|---|---|
| network error, `408`, `429`, `5xx` | Retried indefinitely with exponential backoff (1 s up to 30 s, with jitter). A status query runs before resending. |
| offline | `paused` / `offline`, resumes when connectivity returns |
| `404`, `410` (expired), other `4xx` | `failed` / `urlRejected` straight away. Call `retryUpload`. |
| Upload Url Provider throws | `failed` / `urlProviderFailed` |
| Recording File missing | `failed` / `fileMissing` |

### Priority and the Upload Queue

- The Live Recording always has upload priority. While it exists, every Recording in the Upload Queue is `paused` / `deprioritized`.
- The Upload Queue uploads one Recording at a time, oldest first.

### Allow Cellular

`allowCellular: false` only affects an upload that *restarts after a pause* (offline, backgrounded, deprioritized, or relaunch). It then waits in `paused` / `awaitingWifi` while the device is on a cellular network. Wi-Fi and other networks (for example Ethernet) are both allowed. An upload that is already running carries on over any network until Upload Complete. In practice, the Live Recording uploads on any network.

### Foreground-only uploading

In v1, uploads run only while your app is in the foreground and its JavaScript runtime is alive:

- When the app goes to the background, any Live Recording stops (`backgrounded`) and all uploads go to `paused` / `backgrounded`. They carry on automatically when the app returns to the foreground.
- After the app is killed or relaunched, uploads wait in `awaitingResume` until you call `resumeUploads`. Call it at startup, or wherever suits your app.

### Files and persistence

- Recording Files live in app-private, non-cache storage: Application Support on iOS, `filesDir` on Android. This isn't configurable.
- For each Recording the library persists its id, metadata, file path, Upload Target (including headers), Committed Offset, upload state and options, in app-private storage.

## What v1 doesn't do

- **Expo** (planned for v2).
- **True background uploading** via background `URLSession` / WorkManager (planned for v2). Uploads run in the foreground only.
- **Other upload protocols**, such as S3 multipart or tus. Only Mux / GCS-style resumable `PUT` is supported.
- **Pausing and resuming a recording**, **switching cameras mid-recording**, filters and overlays.
- **Any backend.** Your backend creates Upload URLs.
- **Calling the Mux API.** The library's job ends at Upload Complete. Use Mux webhooks or its API to know when the asset is ready.

## Example app

[`example/`](example/) records with `<StreamingCamera>` and lists Recordings with their upload state, progress and errors. It has retry, delete and "Resume uploads" actions. See [example/README.md](example/README.md).

## Development

```sh
yarn                # install
yarn typecheck      # tsc
yarn lint           # ESLint + Prettier
yarn test           # Jest (library + example logic)
yarn mock-server    # mock resumable server (see mock-server/README.md)

# iOS: library XCTest
cd example && bundle install && bundle exec pod install --project-directory=ios
cd ios && xcodebuild test -workspace RnCameraExample.xcworkspace \
  -scheme RnCamera-Unit-Tests -destination "id=$(node ../../scripts/ios-simulator-udid.js)"

# Android: library JUnit
cd example/android && ./gradlew :thivatm_rn-camera:testDebugUnitTest
```

| Path | What |
|---|---|
| `src/` | TypeScript: public API, shared upload engine (`src/engine/`, `src/uploads/`), recording coordination (`src/recording/`), codegen specs (`src/specs/`) |
| `ios/` | Swift capture (AVFoundation, `AVAssetWriter`) and native upload primitives, XCTest in `ios/Tests/` |
| `android/` | Kotlin capture (CameraX, MediaCodec, Media3 fragmented MP4) and native upload primitives, JUnit in `android/src/test/` |
| `mock-server/` | Node mock resumable server with fault injection |
| `example/` | Example app |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the example app workflow.

## License

MIT
