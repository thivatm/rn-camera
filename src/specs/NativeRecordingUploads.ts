import { TurboModuleRegistry, type TurboModule } from 'react-native';

/**
 * Codegen spec for the `RecordingUploads` Turbo Module: the thin native
 * primitives behind the shared TS upload engine (chunk transport, file and
 * storage primitives, connectivity signals). See the Transport / Platform seam
 * in the v1 architecture notes. Empty until the native transport tickets add
 * methods.
 */
export interface Spec extends TurboModule {}

export default TurboModuleRegistry.getEnforcing<Spec>('RecordingUploads');
