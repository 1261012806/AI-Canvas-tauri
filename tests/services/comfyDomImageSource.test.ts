import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ matches: vi.fn(), acquire: vi.fn() }));
vi.mock('../../src/services/comfyImageSource', () => ({
  shouldLoadNativeComfyImage: native.matches, acquireComfyImageSource: native.acquire,
}));
import { bindComfyDomImageSources } from '../../src/services/comfyDomImageSource';
import { COMFY_IMAGE_SOURCE_ATTRIBUTE } from '../../src/utils/comfyMediaUrl';

class ImageStub {
  src = '';
  attributes = new Map<string, string>();
  constructor(source: string) { this.attributes.set(COMFY_IMAGE_SOURCE_ATTRIBUTE, source); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; this.attributes.delete(name); }
}
const source = 'http://127.0.0.1:8188/view?filename=picture.png';
let images: ImageStub[];
let mutation: () => void;
let dispose: (() => void) | undefined;
const disconnect = vi.fn();
const root = { querySelectorAll: () => images, contains: (image: ImageStub) => images.includes(image) } as unknown as HTMLElement;
beforeEach(() => {
  images = [new ImageStub(source)];
  native.matches.mockReset().mockReturnValue(true);
  native.acquire.mockReset(); disconnect.mockReset();
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { mutation = callback; }
    observe() {}
    disconnect = disconnect;
  });
});
afterEach(() => { dispose?.(); dispose = undefined; vi.unstubAllGlobals(); });

describe('引用缩略图的原生租约', () => {
  it('只把原生 blob 写入 src，删除或撤销重建时释放/重新申请', async () => {
    const release = vi.fn();
    native.acquire.mockResolvedValue({ src: 'blob:picture', release });
    const first = images[0];
    dispose = bindComfyDomImageSources(root);
    expect(first.src).toBe('');
    await Promise.resolve();
    expect(first.src).toBe('blob:picture');
    mutation(); expect(native.acquire).toHaveBeenCalledOnce();
    images = []; mutation(); expect(release).toHaveBeenCalledOnce();
    images = [new ImageStub(source)]; mutation(); await Promise.resolve();
    expect(native.acquire).toHaveBeenCalledTimes(2);
    expect(images[0].src).toBe('blob:picture');
  });
  it('迟到结果和配置竞态不会向已删除元素或 HTTP 地址交接', async () => {
    let finish!: (value: { src: string; release: () => void }) => void;
    const release = vi.fn();
    native.acquire.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const image = images[0];
    dispose = bindComfyDomImageSources(root);
    images = []; mutation(); finish({ src: 'blob:late', release }); await Promise.resolve();
    expect(release).toHaveBeenCalledOnce(); expect(image.src).toBe('');
    native.acquire.mockResolvedValueOnce({ src: source, release });
    images = [new ImageStub(source)]; mutation(); await Promise.resolve();
    expect(images[0].src).toBe(''); expect(release).toHaveBeenCalledTimes(2);
  });
  it('原生错误保持占位，普通/Web 地址沿原行为，关闭根后不继续观察', async () => {
    native.acquire.mockRejectedValueOnce(new Error('HTTP 403'));
    dispose = bindComfyDomImageSources(root); await Promise.resolve();
    expect(images[0].src).toBe('');
    native.matches.mockReturnValue(false);
    images = [new ImageStub(source)]; mutation();
    expect(images[0].src).toBe(source);
    dispose(); dispose = undefined;
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
