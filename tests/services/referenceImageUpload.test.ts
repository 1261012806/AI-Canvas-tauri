import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { mapReferenceImagesInOrder, prepareApimartImageUpload, prepareReferenceImageUpload } from '../../src/services/ai/referenceImageUpload';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(),
  invoke: vi.fn(), isTauri: vi.fn(() => true),
}));

function png(color = 2, extra?: 'tRNS' | 'acTL', width = 3648, dataBytes = 4 * 1024 * 1024, height = 2048, depth = 8): Blob {
  const chunk = (name: string, data: Uint8Array) => {
    const bytes = new Uint8Array(data.length + 12);
    new DataView(bytes.buffer).setUint32(0, data.length);
    bytes.set(new TextEncoder().encode(name), 4);
    bytes.set(data, 8);
    return bytes;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header[8] = depth; header[9] = color;
  return new Blob([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...(extra ? [chunk(extra, new Uint8Array(8))] : []),
    chunk('IDAT', new Uint8Array(dataBytes)), chunk('IEND', new Uint8Array()),
  ], { type: 'image/png' });
}

function jpeg(width = 3840, height = 2160, padding = 0): Blob {
  return new Blob([Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
  ]), new Uint8Array(padding), Uint8Array.from([0xff, 0xd9])], { type: 'image/jpeg' });
}

function webp(width = 3840, height = 2160, flags = 0): Blob {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('VP8X'), 12);
  bytes[20] = flags;
  const writeU24 = (offset: number, value: number) => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
    bytes[offset + 2] = (value >> 16) & 0xff;
  };
  writeU24(24, width - 1);
  writeU24(27, height - 1);
  return new Blob([bytes], { type: 'image/webp' });
}

const decode = vi.fn();
const encode = vi.fn();
const canvas = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset(); vi.mocked(isTauri).mockReturnValue(true);
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('OffscreenCanvas', canvas);
});
afterEach(() => vi.unstubAllGlobals());

