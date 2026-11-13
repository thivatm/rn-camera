import NativeCameraPermissions, {
    type NativePermissionStatus,
} from './specs/NativeCameraPermissions';
import type { PermissionState, PermissionStatus } from './types';

const STATES: readonly PermissionState[] = [
    'granted',
    'denied',
    'undetermined',
    'restricted',
];

function toState(raw: string): PermissionState {
    return (STATES as readonly string[]).includes(raw)
        ? (raw as PermissionState)
        : 'undetermined';
}

function toStatus(raw: NativePermissionStatus): PermissionStatus {
    return { camera: toState(raw.camera), microphone: toState(raw.microphone) };
}

/**
 * Prompts for camera access, and microphone access when `audio` is true.
 * Already-decided permissions are not re-prompted. Spec §3.4.
 */
export async function requestPermissions(opts: {
    audio: boolean;
}): Promise<PermissionStatus> {
    return toStatus(
        await NativeCameraPermissions.requestPermissions(opts.audio)
    );
}

/** Current camera and microphone status, without prompting. Spec §3.4. */
export async function getPermissionStatus(): Promise<PermissionStatus> {
    return toStatus(await NativeCameraPermissions.getPermissionStatus());
}
