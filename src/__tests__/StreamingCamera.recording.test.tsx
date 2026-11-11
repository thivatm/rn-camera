import { act, render, screen } from '@testing-library/react-native';
import { createRef } from 'react';
import { StreamingCamera, type StreamingCameraRef } from '../index';
import NativeCameraPermissions from '../specs/NativeCameraPermissions';
import NativeRecordingUploads from '../specs/NativeRecordingUploads';
import { Commands } from '../specs/StreamingCameraNativeComponent';
import NativeRecorder from '../specs/NativeStreamingCameraRecorder';
import { getRecordingUploadsManager } from '../uploads';

// ---- Native seams: the camera view's commands, the recorder's events, and
// the capture-facing upload registry.

jest.mock('../specs/NativeCameraPermissions', () => ({
  __esModule: true,
  default: {
    requestPermissions: jest.fn(),
    getPermissionStatus: jest.fn(),
  },
}));

jest.mock('../specs/StreamingCameraNativeComponent', () => ({
  __esModule: true,
  default: jest.requireActual('../specs/StreamingCameraNativeComponent')
    .default,
  Commands: { startRecording: jest.fn(), stopRecording: jest.fn() },
}));

type MockListener = (event: unknown) => void;
jest.mock('../specs/NativeStreamingCameraRecorder', () => {
  const emitter = () => {
    const listeners = new Set<MockListener>();
    const on = (listener: MockListener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    };
    on.emit = (event: unknown) => listeners.forEach((l) => l(event));
    return on;
  };
  return {
    __esModule: true,
    default: {
      onRecordingStarted: emitter(),
      onRecordingFragment: emitter(),
      onRecordingStopped: emitter(),
      onRecordingFailed: emitter(),
    },
  };
});

jest.mock('../specs/NativeRecordingUploads', () => ({
  __esModule: true,
  default: { getFreeDiskSpace: jest.fn() },
}));

jest.mock('../uploads', () => {
  const live = { id: null as string | null };
  const fake = {
    live,
    registerLiveRecording: jest.fn((input: { recordingId: string }) => {
      live.id = input.recordingId;
    }),
    reportFileGrowth: jest.fn(),
    reportRecordingStopped: jest.fn(() => {
      live.id = null;
    }),
    liveRecordingId: jest.fn(() => live.id),
  };
  return {
    ...jest.requireActual('../uploads'),
    getRecordingUploadsManager: () => fake,
  };
});

type Emitter = { emit(e: unknown): void };
const recorder = NativeRecorder as unknown as Record<string, Emitter>;
const commands = jest.mocked(Commands);
const uploads = getRecordingUploadsManager() as unknown as {
  live: { id: string | null };
  registerLiveRecording: jest.Mock;
  reportFileGrowth: jest.Mock;
  reportRecordingStopped: jest.Mock;
};
const freeDiskSpace = jest.mocked(NativeRecordingUploads.getFreeDiskSpace);

const MB = 1024 * 1024;
const provider = jest.fn(async () => ({ url: 'https://upload.example' }));

/** What the native camera does when told to start: start, then report. */
function nativeStarts() {
  commands.startRecording.mockImplementation((_view, recordingId) => {
    recorder.onRecordingStarted!.emit({
      recordingId,
      filePath: `/app-support/rn-camera/recordings/${recordingId}.mp4`,
    });
  });
}

function nativeStopsWith(finalSize: number) {
  commands.stopRecording.mockImplementation((_view, reason) => {
    const recordingId = commands.startRecording.mock.calls.at(-1)![1];
    recorder.onRecordingStopped!.emit({ recordingId, reason, finalSize });
  });
}

async function renderCamera(props: { onRecordingStopped?: jest.Mock } = {}) {
  const ref = createRef<StreamingCameraRef>();
  const view = await render(
    <StreamingCamera ref={ref} testID="camera" {...props} />
  );
  await screen.findByTestId('camera');
  return { ref, view };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(NativeCameraPermissions.getPermissionStatus).mockResolvedValue({
    camera: 'granted',
    microphone: 'granted',
  });
  freeDiskSpace.mockResolvedValue(10_000 * MB);
  uploads.live.id = null;
  nativeStarts();
  nativeStopsWith(0);
});

