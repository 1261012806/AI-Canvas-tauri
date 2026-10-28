import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '../../src/types/plugin';

const hooks = vi.hoisted(() => ({
  values: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  callbacks: [] as Array<{ value: unknown; dependencies: readonly unknown[] }>,
  effects: [] as Array<{ dependencies?: readonly unknown[]; pending?: () => void | (() => void); cleanup?: () => void }>,
  stateCursor: 0, refCursor: 0, callbackCursor: 0, effectCursor: 0,
}));
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), download: vi.fn(), confirm: vi.fn(), tauri: true }));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T) => {
    const index = hooks.stateCursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: T | ((previous: T) => T)) => {
      hooks.values[index] = typeof next === 'function' ? (next as (previous: T) => T)(hooks.values[index] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => {
    const index = hooks.refCursor++;
    hooks.refs[index] ??= { current: initial };
    return hooks.refs[index] as { current: T };
  },
  useCallback: <T,>(callback: T, dependencies: readonly unknown[]) => {
    const index = hooks.callbackCursor++;
    const previous = hooks.callbacks[index];
    if (previous && dependencies.length === previous.dependencies.length
      && dependencies.every((value, at) => Object.is(value, previous.dependencies[at]))) return previous.value as T;
    hooks.callbacks[index] = { value: callback, dependencies };
    return callback;
  },
  useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
    const index = hooks.effectCursor++;
    const previous = hooks.effects[index];
    if (previous && dependencies && previous.dependencies?.length === dependencies.length
      && dependencies.every((value, at) => Object.is(value, previous.dependencies?.[at]))) return;
    hooks.effects[index] = { dependencies, pending: effect, cleanup: previous?.cleanup };
  },
}));
vi.mock('../../src/i18n', () => ({
  t: (text: string, variables?: Record<string, string | number>) => text.replace(/\{([^}]+)\}/gu, (_, key: string) => String(variables?.[key] ?? key)),
}));
vi.mock('../../src/services/fileService', () => ({ isTauriEnv: () => mocks.tauri }));
vi.mock('../../src/services/confirmDialog', () => ({ confirmAction: mocks.confirm }));
vi.mock('../../src/services/onnxService', async (importOriginal) => {
  const { LocalSpeechModelError } = await importOriginal<typeof import('../../src/services/onnxService')>();
  return { LocalSpeechModelError, inspectSpeechModels: mocks.inspect, downloadModel: mocks.download };
});

import { usePluginSpeechModels } from '../../src/hooks/usePluginSpeechModels';
import { LocalSpeechModelError } from '../../src/services/onnxService';

const model = 'sensevoice-small-int8.onnx';
const vocab = 'sensevoice-vocab.txt';
const manifest: PluginManifest = {
  apiVersion: 2, id: 'com.example.replica', name: '测试复刻插件', version: '1.0.0',
  runtime: 'python', category: 'media', entry: 'main.py', permissions: [],
  requiredCapabilities: ['video.replicaPipeline'], contributes: { nodeTools: [] },
};

function SpeechModelsHook(inspectInstalled: boolean) {
  return usePluginSpeechModels(inspectInstalled);
}

function renderSpeechModels(inspectInstalled = false) {
  hooks.stateCursor = hooks.refCursor = hooks.callbackCursor = hooks.effectCursor = 0;
  const result = SpeechModelsHook(inspectInstalled);
  for (const effect of hooks.effects) {
    if (!effect.pending) continue;
    effect.cleanup?.();
    const cleanup = effect.pending();
    effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    effect.pending = undefined;
  }
  return result;
}
function dispose() {
  for (const effect of hooks.effects) { effect.cleanup?.(); effect.cleanup = undefined; }
}

beforeEach(() => {
  hooks.values = []; hooks.refs = []; hooks.callbacks = []; hooks.effects = [];
  mocks.tauri = true;
  mocks.inspect.mockReset().mockResolvedValue({ ready: true, missing: [] });
  mocks.download.mockReset().mockResolvedValue({ cached: false });
  mocks.confirm.mockReset().mockResolvedValue(true);
});
afterEach(dispose);

