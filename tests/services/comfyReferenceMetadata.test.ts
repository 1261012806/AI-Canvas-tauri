import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ matches: vi.fn(), acquire: vi.fn(), accepts: vi.fn() }));
vi.mock('../../src/services/comfyMediaSource', () => ({
  shouldLoadNativeComfyMedia: native.matches, acquireComfyMediaSource: native.acquire, isNativeComfyMediaSource: native.accepts,
}));
import { probeReferenceMediaMetadata } from '../../src/services/ai/videoInputValidation';

class MediaStub {
  src = ''; preload = ''; duration = 12; videoWidth = 1280;
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  load = vi.fn(() => { if (!this.src) { this.duration = NaN; this.videoWidth = 0; } });
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}
let element: MediaStub;
const source = 'http://127.0.0.1:8188/view?filename=old.mp4';
beforeEach(() => {
  element = new MediaStub();
  native.matches.mockReset().mockReturnValue(true);
  native.accepts.mockReset().mockImplementation((value: string) => value.startsWith('comfy-media:'));
  native.acquire.mockReset();
  vi.stubGlobal('document', { createElement: () => element });
  vi.stubGlobal('HTMLVideoElement', MediaStub);
});
afterEach(() => vi.unstubAllGlobals());

describe('Comfy 参考媒体元数据读取', () => {
  it('仅挂原生展示地址并在元数据到达后卸载和归还租约', async () => {
    const release = vi.fn();
    native.acquire.mockResolvedValue({ src: 'comfy-media://localhost/opaque', release });
    const task = probeReferenceMediaMetadata('video', source);
    expect(element.src).toBe(''); await Promise.resolve();
    expect(element.src).toBe('comfy-media://localhost/opaque');
    element.onloadedmetadata?.();
    await expect(task).resolves.toEqual({ durationSeconds: 12, width: 1280 });
    expect(element.src).toBe(''); expect(release).toHaveBeenCalledOnce();
  });
  it('取消后不交接迟到租约，原生失败不赋原 URL', async () => {
    const request = new AbortController();
    const release = vi.fn();
    let finish!: (value: { src: string; release: () => void }) => void;
    native.acquire.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const task = probeReferenceMediaMetadata('audio', source, request.signal);
    request.abort(); finish({ src: 'comfy-media://localhost/late', release });
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); expect(release).toHaveBeenCalledOnce(); expect(element.src).toBe('');
    native.acquire.mockRejectedValueOnce(new Error('HTTP 403'));
    await expect(probeReferenceMediaMetadata('video', source)).rejects.toThrow('原生媒体信息读取失败');
    expect(element.src).toBe('');
  });
  it('普通素材保留既有同步挂载和元数据行为', async () => {
    native.matches.mockReturnValue(false);
    const task = probeReferenceMediaMetadata('audio', 'asset://local.wav');
    expect(element.src).toBe('asset://local.wav'); element.onloadedmetadata?.();
    await expect(task).resolves.toEqual({ durationSeconds: 12, width: undefined });
    expect(native.acquire).not.toHaveBeenCalled();
  });
});
