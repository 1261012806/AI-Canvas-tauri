import { readNativeComfyImageBlob, shouldLoadNativeComfyImage } from './comfyImageSource';
import type { ComfyMediaSourceLease } from './comfyMediaSource';
import { ImageSourceReadError, MAX_IMAGE_SOURCE_BYTES, readImageSourceBlob } from './fs/imageSourceBlob';
import { parseRasterImageDimensions } from './rasterImageDimensions';
import {
  assertEditorSourceBudget, EDITOR_SOURCE_SURFACE_COPIES, MAX_EDITOR_SOURCE_WORKING_SET_BYTES,
} from '../components/nodes/shared/image/imageResourceBudget';

export const FULLSCREEN_IMAGE_ERRORS = {
  too_large: '图片超过全屏预览安全上限，请降低分辨率后重试',
  unsupported: '此图片格式暂不支持安全全屏预览，请先转换为 PNG 或 JPEG',
  busy: '图片预览资源不足，请关闭其他大图后重试',
  unavailable: '图片读取或解码失败，请检查文件或网络后重试',
} as const;

export class FullscreenImageSourceError extends Error {
  readonly code: keyof typeof FULLSCREEN_IMAGE_ERRORS;

  constructor(code: keyof typeof FULLSCREEN_IMAGE_ERRORS) {
    super(FULLSCREEN_IMAGE_ERRORS[code]);
    this.code = code;
    this.name = 'FullscreenImageSourceError';
  }
}

interface Waiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}
const runtime: { preparing: boolean; waiters: Waiter[]; activeBytes: number } = import.meta.hot?.data.fullscreenImages
  ?? { preparing: false, waiters: [], activeBytes: 0 };
if (import.meta.hot) import.meta.hot.data.fullscreenImages = runtime;

const abortError = () => new DOMException('图片预览已取消', 'AbortError');

function releasePreparation(): void {
  const next = runtime.waiters.shift();
  if (!next) { runtime.preparing = false; return; }
  next.signal.removeEventListener('abort', next.abort);
  next.resolve(releasePreparation);
}

function enterPreparation(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (!runtime.preparing) { runtime.preparing = true; return Promise.resolve(releasePreparation); }
  // 快速换图可取消等候；最多再留两个请求，排队时不读取任何图片字节。
  if (runtime.waiters.length >= 2) return Promise.reject(new FullscreenImageSourceError('busy'));
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { signal, resolve, reject, abort: () => {
      const index = runtime.waiters.indexOf(waiter);
      if (index >= 0) runtime.waiters.splice(index, 1);
      signal.removeEventListener('abort', waiter.abort);
      reject(abortError());
    } };
    runtime.waiters.push(waiter);
    signal.addEventListener('abort', waiter.abort, { once: true });
    if (signal.aborted) waiter.abort();
  });
}

/** 原格式租约只在读头和预算通过后交给 img，整个过程不会转码或改写原文件。 */
export async function acquireFullscreenImageSource(source: string, signal: AbortSignal): Promise<ComfyMediaSourceLease> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 15_000);
  const activeSignal = AbortSignal.any([signal, timeout.signal]);
  let leave: (() => void) | undefined;
  try {
    leave = await enterPreparation(activeSignal);
    activeSignal.throwIfAborted();
    const blob = shouldLoadNativeComfyImage(source)
      ? await readNativeComfyImageBlob(source, activeSignal)
      : await readImageSourceBlob(source, activeSignal);
    activeSignal.throwIfAborted();
    if (!blob.size || blob.size > MAX_IMAGE_SOURCE_BYTES) throw new FullscreenImageSourceError('too_large');
    // JPEG 的 SOF 前可能有大段 APP/ICC；输入已限额，解析完整字节仍不触发图片解码。
    const dimensions = await blob.arrayBuffer().then((buffer) => parseRasterImageDimensions(new Uint8Array(buffer)));
    activeSignal.throwIfAborted();
    if (!dimensions) throw new FullscreenImageSourceError('unsupported');
    const estimate = assertEditorSourceBudget(dimensions.width, dimensions.height, '全屏预览');
    const bytes = blob.size + estimate.bytes * EDITOR_SOURCE_SURFACE_COPIES;
    if (bytes > MAX_EDITOR_SOURCE_WORKING_SET_BYTES) throw new FullscreenImageSourceError('too_large');
    if (runtime.activeBytes + bytes > MAX_EDITOR_SOURCE_WORKING_SET_BYTES) throw new FullscreenImageSourceError('busy');
    const src = URL.createObjectURL(blob);
    runtime.activeBytes += bytes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener('abort', release);
      URL.revokeObjectURL(src);
      runtime.activeBytes -= bytes;
    };
    signal.addEventListener('abort', release, { once: true });
    if (signal.aborted) { release(); throw abortError(); }
    return { src, release };
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof FullscreenImageSourceError) throw error;
    if (error instanceof RangeError || error instanceof ImageSourceReadError && error.code === 'too_large') {
      throw new FullscreenImageSourceError('too_large');
    }
    // 读取器或浏览器异常可能夹带地址，只把固定原因交给界面。
    throw new FullscreenImageSourceError('unavailable');
  } finally {
    clearTimeout(timer);
    // 原生读取未真正结束前不能释放准备槽，取消只让消费者停止等候。
    leave?.();
  }
}
