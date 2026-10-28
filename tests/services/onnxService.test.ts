import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));

import { ASR_MODEL, ASR_VOCAB, downloadModel, inspectSpeechModels, LocalSpeechModelError } from '../../src/services/onnxService';

beforeEach(() => {
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'get_models_dir') return 'G:/models';
    if (command === 'check_model_exists') return true;
    if (command === 'download_onnx_model') return JSON.stringify({ path: 'G:/models/prepared', size_bytes: 10, cached: false });
    if (command === 'cancel_file_transfer') return;
    throw new Error(`Unexpected command ${command}`);
  });
  mocks.unlisten.mockReset(); mocks.listen.mockReset().mockResolvedValue(mocks.unlisten);
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('共享本地语音模型管理', () => {
  it.each([
    [[], true], [[ASR_MODEL], false], [[ASR_VOCAB], false], [[ASR_MODEL, ASR_VOCAB], false],
  ] as const)('checks both registered assets and reports missing %j', async (missing, ready) => {
    mocks.invoke.mockImplementation(async (command: string, args?: { modelName?: string }) => {
      if (command === 'get_models_dir') return 'G:/models';
      if (command === 'check_model_exists') return !missing.some((name) => name === args?.modelName);
      throw new Error('Unexpected download during readiness inspection');
    });
    expect(await inspectSpeechModels()).toEqual({ ready, missing });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'check_model_exists').map(([, args]) => args.modelName))
      .toEqual([ASR_MODEL, ASR_VOCAB]);
  });

  it.each([
    [ASR_MODEL, 'model_int8.onnx'], [ASR_VOCAB, 'vocab.txt'],
  ])('downloads %s from an immutable upstream revision', async (name, file) => {
    const result = await downloadModel(name, { taskId: 'speech-download' });
    expect(result).toMatchObject({ cached: false, size_bytes: 10 });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('download_onnx_model', {
      modelName: name, taskId: 'speech-download',
      url: `https://huggingface.co/OpenVoiceOS/sensevoice-small-onnx/resolve/b516ca0856c65dd31c8af81459352acac79ccf6c/${file}`,
    });
  });

  it.each(['string', 'error'])('preserves a safe native download reason returned as %s', async (kind) => {
    const message = '语音模型下载失败：国内镜像连接超时，请稍后重试';
    mocks.invoke.mockRejectedValueOnce(kind === 'string' ? message : new Error(message));
    const failure = await downloadModel(ASR_MODEL).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LocalSpeechModelError);
    expect(failure).toMatchObject({ message });
  });

  it('hides unclassified native exceptions instead of exposing URLs, local paths or credentials', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('G:/private/model.onnx https://private.invalid/?token=secret-token'));
    const failure = await downloadModel(ASR_VOCAB).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LocalSpeechModelError);
    expect((failure as Error).message).toBe('本地语音模型准备失败，请检查模型下载连接和本地存储权限');
    expect((failure as Error).message).not.toMatch(/https?:|G:\/|private|token/);
  });

  it('does not reclassify cancellation before a transfer as a speech-model failure', async () => {
    const controller = new AbortController(); controller.abort();
    const failure = await downloadModel(ASR_MODEL, { signal: controller.signal }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(failure).not.toBeInstanceOf(LocalSpeechModelError); expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('cancels an active native transfer once and removes its progress listener without returning a model failure', async () => {
    let rejectDownload!: (reason: unknown) => void;
    mocks.invoke.mockImplementation((command: string) => command === 'download_onnx_model'
      ? new Promise((_, reject) => { rejectDownload = reject; }) : Promise.resolve());
    const controller = new AbortController();
    const pending = downloadModel(ASR_MODEL, { signal: controller.signal, taskId: 'cancel-speech', onProgress: vi.fn() });
    await vi.waitFor(() => expect(rejectDownload).toBeTypeOf('function'));
    controller.abort(); controller.abort();
    rejectDownload('语音模型下载失败：连接已取消');
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'AbortError' }); expect(failure).not.toBeInstanceOf(LocalSpeechModelError);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'cancel_file_transfer'))
      .toEqual([['cancel_file_transfer', { taskId: 'cancel-speech' }]]);
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
});
