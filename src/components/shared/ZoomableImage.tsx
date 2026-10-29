/**
 * ZoomableImage — 全屏图片缩放/平移查看器
 *
 * 能力：
 *  - 双指捏合缩放（以光标位置为锚点）
 *  - 双指滑动 / 滚轮平移
 *  - 缩放后按住拖拽平移（grab / grabbing）
 *  - 双击在 1x / 2x 间切换（对准光标）
 *  - 底部控制条：缩小 / 百分比（点击复位）/ 放大
 * 复位：scale 回到 1 时自动归位；src 变化时重置。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useImageViewportGesture } from '../../hooks/useImageViewportGesture';
import { acquireFullscreenImageSource, FullscreenImageSourceError, FULLSCREEN_IMAGE_ERRORS } from '../../services/fullscreenImageSource';
import type { ComfyMediaSourceLease } from '../../services/comfyMediaSource';
import { useT } from '../../i18n';

const MIN_SCALE = 1;
const MAX_SCALE = 8;

interface ZoomableImageProps {
  src: string;
  alt?: string;
  className?: string;
  onError?: () => void;
  onClose?: () => void;
  controlsPrefix?: ReactNode;
}

export default function ZoomableImage({ src, alt = '', className = '', onError, onClose, controlsPrefix }: ZoomableImageProps) {
  const t = useT();
  const [retry, setRetry] = useState(0);
  const [prepared, setPrepared] = useState<{
    source: string; retry: number; request: AbortController;
    lease?: ComfyMediaSourceLease; error?: keyof typeof FULLSCREEN_IMAGE_ERRORS;
  }>();
  useEffect(() => {
    const request = new AbortController();
    let lease: ComfyMediaSourceLease | undefined;
    void acquireFullscreenImageSource(src, request.signal).then((result) => {
      if (request.signal.aborted) { result.release(); return; }
      lease = result;
      setPrepared({ source: src, retry, request, lease });
    }, (error: unknown) => {
      if (request.signal.aborted) return;
      setPrepared({ source: src, retry, request,
        error: error instanceof FullscreenImageSourceError ? error.code : 'unavailable' });
    });
    return () => { request.abort(); lease?.release(); };
  }, [src, retry]);
  const current = prepared?.source === src && prepared.retry === retry ? prepared : undefined;
  const displaySrc = current && !current.error && !current.request.signal.aborted ? current.lease?.src : undefined;
  const {
    containerRef,
    containerEl,
    scale,
    tx,
    ty,
    cursor,
    onPointerDown,
    reset,
    zoomTo,
  } = useImageViewportGesture({ minScale: MIN_SCALE, maxScale: MAX_SCALE });

  // src 变化时重置视图
  useEffect(() => {
    reset();
  }, [src, reset]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.target === e.currentTarget) return;
    const el = containerEl.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    zoomTo(scale > MIN_SCALE ? MIN_SCALE : 2, cx, cy);
    // containerEl 是 useImageViewportGesture 返回的 ref，本身恒定；把它列进依赖会让
    // react-hooks/preserve-manual-memoization 判定依赖与推断不符而放弃编译优化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, zoomTo]);

  const stepZoom = useCallback((dir: 1 | -1) => {
    zoomTo(scale * (dir > 0 ? 1.4 : 1 / 1.4), 0, 0);
  }, [scale, zoomTo]);

  const handleClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    // 图片和控制栏都属于查看器内容，只有直接点到空白背景才关闭。
    if (event.target === event.currentTarget && scale <= MIN_SCALE) onClose?.();
  }, [scale, onClose]);

  const handleMouseDownOrUp = (event: React.MouseEvent) => {
    // 原始倍率的空白交给 Tauri 拖窗口；图片、控件与放大后的平移仍留在查看器。
    if (event.target !== event.currentTarget || scale > MIN_SCALE) event.stopPropagation();
  };

  return (
    <div
      ref={containerRef}
      className="zoomable-image-container"
      data-tauri-drag-region={scale <= MIN_SCALE ? 'true' : 'false'}
      style={{ cursor }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown(event);
      }}
      onMouseDown={handleMouseDownOrUp}
      onMouseUp={handleMouseDownOrUp}
      onDoubleClick={handleDoubleClick}
      onClick={handleClick}
    >
      <div className="zoomable-image-stage">
        {current?.error ? (
          <div role="alert" className="flex max-w-lg flex-col items-center gap-3 p-3 text-center text-sm text-canvas-text-secondary" onDoubleClick={(event) => event.stopPropagation()}>
            <p>{t(FULLSCREEN_IMAGE_ERRORS[current.error])}</p>
            <div className="flex gap-2">
              <button type="button" className="ui-btn ui-btn--sm" onClick={() => setRetry((value) => value + 1)}>{t('重新加载')}</button>
              {onClose && <button type="button" className="ui-btn ui-btn--sm" onClick={onClose}>{t('关闭')}</button>}
            </div>
          </div>
        ) : !displaySrc ? (
          <div role="status" className="p-3 text-sm text-canvas-text-secondary">{t('正在加载...')}</div>
        ) : <img
          src={displaySrc}
          alt={alt}
          className={className}
          draggable={false}
          onError={() => {
            current?.request.abort();
            if (current) setPrepared({ ...current, lease: undefined, error: 'unavailable' });
            onError?.();
          }}
          style={{
            transform: scale === MIN_SCALE && tx === 0 && ty === 0
              ? 'none' : `translate(${tx}px, ${ty}px) scale(${scale})`,
          }}
        />}
      </div>

      <div className={`zoom-controls${controlsPrefix ? ' image-comparison-toolbar w-max max-w-[calc(100vw-1rem)] flex-wrap justify-center' : ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        {controlsPrefix}
        <button type="button" className="zoom-btn" onClick={() => stepZoom(-1)} aria-label={t('缩小')} disabled={scale <= MIN_SCALE}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button type="button" className="zoom-percent" onClick={reset} aria-label={t('复位缩放')} data-tooltip={t('点击复位')}>
          {Math.round(scale * 100)}%
        </button>
        <button type="button" className="zoom-btn" onClick={() => stepZoom(1)} aria-label={t('放大')} disabled={scale >= MAX_SCALE}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