describe('插件语音模型安装准备', () => {
  it('only inspects installed plugin dependencies in the background without prompting or downloading', async () => {
    mocks.inspect.mockResolvedValue({ ready: false, missing: [vocab] });
    renderSpeechModels(true);
    await vi.waitFor(() => expect(mocks.inspect).toHaveBeenCalledOnce());
    expect(renderSpeechModels(true).ready).toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });

  it('does not inspect or download speech assets for unrelated plugins', async () => {
    expect(await renderSpeechModels().prepare({ ...manifest, requiredCapabilities: [] })).toBe(true);
    expect(mocks.inspect).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('does not continue an unrelated installation after the settings panel unmounts', async () => {
    const preparation = renderSpeechModels();
    dispose();
    expect(await preparation.prepare({ ...manifest, requiredCapabilities: [] })).toBe(false);
    expect(mocks.inspect).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
  });

  it('reuses a complete local recognizer without showing a download prompt', async () => {
    expect(await renderSpeechModels().prepare(manifest)).toBe(true);
    expect(renderSpeechModels().ready).toBe(true);
    expect(mocks.inspect).toHaveBeenCalledOnce(); expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it.each([{ missing: [vocab] }, { missing: [model, vocab] }])('downloads only missing files $missing and verifies readiness before continuing', async ({ missing }) => {
    mocks.inspect.mockResolvedValueOnce({ ready: false, missing }).mockResolvedValueOnce({ ready: true, missing: [] });
    expect(await renderSpeechModels().prepare(manifest)).toBe(true);
    expect(mocks.download.mock.calls.map(([name]) => name)).toEqual(missing);
    expect(mocks.inspect).toHaveBeenCalledTimes(2); expect(renderSpeechModels().ready).toBe(true);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining(manifest.name), expect.objectContaining({
      okLabel: '下载并继续安装', cancelLabel: '仅安装插件',
    }));
  });

  it('allows only installing the plugin while preserving the missing dependency state', async () => {
    mocks.inspect.mockResolvedValue({ ready: false, missing: [model, vocab] });
    mocks.confirm.mockResolvedValue(false);
    expect(await renderSpeechModels().prepare(manifest)).toBe(true);
    expect(renderSpeechModels().ready).toBe(false); expect(mocks.download).not.toHaveBeenCalled();
  });

  it('treats cancelling a manual dependency repair as cancellation instead of success', async () => {
    mocks.inspect.mockResolvedValue({ ready: false, missing: [vocab] });
    mocks.confirm.mockResolvedValue(false);
    expect(await renderSpeechModels().prepare(manifest, false)).toBe(false);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.not.stringContaining('仅安装插件'), expect.objectContaining({
      okLabel: '下载模型', cancelLabel: '取消',
    }));
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('stops an in-flight download and does not continue installation after cancellation', async () => {
    mocks.inspect.mockResolvedValue({ ready: false, missing: [model, vocab] });
    mocks.download.mockImplementationOnce((_name, { signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }));
    const preparation = renderSpeechModels().prepare(manifest);
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    renderSpeechModels().cancel();
    expect(await preparation).toBe(false);
    expect(mocks.download).toHaveBeenCalledOnce(); expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(renderSpeechModels().isPreparing).toBe(false);
  });

  it('preserves a safe download error and releases the preparation lock for retry', async () => {
    const error = new LocalSpeechModelError('语音模型下载失败：国内镜像连接超时');
    mocks.inspect.mockResolvedValue({ ready: false, missing: [vocab] });
    mocks.download.mockRejectedValueOnce(error);
    await expect(renderSpeechModels().prepare(manifest)).rejects.toBe(error);
    expect(renderSpeechModels().isPreparing).toBe(false);
    mocks.confirm.mockResolvedValue(false);
    expect(await renderSpeechModels().prepare(manifest)).toBe(true);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
  });

  it('does not report readiness when a completed transfer still fails the native integrity check', async () => {
    mocks.inspect.mockResolvedValue({ ready: false, missing: [vocab] });
    await expect(renderSpeechModels().prepare(manifest)).rejects.toMatchObject({
      name: 'LocalSpeechModelError', message: expect.stringContaining('未通过完整性检查'),
    });
    expect(renderSpeechModels().ready).toBe(false);
  });

  it('ignores an affirmative prompt response after the settings panel unmounts', async () => {
    mocks.inspect.mockResolvedValue({ ready: false, missing: [vocab] });
    let approve!: (confirmed: boolean) => void;
    mocks.confirm.mockReturnValueOnce(new Promise<boolean>((resolve) => { approve = resolve; }));
    const preparation = renderSpeechModels().prepare(manifest);
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    expect(await renderSpeechModels().prepare(manifest)).toBe(false);
    dispose(); approve(true);
    expect(await preparation).toBe(false); expect(mocks.download).not.toHaveBeenCalled();
  });

  it('aborts an active model transfer when the settings panel unmounts', async () => {
    mocks.inspect.mockResolvedValue({ ready: false, missing: [vocab] });
    let signal!: AbortSignal;
    mocks.download.mockImplementationOnce((_name, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    });
    const preparation = renderSpeechModels().prepare(manifest);
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    dispose();
    expect(signal.aborted).toBe(true); expect(await preparation).toBe(false);
    expect(mocks.inspect).toHaveBeenCalledOnce();
  });
});
