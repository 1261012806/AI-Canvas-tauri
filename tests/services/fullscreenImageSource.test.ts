import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ComfyMediaSourceLease } from '../../src/services/comfyMediaSource';

const io = vi.hoisted(() => ({ fetch: vi.fn(), remote: vi.fn(), matches: vi.fn(), native: vi.fn() }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: io.remote }));
vi.mock('../../src/services/fs/core', () => ({ getAssetUrlFromPath: async (path: string) => `asset://localhost/${encodeURIComponent(path)}` }));
vi.mock('../../src/services/fileService', () => ({
  estimateMediaDataUrlBytesAsync: async (source: string) => Buffer.from(source.split(',')[1], 'base64').length,
}));
vi.mock('../../src/services/comfyImageSource', () => ({ shouldLoadNativeComfyImage: io.matches, readNativeComfyImageBlob: io.native }));

import { acquireFullscreenImageSource, FULLSCREEN_IMAGE_ERRORS } from '../../src/services/fullscreenImageSource';
const fetchDataUrl = globalThis.fetch;

function png(width = 3840, height = 2160): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(100);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode('IHDR'), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}
function response(bytes = png(), range = false) {
  return new Response(bytes, { status: range ? 206 : 200, headers: { 'Content-Type': 'image/png',
    ...(range ? { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` } : {}) } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
const leases: ComfyMediaSourceLease[] = [];
const requests: AbortController[] = [];
let create: MockInstance<typeof URL.createObjectURL>;
let revoke: MockInstance<typeof URL.revokeObjectURL>;
function controller() { const request = new AbortController(); requests.push(request); return request; }
async function acquire(source = 'blob:original', request = controller()) {
  const lease = await acquireFullscreenImageSource(source, request.signal);
  leases.push(lease); return lease;
}

beforeEach(() => {
  vi.clearAllMocks();
  io.matches.mockReturnValue(false);
  io.fetch.mockImplementation(async (_source: string, options?: RequestInit) => response(png(), !!options?.headers));
  io.remote.mockImplementation(async () => response());
  io.native.mockImplementation(async () => new Blob([png()], { type: 'image/png' }));
  create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fullscreen-${create.mock.calls.length}`);
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', io.fetch);
  vi.stubGlobal('createImageBitmap', vi.fn());
});
afterEach(() => {
  requests.splice(0).forEach((request) => request.abort());
  leases.splice(0).forEach((lease) => lease.release());
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('bounded fullscreen image sources', () => {
  it.each([[2048, 2048], [3840, 2160], [4096, 4096]])('keeps %s×%s original bytes and format without decoding or scaling', async (width, height) => {
    const bytes = png(width, height);
    io.fetch.mockResolvedValue(response(bytes));
    await acquire();
    const blob = create.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('reads local originals in bounded Range requests and rejects full-file fallback', async () => {
    await acquire('asset://localhost/%2Fp%2Fimage.png');
    expect(io.fetch.mock.calls[0][1].headers).toEqual({ Range: 'bytes=0-1048575' });
    io.fetch.mockResolvedValue(response());
    await expect(acquire('asset://localhost/%2Fp%2Fother.png')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reads a Data URL as bytes and preserves its MIME', async () => {
    const bytes = png();
    await acquire(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
    expect(io.fetch).not.toHaveBeenCalled();
    expect((create.mock.calls[0][0] as Blob).type).toBe('image/png');
    expect(new Uint8Array(await (create.mock.calls[0][0] as Blob).arrayBuffer())).toEqual(bytes);
  });

  it.each([
    ['whitespace', ' ', 32 * 1024 * 1024 + 1],
    ['UTF-8 characters', '剧', 12 * 1024 * 1024],
  ] as const)('rejects oversized raw Data URL %s before fetch or decoding', async (_label, character, count) => {
    const source = `data:image/svg+xml,<svg width="10" height="10">${character.repeat(count)}</svg>`;
    await expect(acquire(source)).rejects.toMatchObject({ code: 'too_large' });
    expect(io.fetch).not.toHaveBeenCalled(); expect(io.remote).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps a small non-Base64 SVG with Chinese and surrogate-pair characters unchanged', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text>剧本 😀</text></svg>';
    io.fetch.mockImplementationOnce((source: string, options: RequestInit) => fetchDataUrl(source, options));
    await acquire(`data:image/svg+xml,${svg}`);
    const blob = create.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/svg+xml');
    expect(await blob.text()).toBe(svg);
  });

  it('can cancel a raw Data URL budget scan before its body is fetched', async () => {
    vi.useFakeTimers();
    const request = controller();
    const pending = acquire(`data:image/svg+xml,${' '.repeat(2 * 1024 * 1024)}<svg width="10" height="10"/>`, request);
    const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    request.abort();
    await vi.advanceTimersByTimeAsync(0); await failure;
    expect(io.fetch).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it('uses the configured native ComfyUI reader with the complete URL', async () => {
    io.matches.mockReturnValue(true);
    const source = 'http://127.0.0.1:8188/view?filename=original.png&type=output&subfolder=a';
    await acquire(source);
    expect(io.native).toHaveBeenCalledWith(source, expect.any(AbortSignal));
    expect(io.remote).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
  });

  it('keeps supported animation bytes instead of flattening them', async () => {
    const bytes = new Uint8Array([71, 73, 70, 56, 57, 97, 100, 0, 100, 0, 0, 0]);
    io.fetch.mockResolvedValue(new Response(bytes, { headers: { 'Content-Type': 'image/gif' } }));
    await acquire();
    expect((create.mock.calls[0][0] as Blob).type).toBe('image/gif');
    expect(new Uint8Array(await (create.mock.calls[0][0] as Blob).arrayBuffer())).toEqual(bytes);
  });

  it('accepts JPEG dimensions after more than 1 MiB of metadata without changing its bytes', async () => {
    const segment = new Uint8Array(65537);
    segment.set([0xff, 0xe2, 0xff, 0xff]);
    const frame = new Uint8Array([0xff, 0xc0, 0, 17, 8, 0x08, 0x70, 0x0f, 0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xda]);
    const original = new Blob([new Uint8Array([0xff, 0xd8]), ...Array<Uint8Array<ArrayBuffer>>(17).fill(segment), frame], { type: 'image/jpeg' });
    io.fetch.mockResolvedValue(new Response(original, { headers: { 'Content-Type': original.type } }));
    await acquire();
    const blob = create.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/jpeg');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(await original.arrayBuffer()));
  });

  it.each([[8193, 10], [8000, 8000]])('rejects unsafe %s×%s dimensions before exposing an object URL', async (width, height) => {
    io.fetch.mockResolvedValue(response(png(width, height)));
    await expect(acquire()).rejects.toMatchObject({ code: 'too_large', message: FULLSCREEN_IMAGE_ERRORS.too_large });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects unknown dimensions without trying a browser decode', async () => {
    io.fetch.mockResolvedValue(new Response('unrecognized-image-content'));
    await expect(acquire()).rejects.toMatchObject({ code: 'unsupported' });
    expect(create).not.toHaveBeenCalled(); expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('rejects declared and streamed byte overflow without leaking the original error', async () => {
    const cancel = vi.fn();
    io.remote.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Length': String(32 * 1024 * 1024 + 1) } }));
    await expect(acquire('https://images.example/large.png')).rejects.toMatchObject({ code: 'too_large' });
    expect(cancel).toHaveBeenCalledOnce();
    io.remote.mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); } })));
    await expect(acquire('https://images.example/stream.png')).rejects.toMatchObject({ code: 'too_large' });
    io.remote.mockRejectedValueOnce(new Error('private URL https://host/?secret=abc /private/image.png'));
    await expect(acquire('https://images.example/broken.png')).rejects.toMatchObject({ code: 'unavailable', message: FULLSCREEN_IMAGE_ERRORS.unavailable });
    expect(create).not.toHaveBeenCalled();
  });

  it('counts active encoded bytes plus two RGBA surfaces and releases the budget exactly once', async () => {
    io.fetch.mockImplementation(async () => response(png(4096, 4096)));
    const first = await acquire();
    await expect(acquire('blob:second')).rejects.toMatchObject({ code: 'busy' });
    first.release(); first.release();
    const next = await acquire('blob:next');
    expect(next.src).not.toBe(first.src);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('reclaims an active lease when its consumer is aborted', async () => {
    io.fetch.mockImplementation(async () => response(png(4096, 4096)));
    const request = controller();
    const first = await acquire('blob:first', request);
    request.abort(); first.release();
    await acquire('blob:next');
    expect(revoke).toHaveBeenCalledExactlyOnceWith(first.src);
  });

  it('prepares one image at a time and holds the slot until a canceled read actually ends', async () => {
    io.matches.mockReturnValue(true);
    const read = deferred<Blob>();
    io.native.mockReturnValueOnce(read.promise);
    const first = controller();
    const a = acquire('http://comfy/first', first);
    const rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(io.native).toHaveBeenCalledOnce());
    first.abort();
    const b = acquire('http://comfy/second');
    await Promise.resolve();
    expect(io.native).toHaveBeenCalledOnce();
    read.resolve(new Blob([png()]));
    await rejected; await b;
    expect(io.native).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
  });

  it('cancels queued consumers immediately and bounds the queue without reading their bytes', async () => {
    io.matches.mockReturnValue(true);
    const read = deferred<Blob>(); io.native.mockReturnValueOnce(read.promise);
    const active = controller(); const queued = controller(); const another = controller();
    const first = acquire('http://comfy/active', active);
    const firstFailure = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(io.native).toHaveBeenCalledOnce());
    const second = acquire('http://comfy/queued', queued);
    const secondFailure = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    const third = acquire('http://comfy/another', another);
    const thirdFailure = expect(third).rejects.toMatchObject({ name: 'AbortError' });
    await expect(acquire('http://comfy/excess')).rejects.toMatchObject({ code: 'busy' });
    queued.abort(); another.abort();
    await Promise.all([secondFailure, thirdFailure]);
    active.abort(); read.resolve(new Blob([png()]));
    await firstFailure;
    expect(io.native).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
  });

  it('times out a stuck stream with a fixed local error and frees preparation', async () => {
    vi.useFakeTimers();
    io.remote.mockImplementationOnce((_source: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const pending = acquire('https://images.example/slow.png');
    const failure = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    await vi.waitFor(() => expect(io.remote).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15_000); await failure;
    await acquire();
  });
});
