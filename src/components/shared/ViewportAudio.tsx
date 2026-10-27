import { forwardRef, useCallback, useEffect, useRef, type AudioHTMLAttributes } from 'react';
import { useViewportMediaSource } from '../../hooks/useViewportMediaSource';
import { useComfyMediaSource } from '../../hooks/useComfyMediaSource';

interface ViewportAudioProps extends AudioHTMLAttributes<HTMLAudioElement> { eager?: boolean }

/** 与视口视频共用挂载语义；Comfy 原链接只交给原生媒体源解析器。 */
const ViewportAudio = forwardRef<HTMLAudioElement, ViewportAudioProps>(function ViewportAudio({ src, eager = false, ...props }, forwardedRef) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const mountedSrc = useViewportMediaSource(src, audioRef, { eager });
  const displaySrc = useComfyMediaSource(mountedSrc, () => audioRef.current?.dispatchEvent(new Event('error')));
  const bind = useCallback((audio: HTMLAudioElement | null) => {
    audioRef.current = audio;
    if (typeof forwardedRef === 'function') forwardedRef(audio);
    else if (forwardedRef) forwardedRef.current = audio;
  }, [forwardedRef]);
  useEffect(() => {
    const audio = audioRef.current;
    if (audio && displaySrc && audio.getAttribute('src') !== displaySrc) audio.src = displaySrc;
    return () => { audio?.pause(); audio?.removeAttribute('src'); audio?.load(); };
  }, [displaySrc]);
  return <audio {...props} ref={bind} src={displaySrc} data-viewport-audio={displaySrc ? 'loaded' : 'deferred'} />;
});

export default ViewportAudio;
