/** 节点原文件的只读分块传输；正文、路径和文件句柄只留在宿主运行时。 */
import { useAppStore } from '../store/useAppStore';
import { localMediaUrlToPath } from '../utils/mediaUrl';
import {
  bytePartsToBase64Async, isTauriEnv, MEDIA_READ_CHUNK_BYTES, MediaFileReadError,
  openMediaFileReader, type MediaFileReader,
} from './fileService';
import { sha256BytesHex } from './mediaDataUrl';
import type {
  MediaDownloadContext, MediaDownloadInfo, MediaDownloadInput, MediaDownloadResult,
} from '../types/mediaDownload';

const MAX_DOWNLOADS = 4;
const IDLE_MS = 10 * 60 * 1000;
type MediaKind = 'image' | 'video' | 'audio';
interface Source { nodeId: string; kind: MediaKind; path: string; fingerprint: string }
interface Download {
  id: string;
  projectId: string;
  conversationId: string;
  storageRoot: string;
  source: Source;
  reader: MediaFileReader;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
  closed: boolean;
  released: boolean;
  closing?: Promise<void>;
}
const downloads = new Map<string, Download>();
// 未确认关闭的句柄继续占用额度，不能把原生 close 失败当作资源已释放。
const closingDownloads = new Map<string, Download>();
let opening = 0;
let contextEpoch = 0;
let unwatch: (() => void) | undefined;

