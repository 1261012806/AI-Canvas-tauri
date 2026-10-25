import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';

const mock = vi.hoisted(() => ({
  getState: vi.fn(), listeners: new Set<() => void>(), desktop: vi.fn(),
  compress: vi.fn(), save: vi.fn(), trash: vi.fn(), assetUrl: vi.fn(), remote: vi.fn(), fetch: vi.fn(),
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: {
  getState: mock.getState,
  subscribe: (listener: () => void) => { mock.listeners.add(listener); return () => mock.listeners.delete(listener); },
} }));
vi.mock('../../src/services/ai/referenceImageUpload', () => ({ compressImageLosslessly: mock.compress }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mock.remote }));
vi.mock('../../src/services/fileService', async () => ({
  isTauriEnv: mock.desktop, getAssetUrlFromPath: mock.assetUrl,
  saveBinaryToProjectData: mock.save, moveToTrash: mock.trash,
  buildNodeFileName: (label: string, extension: string) => `${label}.${extension}`,
  estimateMediaDataUrlBytesAsync: async (source: string) => Buffer.from(source.split(',')[1], 'base64').length,
}));

import { compressImageNode } from '../../src/services/imageLosslessCompression';

function png(size = 200, width = 3840, height = 2160): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode('IHDR'), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}

function jpeg(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([
    0xff, 0xd8, 0xff, 0xe1, 0, 34,
    69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0,
    1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    0xff, 0xc0, 0, 17, 8, 0x08, 0x70, 0x0f, 0, 3,
    1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
    0xff, 0xda,
  ]);
  return bytes;
}

