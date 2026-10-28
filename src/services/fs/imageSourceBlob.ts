import { corsSafeFetch } from '../ai/httpTransport';
import { estimateMediaDataUrlBytesAsync } from '../fileService';
import { decodeDataUrlBytesAsync, MEDIA_DATA_URL_BYTE_LIMITS } from '../mediaDataUrl';
import { isRemoteMediaUrl, isTauriAssetUrl, localMediaUrlToPath } from '../../utils/mediaUrl';
import { getAssetUrlFromPath } from './core';

export const MAX_IMAGE_SOURCE_BYTES = MEDIA_DATA_URL_BYTE_LIMITS.image;
const RANGE_BYTES = 1024 * 1024;

export class ImageSourceReadError extends Error {
  readonly code: 'too_large' | 'unavailable';

  constructor(code: 'too_large' | 'unavailable') {
    super(code === 'too_large' ? '图片超过读取上限' : '图片读取失败');
    this.code = code;
    this.name = 'ImageSourceReadError';
  }
}

async function readResponse(response: Response, signal: AbortSignal, maxBytes: number): Promise<Blob> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new ImageSourceReadError('unavailable');
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new ImageSourceReadError('too_large');
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
      if (total > maxBytes) throw new ImageSourceReadError('too_large');
      parts.push(Uint8Array.from(value));
    }
    signal.throwIfAborted();
    if (!total) throw new ImageSourceReadError('unavailable');
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
    // 本地协议每次只读一段，不能在不支持 Range 时退回整文件 GET。
    const response = await fetch(source, { signal, headers: { Range: `bytes=${offset}-${offset + RANGE_BYTES - 1}` } });
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    const [start, end, size] = range ? range.slice(1).map(Number) : [];
    if (response.status !== 206 || !range || ![start, end, size].every(Number.isSafeInteger)
      || start !== offset || end < start || end >= size || end - start + 1 > RANGE_BYTES
      || (total !== undefined && size !== total) || size > MAX_IMAGE_SOURCE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new ImageSourceReadError(size > MAX_IMAGE_SOURCE_BYTES ? 'too_large' : 'unavailable');
    }
    total = size;
    const part = await readResponse(response, signal, end - start + 1);
    if (part.size !== end - start + 1) throw new ImageSourceReadError('unavailable');
    parts.push(part);
    offset = end + 1;
  } while (offset < total!);
  return new Blob(parts, { type: parts[0]?.type });
}

async function assertRawDataUrlBudget(source: string, start: number, signal: AbortSignal): Promise<void> {
  let bytes = 0;
  let nextYield = start + 1024 * 1024;
  for (let index = start; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
      && source.charCodeAt(index + 1) >= 0xdc00 && source.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    // 百分转义仍按原字符串的 UTF-8 字节计费，不先展开整份可能超限的正文。
    if (bytes > MAX_IMAGE_SOURCE_BYTES) throw new ImageSourceReadError('too_large');
    if (index >= nextYield) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      nextYield = index + 1024 * 1024;
    }
  }
  signal.throwIfAborted();
}

/** 共用原始字节读取；不解码图片，不写文件，也不把远端失败退回浏览器直连。 */
export async function readImageSourceBlob(source: string, signal: AbortSignal): Promise<Blob> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 30_000);
  try {
    controller.signal.throwIfAborted();
    if (/^data:/i.test(source)) {
      const header = source.slice(0, 4097);
      const comma = header.indexOf(',');
      if (comma < 0) throw new ImageSourceReadError('unavailable');
      let expectedBytes: number | undefined;
      if (/;base64(?:;|$)/i.test(header.slice(0, comma))) {
        expectedBytes = await estimateMediaDataUrlBytesAsync(source, controller.signal);
        if (expectedBytes > MAX_IMAGE_SOURCE_BYTES) throw new ImageSourceReadError('too_large');
      } else await assertRawDataUrlBudget(source, comma + 1, controller.signal);
      const bytes = await decodeDataUrlBytesAsync(source, { expectedBytes, maxBytes: MAX_IMAGE_SOURCE_BYTES, signal: controller.signal });
      if (!bytes.byteLength) throw new ImageSourceReadError('unavailable');
      const mime = /^data:([^;,]*)/i.exec(source.slice(0, 4096))?.[1] ?? '';
      return new Blob([Uint8Array.from(bytes)], { type: mime });
    }
    const path = localMediaUrlToPath(source) ?? (/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(source) ? source : undefined);
    const url = path ? await getAssetUrlFromPath(path) : source;
    controller.signal.throwIfAborted();
    if (isTauriAssetUrl(url)) return await readAsset(url, controller.signal);
    if (!isRemoteMediaUrl(url) && !/^blob:/i.test(url)) throw new ImageSourceReadError('unavailable');
    const response = await (isRemoteMediaUrl(url) ? corsSafeFetch : fetch)(url, { signal: controller.signal });
    return await readResponse(response, controller.signal, MAX_IMAGE_SOURCE_BYTES);
  } catch (error) {
    if (signal.aborted) throw new DOMException('操作已取消', 'AbortError');
    if (error instanceof ImageSourceReadError) throw error;
    // 只交出固定错误分类，原始异常可能包含本地路径或服务凭据。
    throw new ImageSourceReadError('unavailable');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
