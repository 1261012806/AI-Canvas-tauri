import { createHash } from 'node:crypto';
import type { Node } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import type { BaseNodeData } from '../../src/types';
import type { MediaDownloadChunk, MediaDownloadContext, MediaDownloadInfo, MediaDownloadInput } from '../../src/types/mediaDownload';
import { MediaFileReadError, type MediaFileReader } from '../../src/services/fileService';
import { clearMediaDownloads, executeMediaDownload } from '../../src/services/mediaDownloadService';

const CHUNK_BYTES = 256 * 1024;
const IDLE_MS = 10 * 60 * 1000;
const mocks = vi.hoisted(() => ({ open: vi.fn(), desktop: vi.fn(), encode: vi.fn() }));
vi.mock('../../src/services/fileService', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fileService')>(),
  openMediaFileReader: mocks.open,
  isTauriEnv: mocks.desktop,
  bytePartsToBase64Async: mocks.encode,
  MEDIA_READ_CHUNK_BYTES: 256 * 1024,
}));

const original = Uint8Array.from([137, 80, 78, 71, 0, 255, 128, 1, 2, 3]);
const readers: ReturnType<typeof readerFor>[] = [];
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const context = (signal = new AbortController().signal): MediaDownloadContext => ({
  projectId: 'p1', conversationId: 'mcp-control-p1', signal,
});
const run = (input: MediaDownloadInput, owner = context()) => executeMediaDownload(owner, input);

function node(data: Partial<BaseNodeData> = {}): Node<BaseNodeData> {
  return { id: 'n1', type: 'ai-image', position: { x: 0, y: 0 }, data: {
    type: 'ai-image', label: '原图', imageUrl: 'file:///project/original.png',
    filePath: '/project/original.png', ...data,
  } };
}
function readerFor(bytes = original, mimeType = 'image/png', fileName = '原图.png') {
  return {
    metadata: { fileName, mimeType, totalBytes: bytes.length, modifiedAt: 1000 },
    read: vi.fn(async (offset: number, _signal?: AbortSignal) => bytes.slice(offset, offset + CHUNK_BYTES)),
    close: vi.fn(async () => undefined),
  } satisfies MediaFileReader;
}
async function begin(): Promise<MediaDownloadInfo> {
  const result = await run({ action: 'begin', nodeId: 'n1' });
  if (result.state !== 'open') throw new Error('Expected an open download');
  return result;
}
async function read(downloadId: string, offset: number, owner = context()): Promise<MediaDownloadChunk> {
  const result = await run({ action: 'read', downloadId, offset }, owner);
  if (!('data' in result)) throw new Error('Expected original bytes');
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(async () => {
  await clearMediaDownloads();
  vi.clearAllMocks();
  readers.length = 0;
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'p1', nodes: [node()] });
  mocks.desktop.mockReturnValue(true);
  mocks.open.mockImplementation(async () => {
    const reader = readerFor();
    readers.push(reader);
    return reader;
  });
  mocks.encode.mockImplementation(async (parts: readonly Uint8Array[], signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return Buffer.concat(parts.map((part) => Buffer.from(part))).toString('base64');
  });
});
afterEach(async () => {
  await clearMediaDownloads();
  vi.useRealTimers();
});