function assetResponse(bytes = png(), start = 0, total = bytes.length): Response {
  return new Response(bytes, { status: 206, headers: {
    'Content-Range': `bytes ${start}-${start + bytes.length - 1}/${total}`,
    'Content-Type': 'image/png',
  } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

let source: Node<BaseNodeData>;
let state: { currentProjectId: string | null; nodes: Node<BaseNodeData>[]; getCurrentRevision: () => number; addNode: ReturnType<typeof vi.fn> };
let revision: number;
const notify = () => mock.listeners.forEach((listener) => listener());

beforeEach(() => {
  vi.clearAllMocks();
  mock.listeners.clear();
  revision = 3;
  source = { id: 'source', type: 'ai-image', position: { x: 10, y: 20 }, data: {
    type: 'ai-image', label: '原图', role: 'generator', status: 'success',
    imageUrl: 'asset://localhost/source.png', filePath: '/p/source.png', thumbnailUrl: 'blob:preview',
    imageWidth: 10, imageHeight: 10, nodeWidth: 280,
    assetId: 'asset-old', relativePath: 'old.png', taskId: 'task-old', batchGroupId: 'batch-old',
    prompt: '原提示词', output: '原内容', error: '原错误',
  } };
  state = { currentProjectId: 'p', nodes: [source], getCurrentRevision: () => revision,
    addNode: vi.fn((node: Node<BaseNodeData>) => { state.nodes = [...state.nodes, node]; notify(); }),
  };
  mock.getState.mockImplementation(() => state);
  mock.desktop.mockReturnValue(true);
  mock.assetUrl.mockImplementation(async (path: string) => `asset://localhost/${encodeURIComponent(path)}`);
  mock.fetch.mockImplementation(async () => assetResponse());
  mock.remote.mockImplementation(async () => new Response(png()));
  mock.compress.mockImplementation(async () => new Blob([png(100)], { type: 'image/png' }));
  mock.save.mockResolvedValue({ filePath: '/p/compressed.png', assetUrl: 'asset://localhost/compressed.png' });
  mock.trash.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', mock.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('图片节点无损压缩副本', () => {
  it('按原文件字节压缩4K图，只添加白名单副本，原节点和文件保持不变', async () => {
    const before = structuredClone(source);
    const result = await compressImageNode('source');
    expect(result).toMatchObject({ status: 'compressed', originalBytes: 200, compressedBytes: 100 });
    expect(source).toEqual(before);
    expect(mock.fetch).toHaveBeenCalledWith('asset://localhost/%2Fp%2Fsource.png', expect.objectContaining({ headers: { Range: 'bytes=0-1048575' } }));
    const node = state.addNode.mock.calls[0][0] as Node<BaseNodeData>;
    expect(node.position).toEqual({ x: 330, y: 20 });
    expect(node.data).toMatchObject({ type: 'ai-image', role: 'source', status: 'success',
      filePath: '/p/compressed.png', fileName: 'compressed.png', imageWidth: 3840, imageHeight: 2160,
      imageUrl: 'asset://localhost/compressed.png', thumbnailUrl: 'asset://localhost/compressed.png',
    });
    for (const key of ['assetId', 'relativePath', 'taskId', 'batchGroupId', 'prompt', 'error']) expect(node.data[key]).toBeUndefined();
    expect(mock.save).toHaveBeenCalledWith(expect.any(Uint8Array), 'p', expect.stringMatching(/\.png$/), { throwOnError: true });
    expect(mock.trash).not.toHaveBeenCalled();
    expect(mock.listeners.size).toBe(0);
  });

  it('JPEG保留原格式并按EXIF方向记录真实尺寸', async () => {
    mock.fetch.mockResolvedValue(assetResponse(jpeg(200)));
    mock.compress.mockResolvedValue(new Blob([jpeg(100)], { type: 'image/jpeg' }));
    mock.save.mockResolvedValue({ filePath: '/p/compressed.jpg', assetUrl: 'asset://localhost/compressed.jpg' });
    await compressImageNode('source');
    expect(mock.save.mock.calls[0][2]).toMatch(/\.jpg$/);
    expect(state.addNode.mock.calls[0][0].data).toMatchObject({ imageWidth: 2160, imageHeight: 3840 });
  });

  it('允许SOF前包含超过1 MiB元数据的合法JPEG', async () => {
    const segment = new Uint8Array(65537);
    segment.set([0xff, 0xe2, 0xff, 0xff]);
    const frame = jpeg(100);
    const compressed = new Blob([frame.slice(0, 2), ...Array<Uint8Array<ArrayBuffer>>(17).fill(segment), frame.slice(2)], { type: 'image/jpeg' });
    source.data = { ...source.data, filePath: undefined, imageUrl: 'https://example.com/metadata.jpg' };
    mock.remote.mockResolvedValue(new Response(new Blob([compressed, new Uint8Array(100)])));
    mock.compress.mockResolvedValue(compressed);
    await compressImageNode('source');
    expect(state.addNode.mock.calls[0][0].data).toMatchObject({ imageWidth: 2160, imageHeight: 3840 });
    expect(mock.save.mock.calls[0][0].byteLength).toBe(compressed.size);
  });

  it('分组源图使用绝对位置，由addNode统一决定副本入组', async () => {
    source.parentId = 'group';
    state.nodes.unshift({ id: 'group', type: 'group', position: { x: 500, y: 1000 }, data: { type: 'ai-image', label: '分组' } });
    await compressImageNode('source');
    const node = state.addNode.mock.calls[0][0];
    expect(node.position).toEqual({ x: 830, y: 1020 });
    expect(node.parentId).toBeUndefined();
  });

  it('source-image节点同样可用', async () => {
    source.type = source.data.type = 'source-image';
    await expect(compressImageNode('source')).resolves.toMatchObject({ status: 'compressed' });
  });

  it('无收益时不保存文件、不创建节点或改写原状态', async () => {
    mock.compress.mockImplementation(async (blob: Blob) => blob);
    await expect(compressImageNode('source')).resolves.toEqual({ status: 'unchanged', originalBytes: 200, compressedBytes: 200 });
    expect(mock.save).not.toHaveBeenCalled();
    expect(state.addNode).not.toHaveBeenCalled();
    expect(source.data.output).toBe('原内容');
  });

  it('原生失败保留原节点，仅抛出手动入口错误', async () => {
    mock.compress.mockRejectedValue(new Error('无损压缩失败，请重试或保留原图'));
    await expect(compressImageNode('source')).rejects.toThrow('无损压缩失败，请重试或保留原图');
    expect(mock.save).not.toHaveBeenCalled();
    expect(state.addNode).not.toHaveBeenCalled();
    expect(source.data.status).toBe('success');
  });

  it.each([null, { filePath: '/p/staged.png', assetUrl: '' }])('保存不完整时不发布副本：%j', async (saved) => {
    mock.save.mockResolvedValue(saved);
    await expect(compressImageNode('source')).rejects.toThrow('压缩副本保存失败，原图已保留');
    expect(state.addNode).not.toHaveBeenCalled();
    if (saved) expect(mock.trash).toHaveBeenCalledWith('/p/staged.png', { throwOnError: true });
  });

  it('保存异常不向界面泄漏本机路径', async () => {
    mock.save.mockRejectedValue(new Error('write /private/user/secret.png failed'));
    await expect(compressImageNode('source')).rejects.toThrow('压缩副本保存失败，原图已保留');
    expect(state.addNode).not.toHaveBeenCalled();
  });

  it('回收迟到副本失败时仍保留原图，不向日志和界面暴露原始错误', async () => {
    const saved = deferred<{ filePath: string; assetUrl: string }>();
    mock.save.mockReturnValue(saved.promise);
    mock.trash.mockRejectedValue(new Error('/private/user/staged.png permission denied'));
    const pending = compressImageNode('source');
    await vi.waitFor(() => expect(mock.save).toHaveBeenCalled());
    state.currentProjectId = 'other'; notify();
    saved.resolve({ filePath: '/p/staged.png', assetUrl: 'asset://localhost/staged.png' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.trash).toHaveBeenCalledExactlyOnceWith('/p/staged.png', { throwOnError: true });
    expect(state.addNode).not.toHaveBeenCalled();
    expect(source.data.filePath).toBe('/p/source.png');
  });

  it.each(['project', 'revision', 'delete', 'replace', 'cancel'] as const)('保存期间%s时回收迟到副本，不写入画布', async (change) => {
    const saved = deferred<{ filePath: string; assetUrl: string }>();
    mock.save.mockReturnValue(saved.promise);
    const controller = new AbortController();
    const pending = compressImageNode('source', controller.signal);
    await vi.waitFor(() => expect(mock.save).toHaveBeenCalled());
    if (change === 'project') state.currentProjectId = 'other';
    if (change === 'revision') revision++;
    if (change === 'delete') state.nodes = [];
    if (change === 'replace') source.data = { ...source.data, imageUrl: 'blob:new-image' };
    if (change === 'cancel') controller.abort();
    notify();
    saved.resolve({ filePath: '/p/staged.png', assetUrl: 'asset://localhost/staged.png' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.addNode).not.toHaveBeenCalled();
    expect(mock.trash).toHaveBeenCalledExactlyOnceWith('/p/staged.png', { throwOnError: true });
    expect(mock.listeners.size).toBe(0);
  });

  it('压缩期间换图时不进入保存阶段', async () => {
    const compressed = deferred<Blob>();
    mock.compress.mockReturnValue(compressed.promise);
    const pending = compressImageNode('source');
    await vi.waitFor(() => expect(mock.compress).toHaveBeenCalled());
    source.data = { ...source.data, filePath: '/p/replaced.png' }; notify();
    compressed.resolve(new Blob([png(100)], { type: 'image/png' }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.save).not.toHaveBeenCalled();
  });

  it('同一源图并发点击只执行一次，结束后允许再次使用', async () => {
    const compressed = deferred<Blob>();
    mock.compress.mockReturnValueOnce(compressed.promise);
    const pending = compressImageNode('source');
    await vi.waitFor(() => expect(mock.compress).toHaveBeenCalled());
    await expect(compressImageNode('source')).rejects.toMatchObject({ name: 'AbortError' });
    compressed.resolve(new Blob([png(100)], { type: 'image/png' }));
    await pending;
    await compressImageNode('source');
    expect(mock.compress).toHaveBeenCalledTimes(2);
  });

  it('不同节点排队时不提前读取第二张原图', async () => {
    state.nodes.push({ ...source, id: 'second' });
    const compressed = deferred<Blob>();
    mock.compress.mockReturnValueOnce(compressed.promise);
    const a = compressImageNode('source');
    const b = compressImageNode('second');
    await vi.waitFor(() => expect(mock.compress).toHaveBeenCalledTimes(1));
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    compressed.resolve(new Blob([png(100)], { type: 'image/png' }));
    await Promise.all([a, b]);
    expect(mock.fetch).toHaveBeenCalledTimes(2);
  });

  it('读取失败不回退缩略图，并使用固定错误', async () => {
    mock.fetch.mockRejectedValue(new Error('/private/secret.png missing'));
    await expect(compressImageNode('source')).rejects.toThrow('读取原图失败，请重试');
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    expect(mock.compress).not.toHaveBeenCalled();
  });

  it('原图读取超时后明确提示失败并释放任务', async () => {
    vi.useFakeTimers();
    mock.fetch.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const pending = compressImageNode('source');
    const failure = expect(pending).rejects.toThrow('读取原图失败，请重试');
    await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(mock.compress).not.toHaveBeenCalled();
    expect(mock.listeners.size).toBe(0);
  });

  it('asset按实际返回区间连续读取', async () => {
    const bytes = png(200);
    mock.fetch.mockResolvedValueOnce(assetResponse(bytes.slice(0, 80), 0, 200))
      .mockResolvedValueOnce(assetResponse(bytes.slice(80), 80, 200));
    await compressImageNode('source');
    expect(mock.fetch.mock.calls[1][1].headers.Range).toBe('bytes=80-1048655');
    expect(new Uint8Array(await (mock.compress.mock.calls[0][0] as Blob).arrayBuffer())).toEqual(bytes);
  });

  it.each(['full-response', 'wrong-start', 'changed-total', 'truncated', 'oversize'] as const)('拒绝有问题的本地读取：%s', async (kind) => {
    const bytes = png(200);
    if (kind === 'full-response') mock.fetch.mockResolvedValue(new Response(bytes));
    if (kind === 'wrong-start') mock.fetch.mockResolvedValue(assetResponse(bytes, 1, 300));
    if (kind === 'changed-total') mock.fetch.mockResolvedValueOnce(assetResponse(bytes.slice(0, 80), 0, 200))
      .mockResolvedValueOnce(assetResponse(bytes.slice(80), 80, 201));
    if (kind === 'truncated') mock.fetch.mockResolvedValue(new Response(bytes.slice(0, 80), {
      status: 206, headers: { 'Content-Range': 'bytes 0-199/200' },
    }));
    if (kind === 'oversize') mock.fetch.mockResolvedValue(assetResponse(bytes, 0, 32 * 1024 * 1024 + 1));
    await expect(compressImageNode('source')).rejects.toThrow(kind === 'oversize' ? '图片超过无损压缩上限' : '读取原图失败');
    expect(mock.compress).not.toHaveBeenCalled();
    expect(state.addNode).not.toHaveBeenCalled();
  });

  it('远端原图使用原生网络入口，拒绝无Content-Length的超限流', async () => {
    source.data = { ...source.data, filePath: undefined, imageUrl: 'https://example.com/source.png' };
    const canceled = vi.fn();
    mock.remote.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); }, cancel: canceled,
    })));
    await expect(compressImageNode('source')).rejects.toThrow('图片超过无损压缩上限');
    expect(mock.remote).toHaveBeenCalledWith(source.data.imageUrl, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(canceled).toHaveBeenCalled();
    expect(mock.compress).not.toHaveBeenCalled();
  });

  it('Data URL读取原始字节，不调用Canvas或下载接口', async () => {
    source.data = { ...source.data, filePath: undefined, imageUrl: `data:image/png;base64,${Buffer.from(png()).toString('base64')}` };
    await compressImageNode('source');
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(mock.remote).not.toHaveBeenCalled();
    expect((mock.compress.mock.calls[0][0] as Blob).size).toBe(200);
  });

  it('Web端或不存在的图片不发起读取和保存', async () => {
    mock.desktop.mockReturnValueOnce(false);
    await expect(compressImageNode('source')).rejects.toThrow('仅桌面端支持无损压缩');
    await expect(compressImageNode('missing')).rejects.toThrow('当前图片不可用');
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(mock.save).not.toHaveBeenCalled();
  });
});
