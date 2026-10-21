import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelComfyInstall, chooseComfyInstallTarget, getBundledComfyInstallInfo, getComfyInstallInfo, installComfyPortable } from '../../src/services/comfyInstallService';

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

function readyBridge() {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: invokeMock } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('window', {});
  invokeMock.mockReset();
  channels.length = 0;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ComfyUI 安装接口就绪边界', () => {
  it('没有原生接口时也能同步取得表单选项，包含不同架构的选择', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0; Win64; x64' });
    const info = getBundledComfyInstallInfo();
    expect(info.supported).toBe(true);
    expect(info.variants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cpu', arch: 'x86_64' }),
      expect.objectContaining({ id: 'cpu-arm64', arch: 'aarch64' }),
    ]));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('内置清单不会把非 Windows 页面显示为支持自动安装', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh; Intel Mac OS X' });
    expect(getBundledComfyInstallInfo().supported).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('等待迟到的桌面接口后只读取一次，不提前调用 invoke', async () => {
    const info = { supported: true, version: 'v1', variants: [] };
    invokeMock.mockResolvedValue(info);
    const pending = getComfyInstallInfo();
    await vi.advanceTimersByTimeAsync(200);
    expect(invokeMock).not.toHaveBeenCalled();
    readyBridge();
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual(info);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('get_comfyui_install_info');
  });

  it('接口一直缺失时有界失败，不泄漏 undefined.invoke 错误或发送命令', async () => {
    const rejected = expect(getComfyInstallInfo()).rejects.toThrow('桌面安装接口未就绪');
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(invokeMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('关闭弹窗中止等待后，即使接口就绪也不再发送读取', async () => {
    const controller = new AbortController();
    const rejected = expect(getComfyInstallInfo(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    readyBridge();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(invokeMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('保留原生命令错误，不将权限错误当成未就绪而自动重试', async () => {
    readyBridge();
    invokeMock.mockRejectedValue('get_comfyui_install_info explicitly denied');
    await expect(getComfyInstallInfo()).rejects.toBe('get_comfyui_install_info explicitly denied');
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('接口未就绪时不创建 Channel；安装命令失败后不自动重投', async () => {
    invokeMock.mockRejectedValue('安装目标已失效');
    const progress = vi.fn();
    const rejected = expect(installComfyPortable('target-1', 'cpu', progress)).rejects.toBe('安装目标已失效');
    expect(channels).toHaveLength(0);
    expect(invokeMock).not.toHaveBeenCalled();
    readyBridge();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('install_comfyui_portable', {
      targetId: 'target-1', variantId: 'cpu', onProgress: channels[0],
    });
    channels[0].onmessage('{"stage":"downloading"}');
    expect(progress).not.toHaveBeenCalled();
  });

  it('选择目录和取消仍使用原有目标参数，仅发送一次原生命令', async () => {
    readyBridge();
    invokeMock.mockResolvedValueOnce({ targetId: 'target-1', displayPath: 'ComfyUI' });
    await expect(chooseComfyInstallTarget('ComfyUI')).resolves.toEqual({ targetId: 'target-1', displayPath: 'ComfyUI' });
    await cancelComfyInstall('target-1');
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'choose_comfyui_install_target', { folderName: 'ComfyUI' });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'cancel_comfyui_install', { targetId: 'target-1' });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