export class MediaDownloadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'MediaDownloadError'; this.code = code; }
}
function fail(code: string, message: string): never { throw new MediaDownloadError(code, message); }
function safeError(error: unknown): MediaDownloadError {
  if (error instanceof MediaDownloadError) return error;
  if (error instanceof MediaFileReadError) return new MediaDownloadError(error.code, error.message);
  if (error instanceof Error && error.name === 'AbortError') return new MediaDownloadError('DOWNLOAD_CANCELLED', '原文件读取已取消');
  return new MediaDownloadError('DOWNLOAD_READ_FAILED', '原文件读取失败，请检查文件是否存在及目录授权');
}
function assertContext(context: MediaDownloadContext): void {
  if (context.signal.aborted) fail('DOWNLOAD_CANCELLED', '原文件读取已取消');
  if (!isTauriEnv()) fail('DOWNLOAD_DESKTOP_REQUIRED', '原文件读取仅支持 Tauri 桌面端');
  if (!context.projectId || context.conversationId !== `mcp-control-${context.projectId}`
    || useAppStore.getState().currentProjectId !== context.projectId) {
    fail('DOWNLOAD_CONTEXT_CHANGED', '原文件读取所属项目或 MCP 对话已变化');
  }
}
function sourceFor(nodeId: string): Source {
  const node = useAppStore.getState().nodes.find((item) => item.id === nodeId);
  if (!node) fail('DOWNLOAD_NODE_NOT_FOUND', '未找到要读取原文件的节点');
  const { data } = node;
  const kind: MediaKind | undefined = ['ai-image', 'source-image', 'ai-panorama', 'ai-animation'].includes(data.type)
    ? 'image' : ['ai-video', 'source-video'].includes(data.type) ? 'video'
      : ['ai-audio', 'source-audio'].includes(data.type) ? 'audio' : undefined;
  if (!kind) fail('DOWNLOAD_MEDIA_REQUIRED', '请选择有原文件的图片、视频或音频节点');
  const primary = kind === 'image' ? data.imageUrl : kind === 'video' ? data.videoUrl : data.audioUrl;
  const reference = typeof primary === 'string' && primary.trim() ? primary : '';
  // 主产物仍是远程/内嵌内容时，不拿可能属于上一轮结果的 filePath 代替。
  const path = reference ? localMediaUrlToPath(reference) : data.thumbnailUrl ? undefined : data.filePath;
  if (!path) fail('DOWNLOAD_NOT_SAVED', '节点原文件尚未落盘，请先保存或导入项目；不会读取缩略图或自动下载远程地址');
  return { nodeId, kind, path, fingerprint: JSON.stringify([data.type, reference, data.filePath ?? null, data.assetId ?? null]) };
}
function sourceMatches(download: Download): boolean {
  const state = useAppStore.getState();
  if (download.closed || state.currentProjectId !== download.projectId
    || (state.config.baseDataDir ?? '') !== download.storageRoot) return false;
  try {
    const source = sourceFor(download.source.nodeId);
    return source.path === download.source.path && source.fingerprint === download.source.fingerprint;
  } catch { return false; }
}
function stopWatchingIfIdle(): void {
  if (downloads.size || opening) return;
  unwatch?.(); unwatch = undefined;
}
function dispose(download: Download): Promise<void> {
  if (download.released) return Promise.resolve();
  download.closed = true;
  clearTimeout(download.timer);
  if (downloads.get(download.id) === download) downloads.delete(download.id);
  closingDownloads.set(download.id, download);
  stopWatchingIfIdle();
  if (!download.closing) {
    download.closing = download.reader.close().then(() => {
      download.released = true;
      closingDownloads.delete(download.id);
    }).catch((error: unknown) => {
      download.closing = undefined;
      throw error;
    });
  }
  return download.closing;
}
function watchSources(): void {
  if (unwatch) return;
  unwatch = useAppStore.subscribe((state, previous) => {
    const changedProject = state.currentProjectId !== previous.currentProjectId
      || state.config.baseDataDir !== previous.config.baseDataDir;
    if (changedProject) contextEpoch += 1;
    if (!changedProject && state.nodes === previous.nodes) return;
    for (const download of downloads.values()) {
      if (changedProject || !sourceMatches(download)) void dispose(download).catch(() => undefined);
    }
  });
}
function touch(download: Download): void {
  clearTimeout(download.timer);
  download.expiresAt = Date.now() + IDLE_MS;
  download.timer = setTimeout(() => { void dispose(download).catch(() => undefined); }, IDLE_MS);
}
function info(download: Download): MediaDownloadInfo {
  const { fileName, mimeType, totalBytes } = download.reader.metadata;
  return { downloadId: download.id, nodeId: download.source.nodeId, state: 'open', fileName, mimeType,
    totalBytes, chunkBytes: MEDIA_READ_CHUNK_BYTES, expiresAt: download.expiresAt };
}
function assertFresh(context: MediaDownloadContext, download: Download): void {
  assertContext(context);
  if (!sourceMatches(download)) fail('DOWNLOAD_SOURCE_CHANGED', '节点原文件或存储位置已变化，请重新开始读取');
  if (download.expiresAt <= Date.now()) fail('DOWNLOAD_EXPIRED', '原文件读取已过期，请重新开始');
}
function lookup(context: MediaDownloadContext, id: string, includeClosing = false): Download | undefined {
  const download = downloads.get(id) ?? (includeClosing ? closingDownloads.get(id) : undefined);
  if (download && (download.projectId !== context.projectId || download.conversationId !== context.conversationId)) {
    fail('DOWNLOAD_NOT_FOUND', '下载不存在、已失效或不属于当前对话');
  }
  return download;
}
function validateInput(input: MediaDownloadInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('DOWNLOAD_INPUT_INVALID', '原文件读取参数无效');
  const keys = input.action === 'begin' ? ['action', 'nodeId']
    : input.action === 'read' ? ['action', 'downloadId', 'offset']
      : input.action === 'close' ? ['action', 'downloadId'] : [];
  if (!keys.length || Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key))) {
    fail('DOWNLOAD_INPUT_INVALID', '请按 begin、read 或 close 的参数定义调用');
  }
  const id = input.action === 'begin' ? input.nodeId : input.downloadId;
  if (typeof id !== 'string' || !id.trim() || id.length > 160) fail('DOWNLOAD_INPUT_INVALID', '需要有效的节点 ID 或下载 ID');
  if (input.action === 'read' && (!Number.isSafeInteger(input.offset) || input.offset < 0)) {
    fail('DOWNLOAD_OFFSET_INVALID', '原文件偏移必须为安全的非负整数字节数');
  }
}

