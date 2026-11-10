import { getPermissionStatus, requestPermissions } from '../index';
import NativeCameraPermissions from '../specs/NativeCameraPermissions';

jest.mock('../specs/NativeCameraPermissions', () => ({
  __esModule: true,
  default: {
    requestPermissions: jest.fn(),
    getPermissionStatus: jest.fn(),
  },
}));

const native = jest.mocked(NativeCameraPermissions);

describe('permissions (§3.4)', () => {
  it('reports the current camera and microphone status', async () => {
    native.getPermissionStatus.mockResolvedValue({
      camera: 'granted',
      microphone: 'undetermined',
    });

    await expect(getPermissionStatus()).resolves.toEqual({
      camera: 'granted',
      microphone: 'undetermined',
    });
  });

  it('asks for the microphone only when audio is requested', async () => {
    native.requestPermissions.mockResolvedValue({
      camera: 'granted',
      microphone: 'undetermined',
    });
    await expect(requestPermissions({ audio: false })).resolves.toEqual({
      camera: 'granted',
      microphone: 'undetermined',
    });
    expect(native.requestPermissions).toHaveBeenLastCalledWith(false);

    native.requestPermissions.mockResolvedValue({
      camera: 'granted',
      microphone: 'denied',
    });
    await expect(requestPermissions({ audio: true })).resolves.toEqual({
      camera: 'granted',
      microphone: 'denied',
    });
    expect(native.requestPermissions).toHaveBeenLastCalledWith(true);
  });

  it('treats an unrecognised native status as undetermined', async () => {
    native.getPermissionStatus.mockResolvedValue({
      camera: 'restricted',
      microphone: 'somethingNew',
    });

    await expect(getPermissionStatus()).resolves.toEqual({
      camera: 'restricted',
      microphone: 'undetermined',
    });
  });
});
