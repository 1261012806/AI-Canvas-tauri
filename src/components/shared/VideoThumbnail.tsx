import { useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useViewportMediaSource } from '../../hooks/useViewportMediaSource';
import { resolveResourceVideoSource } from '../../hooks/useResourceVideoPreview';
import { acquireCanvasVideoPoster, type CanvasVideoPoster } from '../nodes/shared/video/canvasVideoPreviewCache';
import { resolveVideoThumbnailPoster } from './videoThumbnailSource';
import ViewportImage from './ViewportImage';

export interface VideoThumbnailProps {
  src?: string;
  filePath?: string;
  poster?: string;
  name?: string;
  alt?: string;
  /** 外层尺寸、圆角和 object-fit 由调用方提供；内部图片继承 object-fit。 */
  className?: string;
}

/** 静态视频封面，不挂载播放器；与视频节点共享取帧缓存和可释放租约。 */
export default function VideoThumbnail({ src, filePath, poster, name, alt, className = '' }: VideoThumbnailProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const source = src?.trim() ? src : undefined;
  const identity = JSON.stringify([source, filePath, poster]);
  const visible = useViewportMediaSource(identity, rootRef, { rootMargin: '160px 0px' });
  const [failedPoster, setFailedPoster] = useState<string>();
  const suppliedPoster = failedPoster === identity ? undefined : resolveVideoThumbnailPoster(poster, source, filePath);
  const [derived, setDerived] = useState<{
    identity: string; src?: string; request: AbortController; release: () => void;
  }>();

  useEffect(() => {
    if (!visible || suppliedPoster || (!source && !filePath)) return;
    const request = new AbortController();
    let held: CanvasVideoPoster | null = null;
    const release = () => { held?.release(); held = null; };
    const prepare = async () => {
      // 优先使用视频节点的原始 source 命中同一缓存，不剥离授权 query。
      const primary = source || await resolveResourceVideoSource(undefined, filePath);
      if (!primary || request.signal.aborted) return;
      let result = await acquireCanvasVideoPoster(primary, request.signal);
      if (request.signal.aborted) { result?.release(); return; }
      if (!result && source && filePath) {
        const fallback = await resolveResourceVideoSource(undefined, filePath);
        if (request.signal.aborted) return;
        if (fallback && fallback !== primary) result = await acquireCanvasVideoPoster(fallback, request.signal);
      }
      if (request.signal.aborted) { result?.release(); return; }
      held = result;
      setDerived({ identity, src: result?.src, request, release });
    };
    void prepare().catch(() => {
      release();
      if (!request.signal.aborted) setDerived({ identity, request, release });
    });
    return () => { request.abort(); release(); };
  }, [visible, identity, source, filePath, suppliedPoster]);

  const current = derived?.identity === identity && !derived.request.signal.aborted ? derived : undefined;
  const image = visible ? suppliedPoster || current?.src : undefined;
  const label = alt ?? name ?? '';
  return <span ref={rootRef} className={`inline-flex items-center justify-center overflow-hidden ${className}`}
    data-video-thumbnail={image ? 'ready' : 'placeholder'} role={!image && label ? 'img' : undefined}
    aria-label={!image && label ? label : undefined} aria-hidden={!image && !label ? true : undefined}>
    {image ? <ViewportImage src={image} alt={label} className="block h-full w-full [object-fit:inherit]" draggable={false}
      loading="lazy" decoding="async" onError={() => {
        if (suppliedPoster) setFailedPoster(identity);
        else if (current) { current.release(); setDerived({ ...current, src: undefined }); }
      }} /> : <Icon icon="lucide:film" className="h-5 w-5 shrink-0" aria-hidden="true" />}
  </span>;
}
