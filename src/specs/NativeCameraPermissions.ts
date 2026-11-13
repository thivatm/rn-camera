import { TurboModuleRegistry, type TurboModule } from 'react-native';

/**
 * Raw status strings as reported by native. Expected values are
 * 'granted' | 'denied' | 'undetermined' | 'restricted'; `src/permissions.ts`
 * narrows them to `PermissionStatus`.
 */
export type NativePermissionStatus = {
    camera: string;
    microphone: string;
};

/**
 * Codegen spec for the `CameraPermissions` Turbo Module (spec §3.4).
 * Kept separate from `RecordingUploads` so the camera and upload sides of
 * the library evolve independently.
 */
export interface Spec extends TurboModule {
    /** Requests camera access, and microphone access when `audio` is true. */
    requestPermissions(audio: boolean): Promise<NativePermissionStatus>;
    getPermissionStatus(): Promise<NativePermissionStatus>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('CameraPermissions');
