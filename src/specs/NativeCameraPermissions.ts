import { TurboModuleRegistry, type TurboModule } from 'react-native';
import type { PermissionStatus } from '../types';

/** Codegen spec for the `CameraPermissions` Turbo Module (spec §3.4). */
export interface Spec extends TurboModule {
  requestPermissions(options: { audio: boolean }): Promise<PermissionStatus>;
  getPermissionStatus(): Promise<PermissionStatus>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('CameraPermissions');
