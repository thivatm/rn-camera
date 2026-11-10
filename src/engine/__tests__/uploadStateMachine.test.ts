import {
  INITIAL_UPLOAD_STATUS,
  transition,
  type UploadStatus,
} from '../uploadStateMachine';

describe('§5.6 upload state machine (happy path)', () => {
  test('starts in waitingForUrl', () => {
    expect(INITIAL_UPLOAD_STATUS).toEqual({ state: 'waitingForUrl' });
  });

  test('waitingForUrl → uploading → finalizing → completed', () => {
    let status: UploadStatus = INITIAL_UPLOAD_STATUS;
    status = transition(status, { type: 'uploadTargetReceived' });
    expect(status).toEqual({ state: 'uploading' });
    status = transition(status, { type: 'finalChunkStarted' });
    expect(status).toEqual({ state: 'finalizing' });
    status = transition(status, { type: 'uploadCompleted' });
    expect(status).toEqual({ state: 'completed' });
  });

  test('a provider failure fails with urlProviderFailed', () => {
    expect(
      transition(INITIAL_UPLOAD_STATUS, {
        type: 'uploadUrlProviderFailed',
        message: 'backend down',
      })
    ).toEqual({
      state: 'failed',
      error: { code: 'urlProviderFailed', message: 'backend down' },
    });
  });

  test('resending the final Chunk keeps finalizing', () => {
    expect(
      transition({ state: 'finalizing' }, { type: 'finalChunkStarted' })
    ).toEqual({ state: 'finalizing' });
  });

  test('an upload failure while uploading fails with its error', () => {
    const error = { code: 'unknown', message: 'boom' } as const;
    expect(
      transition({ state: 'uploading' }, { type: 'uploadFailed', error })
    ).toEqual({ state: 'failed', error });
  });

  test('going offline pauses uploading or finalizing; resuming re-enters uploading', () => {
    for (const state of ['uploading', 'finalizing'] as const) {
      const paused = transition(
        { state },
        { type: 'paused', reason: 'offline' }
      );
      expect(paused).toEqual({ state: 'paused', pauseReason: 'offline' });
      expect(transition(paused, { type: 'resumed' })).toEqual({
        state: 'uploading',
      });
    }
  });

  test('an upload that may not start when its Upload Target arrives goes straight to paused', () => {
    expect(
      transition(
        { state: 'waitingForUrl' },
        { type: 'paused', reason: 'deprioritized' }
      )
    ).toEqual({ state: 'paused', pauseReason: 'deprioritized' });
  });

  test('Retry Upload takes a failed upload back to waitingForUrl', () => {
    const failed: UploadStatus = {
      state: 'failed',
      error: { code: 'urlRejected', httpStatus: 410, message: 'gone' },
    };
    expect(transition(failed, { type: 'retryRequested' })).toEqual({
      state: 'waitingForUrl',
    });
    expect(() =>
      transition({ state: 'completed' }, { type: 'retryRequested' })
    ).toThrow();
    expect(() =>
      transition({ state: 'uploading' }, { type: 'retryRequested' })
    ).toThrow();
  });

  test('events that do not apply to a state throw', () => {
    expect(() =>
      transition({ state: 'completed' }, { type: 'uploadTargetReceived' })
    ).toThrow(/completed.*uploadTargetReceived/);
    expect(() =>
      transition(INITIAL_UPLOAD_STATUS, { type: 'uploadCompleted' })
    ).toThrow();
  });
});
