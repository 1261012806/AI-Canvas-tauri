import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelComfyDependencies, ComfyDependencyInstallCancelledError, installComfyDependencies } from '../../src/services/comfyManagementService';

const { invokeMock, channels } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  channels: [] as Array<{ onmessage: (message: string) => void }>,
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class {
    onmessage = (_message: string) => {};
    constructor() { channels.push(this); }
  },
}));

beforeEach(() => { invokeMock.mockReset(); channels.length = 0; });

describe('ComfyUI 依赖安装进度与取消', () => {
  const requestId = 'comfy-deps-current-request';

  it('只交付当前请求的受限进度，完成后不再接收迟到事件', async () => {
    const onProgress = vi.fn();
    invokeMock.mockImplementation(async (command: string, args: { onProgress: { onmessage: (message: string) => void } }) => {
      expect(command).toBe('install_comfyui_dependencies');
      args.onProgress.onmessage('invalid JSON');
      args.onProgress.onmessage(JSON.stringify({ requestId: 'comfy-deps-other-request', stage: 'installing' }));
      args.onProgress.onmessage(JSON.stringify({ requestId, stage: 'unknown-stage' }));
      args.onProgress.onmessage(JSON.stringify({ requestId, stage: 'downloading', packageName: 'https://private.example/package.whl' }));
      args.onProgress.onmessage(JSON.stringify({ requestId, stage: 'installing', packageName: 'torch', raw: 'ignored output' }));
      return { message: '完成' };
    });
    await expect(installComfyDependencies('core', { requestId, onProgress })).resolves.toEqual({ message: '完成' });
    expect(invokeMock).toHaveBeenCalledWith('install_comfyui_dependencies', expect.objectContaining({ repositoryId: 'core', requestId }));
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0][0]).toMatchObject({ requestId, stage: 'installing', packageName: 'torch' });
    expect(onProgress.mock.calls[0][0]).not.toHaveProperty('raw');
    channels[0].onmessage(JSON.stringify({ requestId, stage: 'failed' }));
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('原生取消返回专用错误，不将其误报为安装失败或重投', async () => {
    invokeMock.mockImplementation(async (_command: string, args: { onProgress: { onmessage: (message: string) => void } }) => {
      args.onProgress.onmessage(JSON.stringify({ requestId, stage: 'cancelled', failureKind: 'cancelled' }));
      throw new Error('已取消依赖安装');
    });
    await expect(installComfyDependencies('core', { requestId })).rejects.toBeInstanceOf(ComfyDependencyInstallCancelledError);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('终止事件尚未送达时也能识别固定取消结果，其他错误原样交给界面', async () => {
    invokeMock.mockRejectedValueOnce('已取消依赖安装');
    await expect(installComfyDependencies('core', { requestId })).rejects.toBeInstanceOf(ComfyDependencyInstallCancelledError);
    invokeMock.mockRejectedValueOnce('依赖版本存在冲突');
    await expect(installComfyDependencies('core', { requestId: 'comfy-deps-next-request' })).rejects.toBe('依赖版本存在冲突');
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('取消请求只传绑定的请求标识', async () => {
    invokeMock.mockResolvedValue(undefined);
    await cancelComfyDependencies(requestId);
    expect(invokeMock).toHaveBeenCalledWith('cancel_comfyui_dependencies', { requestId });
  });
});
