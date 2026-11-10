# @thivatm/rn-camera

React Native camera that records video and uploads it in Chunks to a resumable Upload URL while it is still recording. New Architecture only (Turbo Modules + Fabric).

> Work in progress (v1). Full docs arrive with the example app.

## Layout

| Path | What |
|---|---|
| `src/types.ts` | Public types (spec §3.1), re-exported from `src/index.tsx` |
| `src/specs/` | Codegen specs: `NativeRecordingUploads.ts` (Turbo Module `RecordingUploads`), `StreamingCameraNativeComponent.ts` (Fabric view `StreamingCamera`) |
| `ios/RecordingUploads/`, `ios/StreamingCamera/` | ObjC++ codegen shims + Swift implementations |
| `ios/Tests/` | XCTest (pod test spec `RnCamera/Tests`) |
| `android/src/main/java/com/thivatm/rncamera/{uploads,camera}/` | Kotlin module and view manager |
| `android/src/test/` | JUnit tests |

## Development

```sh
yarn                # install
yarn typecheck      # tsc
yarn lint           # ESLint + Prettier
yarn test           # Jest

# iOS: library XCTest
cd example && bundle install && bundle exec pod install --project-directory=ios
cd ios && xcodebuild test -workspace RnCameraExample.xcworkspace \
  -scheme RnCamera-Unit-Tests -destination "id=$(node ../../scripts/ios-simulator-udid.js)"

# Android: library JUnit
cd example/android && ./gradlew :thivatm_rn-camera:testDebugUnitTest
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the example app workflow.

## License

MIT