async function begin(context: MediaDownloadContext, nodeId: string): Promise<MediaDownloadInfo> {
  if (downloads.size + opening + closingDownloads.size >= MAX_DOWNLOADS) fail('DOWNLOAD_LIMIT', '最多同时读取 4 个原文件，请先关闭已有下载');
  const source = sourceFor(nodeId);
  const storageRoot = useAppStore.getState().config.baseDataDir ?? '';
  opening += 1;
  watchSources();
  const epoch = contextEpoch;
  let reader: MediaFileReader | undefined;
  let download: Download | undefined;
  try {
    reader = await openMediaFileReader(source.path, context.signal);
    download = { id: crypto.randomUUID(), projectId: context.projectId, conversationId: context.conversationId,
      storageRoot, source, reader, expiresAt: Date.now() + IDLE_MS, busy: false, closed: false, released: false };
    assertContext(context);
    if (contextEpoch !== epoch) fail('DOWNLOAD_CONTEXT_CHANGED', '打开原文件期间项目或存储位置已变化');
    if (!reader.metadata.mimeType.startsWith(`${source.kind}/`)) fail('DOWNLOAD_MEDIA_MISMATCH', '节点类型与原文件格式不一致');
    assertFresh(context, download);
    downloads.set(download.id, download);
    touch(download);
    return info(download);
  } catch (error) {
    if (download) await dispose(download).catch(() => undefined);
    else await reader?.close().catch(() => undefined);
    throw safeError(error);
  } finally { opening -= 1; stopWatchingIfIdle(); }
}

export async function executeMediaDownload(context: MediaDownloadContext, input: MediaDownloadInput): Promise<MediaDownloadResult> {
  validateInput(input);
  if (context.signal.aborted && input.action !== 'begin') {
    const cancelled = lookup(context, input.downloadId, true);
    if (cancelled) await dispose(cancelled).catch(() => undefined);
  }
  assertContext(context);
  if (input.action === 'begin') return begin(context, input.nodeId);
  const download = lookup(context, input.downloadId, input.action === 'close');
  if (input.action === 'close') {
    if (download) {
      try { await dispose(download); } catch (error) { throw safeError(error); }
    }
    return { downloadId: input.downloadId, state: 'closed' };
  }
  if (!download) fail('DOWNLOAD_NOT_FOUND', '下载不存在、已失效或不属于当前对话');
  if (input.offset > download.reader.metadata.totalBytes) fail('DOWNLOAD_OFFSET_INVALID', '原文件偏移超出文件范围');
  if (download.busy) fail('DOWNLOAD_BUSY', '当前下载正在读取，请等待本次读取完成');
  download.busy = true;
  try {
    assertFresh(context, download);
    const bytes = await download.reader.read(input.offset, context.signal);
    assertFresh(context, download);
    const checksum = await sha256BytesHex(bytes);
    assertFresh(context, download);
    const data = await bytePartsToBase64Async([bytes], context.signal);
    assertFresh(context, download);
    touch(download);
    const nextOffset = input.offset + bytes.length;
    return { ...info(download), offset: input.offset, bytesRead: bytes.length, nextOffset,
      eof: nextOffset === download.reader.metadata.totalBytes, encoding: 'base64', data,
      checksumAlgorithm: 'sha256', checksum };
  } catch (error) {
    await dispose(download).catch(() => undefined);
    throw safeError(error);
  } finally { download.busy = false; }
}

/** 只关闭本服务的内存句柄，不删除或更改任何媒体文件。 */
export async function clearMediaDownloads(): Promise<void> {
  contextEpoch += 1;
  await Promise.allSettled([...new Set([...downloads.values(), ...closingDownloads.values()])].map(dispose));
  stopWatchingIfIdle();
}
