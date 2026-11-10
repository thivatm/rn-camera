import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { StreamingCamera } from '../index';
import NativeCameraPermissions from '../specs/NativeCameraPermissions';

jest.mock('../specs/NativeCameraPermissions', () => ({
  __esModule: true,
  default: {
    requestPermissions: jest.fn(),
    getPermissionStatus: jest.fn(),
  },
}));

const native = jest.mocked(NativeCameraPermissions);

function grant(camera: string, microphone: string) {
  native.getPermissionStatus.mockResolvedValue({ camera, microphone });
}

describe('<StreamingCamera> (§3.2)', () => {
  it('shows the camera preview with the given props once permission is granted', async () => {
    grant('granted', 'granted');

    await render(
      <StreamingCamera
        testID="camera"
        position="front"
        torch
        zoom={2}
        enablePinchToZoom
        enableTapToFocus
        video={{
          codec: 'hevc',
          resolution: '720p',
          fps: 60,
          bitrate: 5_000_000,
        }}
      />
    );

    const preview = await screen.findByTestId('camera');
    expect(preview.props).toMatchObject({
      position: 'front',
      torch: true,
      zoom: 2,
      enablePinchToZoom: true,
      enableTapToFocus: true,
      audio: true,
      videoCodec: 'hevc',
      videoResolution: '720p',
      videoFps: 60,
      videoBitrate: 5_000_000,
    });
  });

  it('renders nothing and reports onError without camera permission', async () => {
    grant('denied', 'granted');
    const onError = jest.fn();

    await render(<StreamingCamera testID="camera" onError={onError} />);

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'permissionMissing' })
      )
    );
    expect(screen.queryByTestId('camera')).toBeNull();
  });

  it('needs microphone permission only when audio is on', async () => {
    grant('granted', 'denied');
    const onError = jest.fn();

    await render(<StreamingCamera testID="camera" onError={onError} />);
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'permissionMissing' })
      )
    );
    expect(screen.queryByTestId('camera')).toBeNull();

    await render(
      <StreamingCamera testID="silent" audio={false} onError={onError} />
    );
    expect(await screen.findByTestId('silent')).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports errors raised by the native camera', async () => {
    grant('granted', 'granted');
    const onError = jest.fn();

    await render(<StreamingCamera testID="camera" onError={onError} />);
    fireEvent(await screen.findByTestId('camera'), 'cameraError', {
      nativeEvent: { code: 'cameraUnavailable', message: 'No camera' },
    });

    expect(onError).toHaveBeenCalledWith({
      code: 'cameraUnavailable',
      message: 'No camera',
    });
  });

  it('shows the preview once permission is granted in Settings and the app returns', async () => {
    const listeners: Array<(state: AppStateStatus) => void> = [];
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_type, listener) => {
        listeners.push(listener);
        return { remove: jest.fn() };
      });
    grant('denied', 'denied');

    await render(<StreamingCamera testID="camera" audio={false} />);
    await waitFor(() => expect(native.getPermissionStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('camera')).toBeNull();

    grant('granted', 'denied');
    await act(async () => listeners.forEach((l) => l('active')));

    expect(await screen.findByTestId('camera')).toBeTruthy();
  });
});