describe('MCP original media downloads', () => {
  it('reconstructs unmodified original bytes from bounded chunks with independent SHA-256 checks', async () => {
    const bytes = Uint8Array.from({ length: CHUNK_BYTES * 2 + 17 }, (_, index) => index % 251);
    const reader = readerFor(bytes);
    mocks.open.mockResolvedValueOnce(reader);
    const info = await begin();
    expect(info).toMatchObject({ nodeId: 'n1', fileName: '原图.png', mimeType: 'image/png',
      totalBytes: bytes.length, chunkBytes: CHUNK_BYTES });
    expect(JSON.stringify(info)).not.toContain('/project');
    const received: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const chunk = await read(info.downloadId, offset);
      const decoded = Buffer.from(chunk.data, 'base64');
      expect(chunk).toMatchObject({ offset, bytesRead: decoded.length, nextOffset: offset + decoded.length,
        encoding: 'base64', checksumAlgorithm: 'sha256', checksum: hash(decoded),
        eof: offset + decoded.length === bytes.length });
      expect(decoded.length).toBeLessThanOrEqual(CHUNK_BYTES);
      received.push(decoded);
    }
    expect(Buffer.concat(received)).toEqual(Buffer.from(bytes));
    expect(reader.read.mock.calls.map(([offset]) => offset)).toEqual([0, CHUNK_BYTES, CHUNK_BYTES * 2]);
    expect(reader.close).not.toHaveBeenCalled();
  });

  it('supports identical range retries, the last block and an explicit EOF without consuming the download', async () => {
    const info = await begin();
    const first = await read(info.downloadId, 0);
    const again = await read(info.downloadId, 0);
    expect(again.data).toBe(first.data);
    expect(again.checksum).toBe(first.checksum);
    expect(again).toMatchObject({ offset: 0, nextOffset: original.length, eof: true });
    expect(await read(info.downloadId, original.length)).toMatchObject({
      offset: original.length, bytesRead: 0, nextOffset: original.length, eof: true,
      data: '', checksum: hash(new Uint8Array()),
    });
    expect((await read(info.downloadId, 0)).data).toBe(first.data);
    expect(readers[0].close).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'ai-image', field: 'imageUrl', path: '/project/original.png', mimeType: 'image/png' },
    { type: 'source-video', field: 'videoUrl', path: '/project/original.mp4', mimeType: 'video/mp4' },
    { type: 'ai-audio', field: 'audioUrl', path: '/project/original.wav', mimeType: 'audio/wav' },
  ] as const)('reads the primary local $type file rather than a thumbnail', async ({ type, field, path, mimeType }) => {
    useAppStore.setState({ nodes: [node({ type, imageUrl: undefined, filePath: path,
      [field]: `file://${path}`, thumbnailUrl: 'file:///project/preview.jpg' })] });
    mocks.open.mockResolvedValueOnce(readerFor(original, mimeType, path.split('/').at(-1)!));
    const info = await begin();
    expect(mocks.open).toHaveBeenCalledWith(path, expect.any(AbortSignal));
    expect(info.mimeType).toBe(mimeType);
    expect(Buffer.from((await read(info.downloadId, 0)).data, 'base64')).toEqual(Buffer.from(original));
  });

  it('rejects invalid offsets before reading without invalidating an otherwise usable download', async () => {
    const info = await begin();
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, original.length + 1]) {
      await expect(read(info.downloadId, offset)).rejects.toMatchObject({ code: 'DOWNLOAD_OFFSET_INVALID' });
    }
    expect(readers[0].read).not.toHaveBeenCalled();
    expect(readers[0].close).not.toHaveBeenCalled();
    expect((await read(info.downloadId, 0)).bytesRead).toBe(original.length);
  });

  it('limits concurrent downloads and frees capacity when a handle is closed', async () => {
    const opened = await Promise.all(Array.from({ length: 4 }, () => begin()));
    expect(new Set(opened.map((info) => info.downloadId)).size).toBe(4);
    await expect(begin()).rejects.toMatchObject({ code: 'DOWNLOAD_LIMIT' });
    expect(mocks.open).toHaveBeenCalledTimes(4);
    await run({ action: 'close', downloadId: opened[0].downloadId });
    await expect(begin()).resolves.toMatchObject({ state: 'open' });
    expect(mocks.open).toHaveBeenCalledTimes(5);
  });

  it('reserves capacity for a handle whose close failed instead of claiming it was released', async () => {
    const opened = await Promise.all(Array.from({ length: 4 }, () => begin()));
    const failed = readers[0];
    failed.close.mockRejectedValue(new MediaFileReadError('MEDIA_READ_CLOSE_FAILED', '无法确认原文件读取已关闭'));
    try {
      await expect(run({ action: 'close', downloadId: opened[0].downloadId }))
        .rejects.toMatchObject({ code: 'MEDIA_READ_CLOSE_FAILED' });
      await expect(begin()).rejects.toMatchObject({ code: 'DOWNLOAD_LIMIT' });
      await expect(read(opened[0].downloadId, 0)).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_FOUND' });
      expect((await read(opened[1].downloadId, 0)).bytesRead).toBe(original.length);
    } finally {
      // 仅恢复测试驱动以清理夹具；真实原生关闭失败不承诺可重试恢复。
      failed.close.mockResolvedValue(undefined);
      await clearMediaDownloads();
    }
  });

  it('refreshes ten-minute inactivity expiry after a successful read and then closes idle handles', async () => {
    vi.useFakeTimers();
    const info = await begin();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);
    const chunk = await read(info.downloadId, 0);
    expect(chunk.expiresAt).toBeGreaterThan(info.expiresAt);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(readers[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(readers[0].close).toHaveBeenCalledOnce();
    await expect(read(info.downloadId, 0)).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_FOUND' });
  });

  it('closes idempotently and never retains a closed ID', async () => {
    const info = await begin();
    const input = { action: 'close' as const, downloadId: info.downloadId };
    expect(await run(input)).toEqual({ downloadId: info.downloadId, state: 'closed' });
    expect(await run(input)).toEqual({ downloadId: info.downloadId, state: 'closed' });
    expect(readers[0].close).toHaveBeenCalledOnce();
    await expect(read(info.downloadId, 0)).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_FOUND' });
  });

  it.each(['replace', 'delete'] as const)('invalidates a download when its source node is changed: %s', async (change) => {
    const info = await begin();
    useAppStore.setState({ nodes: change === 'delete' ? [] : [node({ imageUrl: 'file:///project/new.png' })] });
    useAppStore.setState({ nodes: [node()] });
    expect(readers[0].close).toHaveBeenCalledOnce();
    await expect(read(info.downloadId, 0)).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_FOUND' });
  });

  it('does not restore stale download IDs after switching away from and back to a project', async () => {
    const info = await begin();
    useAppStore.setState({ currentProjectId: 'p2' });
    useAppStore.setState({ currentProjectId: 'p1' });
    expect(readers[0].close).toHaveBeenCalledOnce();
    await expect(read(info.downloadId, 0)).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_FOUND' });
  });

  it('invalidates downloads after a storage-root change even if the original setting is restored', async () => {
    const info = await begin();
    const previous = useAppStore.getState().config;
    useAppStore.setState({ config: { ...previous, baseDataDir: '/different-root' } });
    useAppStore.setState({ config: previous });
    expect(readers[0].close).toHaveBeenCalledOnce();
    await expect(read(info.downloadId, 0)).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_FOUND' });
  });

  it('rejects cross-conversation and cross-project access without closing the valid owner download', async () => {
    const info = await begin();
    for (const owner of [
      { ...context(), conversationId: 'normal-chat' },
      { ...context(), projectId: 'p2', conversationId: 'mcp-control-p2' },
    ]) {
      await expect(read(info.downloadId, 0, owner)).rejects.toMatchObject({ code: 'DOWNLOAD_CONTEXT_CHANGED' });
      await expect(run({ action: 'close', downloadId: info.downloadId }, owner))
        .rejects.toMatchObject({ code: 'DOWNLOAD_CONTEXT_CHANGED' });
    }
    expect(readers[0].close).not.toHaveBeenCalled();
    expect((await read(info.downloadId, 0)).bytesRead).toBe(original.length);
  });

  it('rejects an aborted request before opening a file', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run({ action: 'begin', nodeId: 'n1' }, context(controller.signal)))
      .rejects.toMatchObject({ code: 'DOWNLOAD_CANCELLED' });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('closes an existing download when its next range request is already aborted', async () => {
    const info = await begin();
    const controller = new AbortController();
    controller.abort();
    await expect(read(info.downloadId, 0, context(controller.signal)))
      .rejects.toMatchObject({ code: 'DOWNLOAD_CANCELLED' });
    expect(readers[0].read).not.toHaveBeenCalled();
    expect(readers[0].close).toHaveBeenCalledOnce();
    await expect(read(info.downloadId, 0)).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_FOUND' });
  });

  it('discards a late open result when the project switched away and back during opening', async () => {
    const entered = deferred<void>();
    const finish = deferred<MediaFileReader>();
    const reader = readerFor();
    mocks.open.mockImplementationOnce(() => { entered.resolve(); return finish.promise; });
    const opening = begin();
    const rejected = expect(opening).rejects.toMatchObject({ code: 'DOWNLOAD_CONTEXT_CHANGED' });
    await entered.promise;
    useAppStore.setState({ currentProjectId: 'p2' });
    useAppStore.setState({ currentProjectId: 'p1' });
    finish.resolve(reader);
    await rejected;
    expect(reader.close).toHaveBeenCalledOnce();
    await expect(begin()).resolves.toMatchObject({ state: 'open' });
  });

  it('does not return late bytes after cancellation and closes that download', async () => {
    const info = await begin();
    const entered = deferred<void>();
    const finish = deferred<Uint8Array<ArrayBuffer>>();
    readers[0].read.mockImplementationOnce(() => { entered.resolve(); return finish.promise; });
    const controller = new AbortController();
    const reading = read(info.downloadId, 0, context(controller.signal));
    const rejected = expect(reading).rejects.toMatchObject({ code: 'DOWNLOAD_CANCELLED' });
    await entered.promise;
    controller.abort();
    finish.resolve(original.slice());
    await rejected;
    expect(mocks.encode).not.toHaveBeenCalled();
    expect(readers[0].close).toHaveBeenCalledOnce();
    await expect(read(info.downloadId, 0)).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_FOUND' });
  });

  it('discards an in-flight read after its node source changes', async () => {
    const info = await begin();
    const entered = deferred<void>();
    const finish = deferred<Uint8Array<ArrayBuffer>>();
    readers[0].read.mockImplementationOnce(() => { entered.resolve(); return finish.promise; });
    const reading = read(info.downloadId, 0);
    const rejected = expect(reading).rejects.toMatchObject({ code: 'DOWNLOAD_SOURCE_CHANGED' });
    await entered.promise;
    useAppStore.setState({ nodes: [node({ imageUrl: 'file:///project/new.png' })] });
    finish.resolve(original.slice());
    await rejected;
    expect(mocks.encode).not.toHaveBeenCalled();
    expect(readers[0].close).toHaveBeenCalledOnce();
  });

  it('rejects an overlapping read without closing or interrupting the first request', async () => {
    const info = await begin();
    const entered = deferred<void>();
    const finish = deferred<Uint8Array<ArrayBuffer>>();
    readers[0].read.mockImplementationOnce(() => { entered.resolve(); return finish.promise; });
    const first = read(info.downloadId, 0);
    await entered.promise;
    await expect(read(info.downloadId, 0)).rejects.toMatchObject({ code: 'DOWNLOAD_BUSY' });
    expect(readers[0].close).not.toHaveBeenCalled();
    finish.resolve(original.slice());
    expect((await first).data).toBe(Buffer.from(original).toString('base64'));
    expect((await read(info.downloadId, 0)).bytesRead).toBe(original.length);
    expect(readers[0].close).not.toHaveBeenCalled();
  });

  it.each(['https://example.test/new.png', 'data:image/png;base64,YWJj', 'blob:opaque-image'])(
    'does not replace an unsaved primary result with a stale file path: %s', async (imageUrl) => {
      useAppStore.setState({ nodes: [node({ imageUrl, filePath: '/project/stale.png' })] });
      await expect(begin()).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_SAVED' });
      expect(mocks.open).not.toHaveBeenCalled();
    },
  );

  it('does not replace a thumbnail-only result with an ambiguous old file path', async () => {
    useAppStore.setState({ nodes: [node({ imageUrl: undefined, filePath: '/project/stale.png',
      thumbnailUrl: 'file:///project/preview.jpg' })] });
    await expect(begin()).rejects.toMatchObject({ code: 'DOWNLOAD_NOT_SAVED' });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('retains legacy original-file references when there is no primary URL or thumbnail', async () => {
    useAppStore.setState({ nodes: [node({ imageUrl: undefined, thumbnailUrl: undefined })] });
    const info = await begin();
    expect(mocks.open).toHaveBeenCalledWith('/project/original.png', expect.any(AbortSignal));
    expect((await read(info.downloadId, 0)).bytesRead).toBe(original.length);
  });

  it('rejects unsupported nodes and a mismatched media format before issuing a download ID', async () => {
    useAppStore.setState({ nodes: [node({ type: 'ai-text', output: '正文' })] });
    await expect(begin()).rejects.toMatchObject({ code: 'DOWNLOAD_MEDIA_REQUIRED' });
    useAppStore.setState({ nodes: [] });
    await expect(begin()).rejects.toMatchObject({ code: 'DOWNLOAD_NODE_NOT_FOUND' });
    useAppStore.setState({ nodes: [node()] });
    const reader = readerFor(original, 'video/mp4');
    mocks.open.mockResolvedValueOnce(reader);
    await expect(begin()).rejects.toMatchObject({ code: 'DOWNLOAD_MEDIA_MISMATCH' });
    expect(reader.close).toHaveBeenCalledOnce();
  });

  it('refuses non-desktop callers and extra client-supplied path fields', async () => {
    mocks.desktop.mockReturnValueOnce(false);
    await expect(begin()).rejects.toMatchObject({ code: 'DOWNLOAD_DESKTOP_REQUIRED' });
    await expect(run({ action: 'begin', nodeId: 'n1', path: '/private/secret.png' } as MediaDownloadInput))
      .rejects.toMatchObject({ code: 'DOWNLOAD_INPUT_INVALID' });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('keeps a download usable after unrelated node movement', async () => {
    const info = await begin();
    useAppStore.setState({ nodes: [{ ...node(), position: { x: 500, y: 300 } }] });
    expect((await read(info.downloadId, 0)).bytesRead).toBe(original.length);
    expect(readers[0].close).not.toHaveBeenCalled();
  });

  it('preserves a safe file-change error while redacting unexpected disk errors', async () => {
    const info = await begin();
    readers[0].read.mockRejectedValueOnce(new MediaFileReadError('MEDIA_READ_CHANGED', '原文件在读取期间发生变化'));
    await expect(read(info.downloadId, 0)).rejects.toMatchObject({ code: 'MEDIA_READ_CHANGED', message: '原文件在读取期间发生变化' });
    expect(readers[0].close).toHaveBeenCalledOnce();
    mocks.open.mockRejectedValueOnce(new Error('access denied /private/original.png'));
    await expect(begin()).rejects.toMatchObject({ code: 'DOWNLOAD_READ_FAILED',
      message: '原文件读取失败，请检查文件是否存在及目录授权' });
  });
});
