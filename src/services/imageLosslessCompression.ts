import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { useAppStore } from '../store/useAppStore';
import { generateId } from '../store/store.utils';
import { getNodeBounds } from '../utils/nodeBounds';
import { isRemoteMediaUrl, isTauriAssetUrl, localMediaUrlToPath } from '../utils/mediaUrl';
import { compressImageLosslessly } from './ai/referenceImageUpload';
import { corsSafeFetch } from './ai/httpTransport';
import { registerCanvasDerivation, isCanvasDerivationFresh, completeCanvasDerivation } from './canvasDerivationGuard';
import { buildNodeFileName, estimateMediaDataUrlBytesAsync, getAssetUrlFromPath,
  isTauriEnv, moveToTrash, saveBinaryToProjectData } from './fileService';
import { decodeDataUrlBytesAsync, MEDIA_DATA_URL_BYTE_LIMITS } from './mediaDataUrl';
import { parseRasterImageDimensions } from './rasterImageDimensions';

const MAX_BYTES = MEDIA_DATA_URL_BYTE_LIMITS.image;
const BYTE_LIMIT_ERROR = '图片超过无损压缩上限（32 MiB、2400 万像素或单边 16384 像素）';
const SOURCE_FIELDS = ['filePath', 'imageUrl', 'sourceUrl', 'thumbnailUrl', 'mediaVersion'] as const;
const runtime: { active: Set<string>; tail: Promise<unknown> } = import.meta.hot?.data.imageCompression
  ?? { active: new Set<string>(), tail: Promise.resolve() };
if (import.meta.hot) import.meta.hot.data.imageCompression = runtime;

export type ImageCompressionResult = {
  status: 'compressed'; originalBytes: number; compressedBytes: number; nodeId: string;
} | { status: 'unchanged'; originalBytes: number; compressedBytes: number };

function abortError(): DOMException {
  return new DOMException('操作已取消', 'AbortError');
}

async function readResponse(response: Response, signal: AbortSignal, maxBytes: number): Promise<Blob> {
  if (!response.ok || !response.body) throw new Error('读取原图失败，请重试');
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel();
    throw new RangeError(BYTE_LIMIT_ERROR);
  }
  const reader = response.body.getReader();
  const parts: BlobPart[] = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new RangeError(BYTE_LIMIT_ERROR);
      parts.push(Uint8Array.from(value));
    }
    signal.throwIfAborted();
    return new Blob(parts, { type: response.headers.get('content-type') ?? '' });
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function readAsset(source: string, signal: AbortSignal): Promise<Blob> {
  const parts: Blob[] = [];
  let offset = 0;
  let total: number | undefined;
  do {
    signal.throwIfAborted();
    // Tauri 的单段读取有原生上限；按实际返回的区间继续，绝不回退整文件 GET。
    const response = await fetch(source, { signal, headers: { Range: `bytes=${offset}-${offset + 1024 * 1024 - 1}` } });
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    const [start, end, size] = range ? range.slice(1).map(Number) : [];
    if (response.status !== 206 || !range || ![start, end, size].every(Number.isSafeInteger)
      || start !== offset || end < start || end >= size || end - start + 1 > 1024 * 1024
      || (total !== undefined && size !== total) || size > MAX_BYTES) {
      await response.body?.cancel();
      if (size > MAX_BYTES) throw new RangeError(BYTE_LIMIT_ERROR);
      throw new Error('读取原图失败，请重试');
    }
    total = size;
    const part = await readResponse(response, signal, end - start + 1);
    if (part.size !== end - start + 1) throw new Error('读取原图失败，请重试');
    parts.push(part);
    offset = end + 1;
  } while (offset < total!);
  return new Blob(parts, { type: parts[0]?.type });
}