describe('APIMart 参考图大小与 PNG 无损压缩', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])('不处理恰好 20,000,000 字节的 %s', async (type) => {
    const original = new Blob([new Uint8Array(20_000_000)], { type });
    expect(await prepareApimartImageUpload(original)).toBe(original);
    expect(invoke).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });

  it.each(['array-buffer', 'typed-array'] as const)('按 PNG magic 压缩，接收原生 %s 并保留尺寸与透明格式', async (responseKind) => {
    const originalPng = png(6, undefined, 3648, 20_000_000);
    const original = new Blob([originalPng], { type: 'application/octet-stream' });
    const output = await png(6, undefined, 3648, 128).arrayBuffer();
    vi.mocked(invoke).mockResolvedValue(responseKind === 'array-buffer' ? output : new Uint8Array(output));
    const prepared = await prepareApimartImageUpload(original);
    expect(prepared.type).toBe('image/png');
    expect(new Uint8Array(await prepared.arrayBuffer())).toEqual(new Uint8Array(output));
    expect(invoke).toHaveBeenCalledWith('optimize_reference_png', expect.any(ArrayBuffer));
    expect((vi.mocked(invoke).mock.calls[0][1] as ArrayBuffer).byteLength).toBe(original.size);
    expect(decode).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });

  it.each([{ color: 3, depth: 8 }, { color: 6, depth: 16 }])('不把索引色或高位深 PNG 转成 JPEG（$color/$depth）', async ({ color, depth }) => {
    const original = png(color, undefined, 2048, 20_000_000, 2048, depth);
    vi.mocked(invoke).mockResolvedValue(await png(color, undefined, 2048, 128, 2048, depth).arrayBuffer());
    expect((await prepareApimartImageUpload(original)).type).toBe('image/png');
    expect(invoke).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(['image/jpeg', 'image/webp', 'image/gif', 'image/png'])('超限的非 PNG 字节不会因 MIME=%s 被转码', async (type) => {
    await expect(prepareApimartImageUpload(new Blob([new Uint8Array(20_000_001)], { type }))).rejects.toThrow('20 MB');
    expect(invoke).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });

  it('不压平超限 APNG', async () => {
    await expect(prepareApimartImageUpload(png(6, 'acTL', 3648, 20_000_000))).rejects.toThrow('动画保留原样');
    expect(invoke).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(['raw-bytes', 'pixels', 'edge'] as const)('在原生调用前拦截超预算 PNG（%s）', async (budget) => {
    const original = budget === 'raw-bytes' ? png(6, undefined, 3648, 32 * 1024 * 1024)
      : budget === 'pixels' ? png(6, undefined, 6000, 20_000_000, 5000)
        : png(6, undefined, 16385, 20_000_000, 1);
    await expect(prepareApimartImageUpload(original)).rejects.toThrow('20 MB');
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['unchanged', 'larger', 'still-oversized'] as const)('原生无收益或结果仍超限时不交付（%s）', async (result) => {
    const original = png(6, undefined, 3648, 21_000_000);
    const outputBytes = result === 'unchanged' ? 21_000_000 : result === 'larger' ? 22_000_000 : 20_000_000;
    vi.mocked(invoke).mockResolvedValue(await png(6, undefined, 3648, outputBytes).arrayBuffer());
    await expect(prepareApimartImageUpload(original)).rejects.toThrow('20 MB');
    expect(invoke).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
  });

  it.each([20_000_000, 20_000_001])('无损结果按十进制 20 MB 精确判定（%s 字节）', async (size) => {
    const overhead = png(6, undefined, 3648, 0).size;
    vi.mocked(invoke).mockResolvedValue(await png(6, undefined, 3648, size - overhead).arrayBuffer());
    const pending = prepareApimartImageUpload(png(6, undefined, 3648, 21_000_000));
    if (size === 20_000_000) expect((await pending).size).toBe(size);
    else await expect(pending).rejects.toThrow('20 MB');
  });

  it.each(['wrong-format', 'wrong-size', 'animated'] as const)('不接受原生的异常输出（%s）', async (kind) => {
    vi.mocked(invoke).mockResolvedValue(kind === 'wrong-format' ? new Uint8Array([1, 2, 3])
      : await png(6, kind === 'animated' ? 'acTL' : undefined, kind === 'wrong-size' ? 1024 : 3648, 128).arrayBuffer());
    await expect(prepareApimartImageUpload(png(6, undefined, 3648, 20_000_000))).rejects.toThrow('20 MB');
  });

  it('压缩不可用或失败时不给出原生路径及错误正文', async () => {
    const original = png(6, undefined, 3648, 20_000_000);
    vi.mocked(isTauri).mockReturnValueOnce(false);
    await expect(prepareApimartImageUpload(original)).rejects.toThrow('20 MB');
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockRejectedValueOnce(new Error('/Users/private/image.png?key=private-token'));
    const error = await prepareApimartImageUpload(original).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('20 MB');
    expect((error as Error).message).not.toMatch(/private|token|Users/u);
  });

  it('取消原生压缩后立即停止等待，但后续调用等真实结束才进入原生', async () => {
    const original = png(6, undefined, 3648, 20_000_000);
    const output = await png(6, undefined, 3648, 128).arrayBuffer();
    let finish!: (value: ArrayBuffer) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }));
    vi.mocked(invoke).mockResolvedValue(output);
    const controller = new AbortController();
    const active = prepareApimartImageUpload(original, controller.signal);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    const stopped = expect(active).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await stopped;
    const next = prepareApimartImageUpload(original);
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledOnce();
    finish(output);
    expect((await next).size).toBe(output.byteLength);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('排队取消不进入原生，也不抢占前一个压缩槽', async () => {
    const original = png(6, undefined, 3648, 20_000_000);
    const output = await png(6, undefined, 3648, 128).arrayBuffer();
    let finish!: (value: ArrayBuffer) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }));
    vi.mocked(invoke).mockResolvedValue(output);
    const first = prepareApimartImageUpload(original);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const cancelled = prepareApimartImageUpload(original, controller.signal);
    const stopped = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const third = prepareApimartImageUpload(original);
    controller.abort(); await stopped;
    expect(invoke).toHaveBeenCalledOnce();
    finish(output);
    await first; await third;
    expect(invoke).toHaveBeenCalledTimes(2);
    await expect(prepareApimartImageUpload(new Blob(['small']), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('通用参考图原生无损分流', () => {
  it.each([
    { color: 2, depth: 8, width: 3840, height: 2160 },
    { color: 6, depth: 8, width: 4096, height: 4096 },
    { color: 3, depth: 8, width: 4096, height: 2048 },
    { color: 0, depth: 16, width: 4096, height: 2048 },
  ])('PNG 保留原始 $width×$height、颜色类型 $color 和位深 $depth', async ({ color, depth, width, height }) => {
    const original = png(color, undefined, width, 1024, height, depth);
    const output = await png(color, undefined, width, 128, height, depth).arrayBuffer();
    vi.mocked(invoke).mockResolvedValue(output);
    const prepared = await prepareReferenceImageUpload(original);
    expect(prepared.type).toBe('image/png');
    expect(new Uint8Array(await prepared.arrayBuffer())).toEqual(new Uint8Array(output));
    expect(invoke).toHaveBeenCalledWith('optimize_reference_png', expect.any(ArrayBuffer));
    expect(decode).not.toHaveBeenCalled();
    expect(canvas).not.toHaveBeenCalled();
  });

  it.each(['image/jpeg', 'application/octet-stream', 'image/png'])('JPEG 按真实字节分流，不用 MIME=%s 决定压缩算法', async (type) => {
    const original = new Blob([jpeg(4096, 2160, 1024)], { type });
    const output = await jpeg(4096, 2160).arrayBuffer();
    vi.mocked(invoke).mockResolvedValue(new Uint8Array(output));
    const prepared = await prepareReferenceImageUpload(original);
    expect(invoke).toHaveBeenCalledWith('optimize_reference_jpeg', expect.any(ArrayBuffer));
    expect(prepared.type).toBe('image/jpeg');
    expect(new Uint8Array(await prepared.arrayBuffer())).toEqual(new Uint8Array(output));
    expect(decode).not.toHaveBeenCalled();
    expect(canvas).not.toHaveBeenCalled();
  });

  it.each(['apng', 'webp', 'animated-webp', 'gif'] as const)('保留 %s 原始字节，不展平动画或重编码', async (kind) => {
    const original = kind === 'apng' ? png(6, 'acTL', 4096, 128)
      : kind === 'gif' ? new Blob(['GIF89a'], { type: 'image/gif' })
        : webp(4096, 2160, kind === 'animated-webp' ? 0x02 : 0);
    expect(await prepareReferenceImageUpload(original)).toBe(original);
    expect(invoke).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(['png', 'jpeg'] as const)('Web 的 %s 不做 Canvas 有损回退', async (kind) => {
    vi.mocked(isTauri).mockReturnValue(false);
    const original = kind === 'png' ? png(6, undefined, 4096, 128) : jpeg(4096, 2160, 128);
    expect(await prepareReferenceImageUpload(original)).toBe(original);
    expect(invoke).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(canvas).not.toHaveBeenCalled();
  });

  it.each(['unchanged', 'larger', 'wrong-format', 'wrong-size', 'failure'] as const)('原生 %s 时返回原图', async (result) => {
    const original = jpeg(4096, 2160, 1024);
    if (result === 'failure') vi.mocked(invoke).mockRejectedValue(new Error('native unavailable'));
    else vi.mocked(invoke).mockResolvedValue(await (result === 'wrong-format' ? png(6, undefined, 4096, 128, 2160)
      : result === 'wrong-size' ? jpeg(2048, 1080)
        : jpeg(4096, 2160, result === 'larger' ? 2048 : 1024)).arrayBuffer());
    expect(await prepareReferenceImageUpload(original)).toBe(original);
    expect(encode).not.toHaveBeenCalled();
  });

  it('APIMart 的超限 JPEG 可经专用无损命令减重后上传', async () => {
    const original = jpeg(4096, 2160, 20_000_000);
    const output = await jpeg(4096, 2160, 1024).arrayBuffer();
    vi.mocked(invoke).mockResolvedValue(output);
    const prepared = await prepareApimartImageUpload(original);
    expect(prepared.type).toBe('image/jpeg');
    expect(prepared.size).toBe(output.byteLength);
    expect(invoke).toHaveBeenCalledWith('optimize_reference_jpeg', expect.any(ArrayBuffer));
  });

  it('JPEG 取消不释放仍在原生执行的 PNG/JPEG 共用串行槽', async () => {
    let finish!: (value: ArrayBuffer) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }));
    const jpegOutput = await jpeg().arrayBuffer();
    const pngOutput = await png(6, undefined, 3840, 128, 2160).arrayBuffer();
    vi.mocked(invoke).mockResolvedValue(pngOutput);
    const controller = new AbortController();
    const first = prepareReferenceImageUpload(jpeg(3840, 2160, 1024), controller.signal);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    const stopped = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await stopped;
    const second = prepareReferenceImageUpload(png(6, undefined, 3840, 1024, 2160));
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledOnce();
    finish(jpegOutput);
    expect((await second).type).toBe('image/png');
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(['optimize_reference_jpeg', 'optimize_reference_png']);
  });
});

describe('参考图顺序与取消', () => {
  it('双并发乱序完成仍保留每个引用的位置和重复项', async () => {
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const pending = mapReferenceImagesInOrder(['A', 'B', 'A'], async (value, index) => {
      started.push(index);
      await new Promise<void>((resolve) => { releases[index] = resolve; });
      return value;
    });
    expect(started).toEqual([0, 1]);
    releases[1]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    releases[2](); releases[0]();
    expect(await pending).toEqual(['A', 'B', 'A']);
  });

  it('失败或取消时不领取后续图片，不返回删掉失败项的数组', async () => {
    const prepare = vi.fn(async (value: string) => { if (value === 'A') throw new Error('读取失败'); return value; });
    await expect(mapReferenceImagesInOrder(['A', 'B', 'C'], prepare)).rejects.toThrow('读取失败');
    expect(prepare).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    const cancel = vi.fn(async () => { controller.abort(); return 'image'; });
    await expect(mapReferenceImagesInOrder(['A', 'B', 'C'], cancel, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
