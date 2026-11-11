# @thivatm/rn-camera example

A small app for manual end-to-end checks. It has two tabs:

- **Camera** shows a preview with record and stop, plus a flip button. Switching tabs unmounts the camera, which stops a Live Recording with reason `user`. The upload carries on.
- **Recordings** lists every Recording with its upload state, progress and errors. It has **Retry** (for failed uploads), **Delete**, and **Resume uploads**, which you need after an app relaunch.

## Upload URLs

The app never holds Mux credentials. It asks a backend URL you configure in [`src/config.ts`](src/config.ts) (`UPLOAD_URL_BACKEND`). The app sends `POST { recordingId, metadata }`, and the backend replies `{ url }` (optionally with `headers`).

Pick one:

- **Mock server (default, no account needed):** run `yarn mock-server` from the repo root. Its `POST /__control/uploads` returns `{ url }`. The default config points the iOS simulator at `localhost:8787` and the Android emulator at `10.0.2.2:8787`. On a real device, run `node mock-server/cli.mjs --host 0.0.0.0` and use your machine's LAN address.
- **Mux:** run `MUX_TOKEN_ID=… MUX_TOKEN_SECRET=… node example/backend/mux-upload-url.mjs` from the repo root, and set `UPLOAD_URL_BACKEND` to `http://<your machine>:3000/uploads`. It creates a Mux direct upload with a 4-hour `timeout` and returns its URL.

## Running

From the repo root:

```sh
yarn
yarn example start          # Metro

yarn example android
# iOS
cd example && bundle install && bundle exec pod install --project-directory=ios && cd ..
yarn example ios
```

Recording needs a real camera. Simulators and emulators can build and run the app, but they may report `cameraUnavailable`.
