import { useCallback, useEffect, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useImageViewportGesture } from '../../hooks/useImageViewportGesture';
import { useT } from '../../i18n';
import type { ComfyMediaSourceLease } from '../../services/comfyMediaSource';
import { acquireFullscreenImageSource, FullscreenImageSourceError, FULLSCREEN_IMAGE_ERRORS } from '../../services/fullscreenImageSource';

type SourceError = keyof typeof FULLSCREEN_IMAGE_ERRORS;

function useComparisonSource(source: string, fallback: string | undefined, projectId: string | null) {
  const [retry, setRetry] = useState(0);
  const [fallbackFor, setFallbackFor] = useState<string>();
  const [prepared, setPrepared] = useState<{
    source: string; fallback?: string; projectId: string | null; retry: number; fallbackFor?: string;
    lease?: ComfyMediaSourceLease; usedFallback?: boolean; error?: SourceError;
  }>();

  useEffect(() => {
    const request = new AbortController();
    let lease: ComfyMediaSourceLease | undefined;
    const load = async () => {
      const fallbackOnly = fallbackFor === source && !!fallback && fallback !== source;
      const candidates = fallbackOnly ? [fallback] : [source, ...(fallback && fallback !== source ? [fallback] : [])];
      let lastError: SourceError = 'unavailable';
      for (const candidate of candidates) {
        if (!candidate) continue;
        try {
          const result = await acquireFullscreenImageSource(candidate, request.signal);
          if (request.signal.aborted) { result.release(); return; }
          lease = result;
          setPrepared({ source, fallback, projectId, retry, fallbackFor, lease, usedFallback: candidate !== source });
          return;
        } catch (error) {
          if (request.signal.aborted) return;
          lastError = error instanceof FullscreenImageSourceError ? error.code : 'unavailable';
        }
      }
      setPrepared({ source, fallback, projectId, retry, fallbackFor, error: lastError });
    };
    void load();
    return () => { request.abort(); lease?.release(); };
  }, [source, fallback, projectId, retry, fallbackFor]);

  const current = prepared?.source === source && prepared.fallback === fallback && prepared.projectId === projectId
    && prepared.retry === retry && prepared.fallbackFor === fallbackFor ? prepared : undefined;
  const onError = () => {
    if (!current) return;
    if (!current.usedFallback && fallback && fallback !== source) setFallbackFor(source);
    else { current.lease?.release(); setPrepared({ ...current, lease: undefined, error: 'unavailable' }); }
  };
  const reload = () => { setFallbackFor(undefined); setRetry((value) => value + 1); };
  return { src: current?.lease?.src, error: current?.error, onError, reload };
}

interface ImageComparisonProps {
  leftSrc: string;
  rightSrc: string;
  rightFallbackSrc?: string;
  projectId: string | null;
  mode: 'slider' | 'side-by-side';
  controlsPrefix?: ReactNode;
}

/** 只读全屏对比；图片租约在切换或关闭时释放。 */
export default function ImageComparison({ leftSrc, rightSrc, rightFallbackSrc, projectId, mode, controlsPrefix }: ImageComparisonProps) {
  const t = useT();
  const left = useComparisonSource(leftSrc, undefined, projectId);
  const right = useComparisonSource(rightSrc, rightFallbackSrc, projectId);
  const [position, setPosition] = useState(50);
  const { containerRef, containerEl, scale, tx, ty, cursor, onPointerDown, reset, zoomTo } = useImageViewportGesture();

  useEffect(() => { reset(); }, [leftSrc, rightSrc, mode, reset]);
  const moveDivider = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const stage = event.currentTarget.parentElement;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width) setPosition(Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100)));
  }, []);
  const transform = scale === 1 && tx === 0 && ty === 0 ? undefined : `translate(${tx}px, ${ty}px) scale(${scale})`;

  const message = left.error || right.error;
  return (
    <div ref={containerRef} className="absolute inset-0 flex items-center justify-center overflow-hidden px-12 pb-20 pt-16"
      style={{ cursor }} onPointerDown={(event) => { event.stopPropagation(); onPointerDown(event); }}
      onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => {
        event.preventDefault(); event.stopPropagation();
        const rect = containerEl.current?.getBoundingClientRect();
        if (rect) zoomTo(scale > 1 ? 1 : 2, event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
      }}>
      {message ? (
        <div role="alert" className="flex flex-col items-center gap-3 p-3 text-center text-sm text-white/75">
          <p>{t(FULLSCREEN_IMAGE_ERRORS[message])}</p>
          <button type="button" className="ui-btn ui-btn--sm" onClick={() => { if (left.error) left.reload(); if (right.error) right.reload(); }}>{t('重新加载')}</button>
        </div>
      ) : !left.src || !right.src ? (
        <div role="status" className="text-sm text-white/75">{t('正在加载...')}</div>
      ) : mode === 'slider' ? (
        <div className="relative inline-flex max-h-full max-w-full select-none" style={{ transform }}>
          <img src={right.src} alt={t('对照图片')} draggable={false} onError={right.onError} className="block max-h-[calc(100vh-9rem)] max-w-full object-contain" />
          <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}>
            <img src={left.src} alt={t('当前图片')} draggable={false} onError={left.onError} className="h-full w-full object-contain" />
          </div>
          <div role="slider" tabIndex={0} aria-label={t('对比分割线')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(position)}
            className="absolute inset-y-0 z-10 w-8 -translate-x-1/2 cursor-ew-resize touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-canvas-text"
            style={{ left: `${position}%` }}
            onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); moveDivider(event); }}
            onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveDivider(event); }}
            onKeyDown={(event) => {
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? 100
                : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? position - 1
                  : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? position + 1 : null;
              if (next !== null) { event.preventDefault(); event.stopPropagation(); setPosition(Math.max(0, Math.min(100, next))); }
            }}>
            <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-canvas-text shadow-lg" />
            <span aria-hidden="true" className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-canvas-border bg-canvas-surface text-xs text-canvas-text shadow-lg">‹ ›</span>
          </div>
        </div>
      ) : (
        <div className="flex h-full w-full min-w-0 gap-2" style={{ transform }}>
          <div className="flex min-w-0 flex-1 items-center justify-center overflow-hidden"><img src={left.src} alt={t('当前图片')} draggable={false} onError={left.onError} className="max-h-full max-w-full object-contain" /></div>
          <div className="flex min-w-0 flex-1 items-center justify-center overflow-hidden"><img src={right.src} alt={t('对照图片')} draggable={false} onError={right.onError} className="max-h-full max-w-full object-contain" /></div>
        </div>
      )}
      <div className="zoom-controls image-comparison-toolbar w-max max-w-[calc(100vw-1rem)] flex-wrap justify-center" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        {controlsPrefix}
        <button type="button" className="zoom-btn" aria-label={t('缩小')} disabled={scale <= 1} onClick={() => zoomTo(scale / 1.4)}>−</button>
        <button type="button" className="zoom-percent" aria-label={t('复位缩放')} onClick={reset}>{Math.round(scale * 100)}%</button>
        <button type="button" className="zoom-btn" aria-label={t('放大')} disabled={scale >= 8} onClick={() => zoomTo(scale * 1.4)}>＋</button>
      </div>
    </div>
  );
}
