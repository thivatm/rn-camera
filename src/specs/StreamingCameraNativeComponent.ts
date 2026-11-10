import { codegenNativeComponent, type ViewProps } from 'react-native';

/**
 * Codegen spec for the `StreamingCamera` Fabric view (spec §3.2). Empty until
 * the camera tickets add props, events and commands.
 */
export interface NativeProps extends ViewProps {}

export default codegenNativeComponent<NativeProps>('StreamingCamera');
