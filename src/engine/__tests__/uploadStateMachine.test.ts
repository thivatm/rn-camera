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

  test('events that do not apply to a state throw', () => {
    expect(() =>
      transition({ state: 'completed' }, { type: 'uploadTargetReceived' })
    ).toThrow(/completed.*uploadTargetReceived/);
    expect(() =>
      transition(INITIAL_UPLOAD_STATUS, { type: 'uploadCompleted' })
    ).toThrow();
  });
});