afterEach(() => {
  // Finish whatever a test left live, so the app-wide coordinator starts clean.
  for (const [, recordingId] of commands.startRecording.mock.calls) {
    recorder.onRecordingStopped!.emit({
      recordingId,
      reason: 'user',
      finalSize: 0,
    });
    recorder.onRecordingFailed!.emit({ recordingId, message: 'cleanup' });
  }
});

describe('StreamingCamera recording (§3.2, §4)', () => {
  it('starts a Live Recording and registers it for upload without waiting for a URL', async () => {
    const { ref } = await renderCamera();
    const options = { uploadUrlProvider: provider, metadata: { take: 1 } };

    const { recordingId } = await act(() =>
      ref.current!.startRecording(options)
    );

    expect(recordingId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(commands.startRecording).toHaveBeenCalledWith(
      expect.anything(),
      recordingId
    );
    expect(uploads.registerLiveRecording).toHaveBeenCalledWith({
      recordingId,
      filePath: `/app-support/rn-camera/recordings/${recordingId}.mp4`,
      options,
    });
  });

  it('allows only one Live Recording at a time, across cameras', async () => {
    const first = await renderCamera();
    const { recordingId } = await act(() =>
      first.ref.current!.startRecording({ uploadUrlProvider: provider })
    );
    const second = await renderCamera();

    await expect(
      second.ref.current!.startRecording({ uploadUrlProvider: provider })
    ).rejects.toMatchObject({ code: 'recordingInProgress' });
    await expect(
      first.ref.current!.startRecording({ uploadUrlProvider: provider })
    ).rejects.toMatchObject({ code: 'recordingInProgress' });
    expect(commands.startRecording).toHaveBeenCalledTimes(1);

    await act(() => first.ref.current!.stopRecording());
    const next = await act(() =>
      second.ref.current!.startRecording({ uploadUrlProvider: provider })
    );
    expect(next.recordingId).not.toBe(recordingId);
    await act(() => second.ref.current!.stopRecording());
  });

  it('rejects a second start while the first is still starting', async () => {
    commands.startRecording.mockImplementation(() => {});
    const { ref } = await renderCamera();

    const pending = ref.current!.startRecording({
      uploadUrlProvider: provider,
    });
    await expect(
      ref.current!.startRecording({ uploadUrlProvider: provider })
    ).rejects.toMatchObject({ code: 'recordingInProgress' });

    const recordingId = commands.startRecording.mock.calls[0]![1];
    recorder.onRecordingFailed!.emit({ recordingId, message: 'no camera' });
    await expect(pending).rejects.toMatchObject({ code: 'recordingFailed' });
    expect(uploads.registerLiveRecording).not.toHaveBeenCalled();
  });

  it('forwards each appended Fragment to the upload as file growth', async () => {
    const { ref } = await renderCamera();
    const { recordingId } = await act(() =>
      ref.current!.startRecording({ uploadUrlProvider: provider })
    );

    recorder.onRecordingFragment!.emit({ recordingId, recordedBytes: 1_200 });
    recorder.onRecordingFragment!.emit({ recordingId, recordedBytes: 900_000 });

    expect(uploads.reportFileGrowth.mock.calls).toEqual([
      [recordingId, 1_200],
      [recordingId, 900_000],
    ]);
    await act(() => ref.current!.stopRecording());
  });

  it('stopRecording finishes the recording with reason user', async () => {
    nativeStopsWith(4_321_000);
    const onRecordingStopped = jest.fn();
    const { ref } = await renderCamera({ onRecordingStopped });
    const { recordingId } = await act(() =>
      ref.current!.startRecording({ uploadUrlProvider: provider })
    );

    await act(() => ref.current!.stopRecording());

    expect(commands.stopRecording).toHaveBeenCalledWith(
      expect.anything(),
      'user'
    );
    expect(uploads.reportRecordingStopped).toHaveBeenCalledWith(recordingId, {
      finalSize: 4_321_000,
      reason: 'user',
    });
    expect(onRecordingStopped).toHaveBeenCalledWith({
      recordingId,
      reason: 'user',
    });
  });

  it('stops with maxDuration once maxDurationSeconds have passed', async () => {
    jest.useFakeTimers();
    try {
      const onRecordingStopped = jest.fn();
      const { ref } = await renderCamera({ onRecordingStopped });
      const { recordingId } = await act(() =>
        ref.current!.startRecording({
          uploadUrlProvider: provider,
          maxDurationSeconds: 30,
        })
      );

      await act(async () => jest.advanceTimersByTime(29_999));
      expect(commands.stopRecording).not.toHaveBeenCalled();
      await act(async () => jest.advanceTimersByTime(1));

      expect(commands.stopRecording).toHaveBeenCalledWith(
        expect.anything(),
        'maxDuration'
      );
      expect(onRecordingStopped).toHaveBeenCalledWith({
        recordingId,
        reason: 'maxDuration',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops with lowStorage when free disk space drops below 200 MB', async () => {
    const onRecordingStopped = jest.fn();
    const { ref } = await renderCamera({ onRecordingStopped });
    const { recordingId } = await act(() =>
      ref.current!.startRecording({ uploadUrlProvider: provider })
    );

    freeDiskSpace.mockResolvedValue(201 * MB);
    await act(async () =>
      recorder.onRecordingFragment!.emit({ recordingId, recordedBytes: 10 })
    );
    expect(commands.stopRecording).not.toHaveBeenCalled();

    freeDiskSpace.mockResolvedValue(199 * MB);
    await act(async () =>
      recorder.onRecordingFragment!.emit({ recordingId, recordedBytes: 20 })
    );

    expect(commands.stopRecording).toHaveBeenCalledWith(
      expect.anything(),
      'lowStorage'
    );
    expect(onRecordingStopped).toHaveBeenCalledWith({
      recordingId,
      reason: 'lowStorage',
    });
  });

  it.each(['interrupted', 'backgrounded'] as const)(
    'reports a recording native stopped as %s',
    async (reason) => {
      const onRecordingStopped = jest.fn();
      const { ref } = await renderCamera({ onRecordingStopped });
      const { recordingId } = await act(() =>
        ref.current!.startRecording({ uploadUrlProvider: provider })
      );

      await act(async () =>
        recorder.onRecordingStopped!.emit({
          recordingId,
          reason,
          finalSize: 777,
        })
      );

      expect(uploads.reportRecordingStopped).toHaveBeenCalledWith(recordingId, {
        finalSize: 777,
        reason,
      });
      expect(onRecordingStopped).toHaveBeenCalledWith({ recordingId, reason });
      await act(() => ref.current!.stopRecording());
      expect(commands.stopRecording).not.toHaveBeenCalled();
    }
  );

  it('unmounting stops the recording with reason user and still reports it', async () => {
    const onRecordingStopped = jest.fn();
    const { ref, view } = await renderCamera({ onRecordingStopped });
    const { recordingId } = await act(() =>
      ref.current!.startRecording({ uploadUrlProvider: provider })
    );

    await view.unmount();
    // The native view stops on its own when it unmounts.
    recorder.onRecordingStopped!.emit({
      recordingId,
      reason: 'user',
      finalSize: 55,
    });

    expect(uploads.reportRecordingStopped).toHaveBeenCalledWith(recordingId, {
      finalSize: 55,
      reason: 'user',
    });
    expect(onRecordingStopped).toHaveBeenCalledWith({
      recordingId,
      reason: 'user',
    });
  });

  it('rejects when the camera is not showing', async () => {
    jest.mocked(NativeCameraPermissions.getPermissionStatus).mockResolvedValue({
      camera: 'denied',
      microphone: 'granted',
    });
    const ref = createRef<StreamingCameraRef>();
    await render(<StreamingCamera ref={ref} />);

    await expect(
      ref.current!.startRecording({ uploadUrlProvider: provider })
    ).rejects.toMatchObject({ code: 'cameraNotReady' });
    expect(commands.startRecording).not.toHaveBeenCalled();
  });
});
