import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), convert: vi.fn(), desktop: vi.fn(() => true),
  config: { comfyUIUrl: '', comfyServers: [] as Array<{ url: string }> },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: mocks.convert }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => ({ config: mocks.config }) } }));
vi.mock('../../src/services/comfyServers', () => ({ DEFAULT_COMFY_URL: 'http://127.0.0.1:8188' }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: mocks.desktop }));
import { acquireComfyMediaSource, isNativeComfyMediaSource, shouldLoadNativeComfyMedia } from '../../src/services/comfyMediaSource';

const source = 'http://127.0.0.1:8188/view?filename=video.mp4&type=output';
const id = 'a'.repeat(64);
const opaque = `http://comfy-media.localhost/${id}`;
beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue({ id });
  mocks.convert.mockReset().mockReturnValue(opaque);
  mocks.desktop.mockReturnValue(true);
  mocks.config.comfyUIUrl = '';
  mocks.config.comfyServers = [];
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('Comfy 原生媒体租约', () => {
  it('只识别同一已配置端点，音视频与改名媒体均不依赖扩展名', () => {
    expect(shouldLoadNativeComfyMedia(source)).toBe(true);
    expect(shouldLoadNativeComfyMedia(source.replace('video.mp4', 'renamed'))).toBe(true);
    mocks.config.comfyServers = [{ url: 'https://gpu.example/comfy' }];
    expect(shouldLoadNativeComfyMedia('https://gpu.example/comfy/view?filename=sound.flac')).toBe(true);
    expect(shouldLoadNativeComfyMedia('https://gpu.example/other/view?filename=sound.flac')).toBe(false);
    expect(shouldLoadNativeComfyMedia(source.replace(':8188', ':8189'))).toBe(false);
  });
  it('返回不含服务地址的不透明原生 URL，释放与取消只关闭本租约一次', async () => {
    const request = new AbortController();
    const lease = await acquireComfyMediaSource(source, request.signal);
    expect(lease.src).toBe(opaque);
    expect(mocks.invoke).toHaveBeenCalledWith('open_comfy_media_source', { url: source });
    expect(mocks.convert).toHaveBeenCalledWith(id, 'comfy-media');
    expect(fetch).not.toHaveBeenCalled();
    request.abort(); lease.release();
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'close_comfy_media_source')).toEqual([
      ['close_comfy_media_source', { id }],
    ]);
  });
  it('申请过程中取消后归还迟到租约，不交回原链接', async () => {
    const request = new AbortController();
    let finish!: (value: { id: string }) => void;
    mocks.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const task = acquireComfyMediaSource(source, request.signal);
    request.abort(); finish({ id });
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.invoke).toHaveBeenCalledWith('close_comfy_media_source', { id });
    expect(mocks.convert).not.toHaveBeenCalled();
  });
  it('原生失败或非法展示地址不回退 HTTP，非法地址已分配的租约会归还', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('native unavailable'));
    await expect(acquireComfyMediaSource(source, new AbortController().signal)).rejects.toThrow('native unavailable');
    mocks.convert.mockReturnValueOnce(source);
    await expect(acquireComfyMediaSource(source, new AbortController().signal)).rejects.toThrow('展示地址无效');
    expect(mocks.invoke).toHaveBeenCalledWith('close_comfy_media_source', { id });
    expect(fetch).not.toHaveBeenCalled();
    for (const value of [source, `${opaque}?url=private`, `http://comfy-media.localhost.evil/${id}`, `comfy-media://localhost/extra/${id}`]) {
      expect(isNativeComfyMediaSource(value)).toBe(false);
    }
    expect(isNativeComfyMediaSource(`comfy-media://localhost/${id}`)).toBe(true);
  });
  it('普通、本地素材与 Web 演示保持原地址，不申请桌面权限', async () => {
    expect((await acquireComfyMediaSource('asset://local.mp4', new AbortController().signal)).src).toBe('asset://local.mp4');
    mocks.desktop.mockReturnValue(false);
    expect((await acquireComfyMediaSource(source, new AbortController().signal)).src).toBe(source);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