async function readOriginal(data: BaseNodeData, signal: AbortSignal): Promise<Blob> {
  // 原文件优先；读取失败时不能拿缩略图冒充原图继续压缩。
  if (!data.filePath && !data.imageUrl && !data.sourceUrl && !data.thumbnailUrl) {
    throw new Error('当前图片不可用，无法无损压缩');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 30_000);
  try {
    const source = data.filePath ? await getAssetUrlFromPath(data.filePath)
      : (data.imageUrl || data.sourceUrl || data.thumbnailUrl)!;
    if (/^data:/i.test(source)) {
      const expectedBytes = await estimateMediaDataUrlBytesAsync(source, controller.signal);
      if (expectedBytes > MAX_BYTES) throw new RangeError(BYTE_LIMIT_ERROR);
      const bytes = await decodeDataUrlBytesAsync(source, { expectedBytes, maxBytes: MAX_BYTES, signal: controller.signal });
      return new Blob([Uint8Array.from(bytes)]);
    }
    const localPath = localMediaUrlToPath(source);
    const url = localPath ? await getAssetUrlFromPath(localPath) : source;
    if (isTauriAssetUrl(url)) return await readAsset(url, controller.signal);
    if (!isRemoteMediaUrl(url) && !/^blob:/i.test(url)) throw new Error('读取原图失败，请重试');
    const response = await (isRemoteMediaUrl(url) ? corsSafeFetch : fetch)(url, { signal: controller.signal });
    return await readResponse(response, controller.signal, MAX_BYTES);
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof RangeError && error.message === BYTE_LIMIT_ERROR) throw error;
    // 读取异常可能带本地路径，不把原始错误或 cause 交给界面。
    // eslint-disable-next-line preserve-caught-error
    throw new Error('读取原图失败，请重试');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** 压缩原始编码字节，只把确实变小的独立副本加入当前画布。 */
export async function compressImageNode(nodeId: string, signal?: AbortSignal): Promise<ImageCompressionResult> {
  if (!isTauriEnv()) throw new Error('仅桌面端支持无损压缩');
  if (signal?.aborted) throw abortError();
  const initial = useAppStore.getState();
  const source = initial.nodes.find((node) => node.id === nodeId);
  if (!source || !['ai-image', 'source-image'].includes(source.data.type)) {
    throw new Error('当前图片不可用，无法无损压缩');
  }
  const key = `${initial.currentProjectId}:${nodeId}`;
  if (runtime.active.has(key)) throw abortError();
  const controller = new AbortController();
  const abort = () => controller.abort();
  const guard = registerCanvasDerivation(initial, nodeId, { onCancel: abort });
  if (!guard) throw new Error('当前图片不可用，无法无损压缩');
  const media = SOURCE_FIELDS.map((field) => source.data[field]);
  const assertFresh = () => {
    const state = useAppStore.getState();
    const current = state.nodes.find((node) => node.id === nodeId);
    if (controller.signal.aborted || !isCanvasDerivationFresh(guard, state) || !current
      || current.data.type !== source.data.type
      || SOURCE_FIELDS.some((field, index) => current.data[field] !== media[index])) {
      controller.abort();
      throw abortError();
    }
    return { state, current };
  };
  runtime.active.add(key);
  signal?.addEventListener('abort', abort, { once: true });
  // 手动操作串行读取和保存，排队时不同时持有多份大图。
  const task = runtime.tail.then(async (): Promise<ImageCompressionResult> => {
    let stagedPath: string | undefined;
    const unsubscribe = useAppStore.subscribe(() => {
      try { assertFresh(); } catch { /* 项目、revision 或源图变化时及时中止等待。 */ }
    });
    try {
      assertFresh();
      const original = await readOriginal(source.data, controller.signal);
      assertFresh();
      const compressed = await compressImageLosslessly(original, controller.signal);
      assertFresh();
      if (compressed.size >= original.size) {
        return { status: 'unchanged', originalBytes: original.size, compressedBytes: original.size };
      }
      const bytes = new Uint8Array(await compressed.arrayBuffer());
      // 合法 JPEG 的 APP/ICC 元数据可能超过 1 MiB，复用即将保存的完整字节解析。
      const dimensions = parseRasterImageDimensions(bytes);
      if (!dimensions) throw new Error('图片内容无效，无法无损压缩');
      const { current } = assertFresh();
      const label = `${current.data.label || current.data.fileName || '图像'} 无损压缩`;
      const extension = compressed.type === 'image/png' ? 'png' : 'jpg';
      let saved: Awaited<ReturnType<typeof saveBinaryToProjectData>>;
      try {
        saved = await saveBinaryToProjectData(bytes, guard.projectId,
          buildNodeFileName(label, extension, 'compressed'), { throwOnError: true });
      } catch {
        assertFresh();
        throw new Error('压缩副本保存失败，原图已保留');
      }
      stagedPath = saved?.filePath;
      const { state, current: latest } = assertFresh();
      if (!saved?.filePath || !saved.assetUrl) throw new Error('压缩副本保存失败，原图已保留');
      const bounds = getNodeBounds(latest, state.nodes);
      const nodeWidth = Math.min(280, Math.max(160, dimensions.width));
      const node: Node<BaseNodeData> = {
        id: `node-${generateId()}`, type: 'ai-image',
        // 用绝对位置交给 addNode，入组与成员表更新沿用同一个 Store Action。
        position: { x: bounds.right + 40, y: bounds.y },
        data: {
          type: 'ai-image', role: 'source', label, status: 'success',
          imageUrl: saved.assetUrl, thumbnailUrl: saved.assetUrl, sourceUrl: saved.assetUrl, output: saved.assetUrl,
          filePath: saved.filePath, fileName: saved.filePath.replace(/\\/g, '/').split('/').pop(),
          imageWidth: dimensions.width, imageHeight: dimensions.height, nodeWidth,
          nodeHeight: Math.max(120, Math.round((nodeWidth - 4) * dimensions.height / dimensions.width) + 4),
        },
      };
      state.addNode(node);
      stagedPath = undefined;
      return { status: 'compressed', originalBytes: original.size, compressedBytes: compressed.size, nodeId: node.id };
    } finally {
      unsubscribe();
      if (stagedPath) {
        // 未发布副本没有撤销关联；显式失败模式也避免文件层记录原始路径异常。
        try { await moveToTrash(stagedPath, { throwOnError: true }); } catch { /* 回收区不可用时保留副本，不碰原图。 */ }
      }
    }
  });
  runtime.tail = task.catch(() => undefined);
  try { return await task; }
  finally {
    runtime.active.delete(key);
    signal?.removeEventListener('abort', abort);
    completeCanvasDerivation(guard);
  }
}
