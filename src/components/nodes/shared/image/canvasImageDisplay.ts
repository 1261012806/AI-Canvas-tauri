import { acquireCachedCanvasImagePreview, acquireCanvasImagePreview } from './canvasImagePreviewCache';
import { getPerformanceModeBudget } from '../../../../services/performanceModeRuntime';
import { acquireComfyImageSource, shouldLoadNativeComfyImage } from '../../../../services/comfyImageSource';

export interface DisplayQueue {
  enqueue: (key: object, commit: () => void, delayMs?: number) => () => void;
  prepare: (key: object, work: () => Promise<void>, delayMs?: number) => () => void;
}
export interface DisplayImageLease { src: string; release: () => void }
const TIERS = [256, 512, 1024, 0] as const;

/** 上下行各留 10% 余量；原图也是显示档位，不能绕开调度。 */
export function canvasImageTier(screenEdge: number, previous?: number): number {
  const raw = !Number.isFinite(screenEdge) || screenEdge <= 0 || screenEdge > 1024
    ? 0 : screenEdge <= 256 ? 256 : screenEdge <= 512 ? 512 : 1024;
  if (previous === undefined || !Number.isFinite(screenEdge) || screenEdge <= 0) return raw;
  const before = TIERS.indexOf(previous as typeof TIERS[number]);
  const after = TIERS.indexOf(raw as typeof TIERS[number]);
  if (before < 0) return raw;
  if (after > before && screenEdge <= previous * 1.1) return previous;
  if (after < before && screenEdge >= TIERS[before - 1] * 0.9) return previous;
  return raw;
}

function decodeImage(src: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const image = new Image();
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      image.onload = image.onerror = null;
      if (error) { image.removeAttribute('src'); reject(error); }
      else resolve();
    };
    const abort = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Image preparation timed out')), 15_000);
    signal.addEventListener('abort', abort, { once: true });
    image.decoding = 'async';
    image.onload = () => {
      if (typeof image.decode === 'function') void image.decode().then(() => finish(), finish);
      else finish();
    };
    image.onerror = () => finish(new Error('Image preparation failed'));
    image.src = src;
  });
}

export async function prepareCanvasImage(source: string, edge: number, signal: AbortSignal, projectId?: string | null): Promise<DisplayImageLease> {
  const lease = edge > 0 ? await acquireCanvasImagePreview(source, edge, signal, projectId)
    : shouldLoadNativeComfyImage(source) ? await acquireComfyImageSource(source, signal) : null;
  try {
    signal.throwIfAborted();
    if (edge > 0 && !lease) throw new Error('图片预览暂不可用，请重试或主动打开原图');
    await decodeImage(lease?.src ?? source, signal);
    return lease ?? { src: source, release: () => {} };
  } catch (error) {
    lease?.release();
    signal.throwIfAborted();
    // 预览失败不能自动改解码原图，否则预算拒绝和超时都会失效。
    throw error;
  }
}

/** viewport 更新只改目标，只有队列提交才更新 React 显示。 */
export function createCanvasImageDisplay(options: {
  source: string;
  projectId?: string | null;
  queue: DisplayQueue;
  publish: (lease: DisplayImageLease) => void;
  onError?: (error: unknown) => void;
  prepare?: typeof prepareCanvasImage;
}) {
  const prepareKey = {};
  const displayKey = {};
  const held = new Set<DisplayImageLease>();
  let disposed = false;
  let target: number | undefined;
  let displayed: { edge: number; lease: DisplayImageLease } | undefined;
  let abort: (() => void) | undefined;
  let generation = 0;

  function request(edge: number, force = false) {
    if (disposed || (!force && target === edge)) return;
    target = edge;
    abort?.();
    const version = ++generation;
    if (!displayed && !force) {
      // 首次入场复用现成小图，不等待交互结束；升档和原图仍由原队列调度。
      const cached = acquireCachedCanvasImagePreview(options.source, edge || 1024, new AbortController().signal, options.projectId);
      if (cached) {
        held.add(cached);
        displayed = { edge: cached.maxEdge, lease: cached };
        options.publish(cached);
      }
    }
    if (!force && displayed?.edge === edge) return;
    const controller = new AbortController();
    let prepared: DisplayImageLease | undefined;
    let transferred = false;
    let cancelDisplay: (() => void) | undefined;
    const stale = () => disposed || controller.signal.aborted || version !== generation;
    const before = displayed ? TIERS.indexOf(displayed.edge as typeof TIERS[number]) : -1;
    const after = TIERS.indexOf(edge as typeof TIERS[number]);
    const delay = displayed ? (before - after >= 2 ? 1000 : 180) : 0;
    const cancelPrepare = options.queue.prepare(prepareKey, async () => {
      if (stale()) return;
      try {
        const result = await (options.prepare ?? prepareCanvasImage)(options.source, edge, controller.signal, options.projectId);
        if (stale()) { result.release(); return; }
        let released = false;
        const lease = { src: result.src, release: () => {
          if (released) return;
          released = true;
          result.release();
          controller.abort();
        } };
        prepared = lease;
        cancelDisplay = options.queue.enqueue(displayKey, () => {
          if (stale()) return;
          prepared = undefined;
          transferred = true;
          held.add(lease);
          displayed = { edge, lease };
          options.publish(lease);
        });
      } catch (error) {
        if (!stale() && !displayed) options.onError?.(error);
      }
    }, delay);
    abort = () => {
      if (!transferred) controller.abort();
      cancelPrepare();
      cancelDisplay?.();
      prepared?.release();
      prepared = undefined;
    };
  }

  return {
    viewport(zoom: number, width: number, height: number, pixelRatio: number, performanceMode = false) {
      if (!Number.isFinite(zoom) || zoom <= 0) return;
      const tier = canvasImageTier(Math.max(width, height) * zoom * pixelRatio, target);
      // 只限制画布预览的自动档位；主动查看原图仍走独立入口。
      const cap = getPerformanceModeBudget(performanceMode).imagePreviewMaxEdge;
      request(cap > 0 ? (tier === 0 ? cap : Math.min(tier, cap)) : tier);
    },
    original() { request(0, true); },
    committed(lease: DisplayImageLease) {
      // React 提交新 src 后才归还旧租约，跳过中间显示状态也不会泄漏。
      for (const previous of held) {
        if (previous !== lease && previous !== displayed?.lease) { previous.release(); held.delete(previous); }
      }
    },
    dispose() {
      disposed = true;
      abort?.();
      for (const lease of held) lease.release();
      held.clear();
    },
  };
}
