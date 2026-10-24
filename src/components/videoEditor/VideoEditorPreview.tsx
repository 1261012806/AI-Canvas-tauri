/**
 * VideoEditorPreview — 预览区与走带控制
 *
 * 主轨用 WebView 原生 <video> 播放（吃系统解码器，稳定），
 * 叠加轨片段以绝对定位 div 叠在画面上，可直接拖拽移动、缩放、旋转。
 *
 * 播放头是「时间轴坐标」，这里负责换算到当前片段的素材坐标，
 * 播到片段末尾就把播放头推进到下一段，由父组件切换活动片段。
 */
import Select from '../shared/Select';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '@iconify/react';
import { computeDrawRect } from '../../services/videoCompositor';
import {
  DEFAULT_TEXT_STYLE,
  DEFAULT_TRANSFORM,
  evaluateTransitionAlpha,
  getActiveClips,
  getClipDuration,
  getClipEnd,
  getOverlayTracks,
  getVideoTrack,
  type VideoEditorCanvasSize,
  type VideoEditorClip,
  type VideoEditorTrack,
  type VideoEditorTransform,
} from '../../types/videoEditor';
import { resolveClipUrl } from './useVideoEditorSources';
import { useT } from '../../i18n';

interface VideoEditorPreviewProps {
  clip: VideoEditorClip | null;
  clipUrl: string;
  playhead: number;
  timelineDuration: number;
  /** 全部轨道，用于渲染叠加层 */
  tracks: VideoEditorTrack[];
  /** 选中片段 ID，用于在画面上高亮叠加层 */
  selectedClipIds: string[];
  /** 画布尺寸，用于计算叠加层归一化坐标到像素的映射 */
  canvasSize: { width: number; height: number };
  /** 当前主素材的原始尺寸；与导出合成共用 contain + transform 计算 */
  sourceSize?: { width: number; height: number } | null;
  onPlayheadChange: (time: number) => void;
  onSelectClips: (clipIds: string[]) => void;
  onBeginInteraction: () => void;
  onEndInteraction: () => void;
  /** 修改叠加层片段的 transform */
  onTransformChange: (clipId: string, patch: Partial<VideoEditorTransform>) => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.00';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}

function parseTimecode(value: string): number | null {
  const parts = value.trim().split(':').map(Number);
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

/** 缩放手柄的位置 */
type HandlePos = 'nw' | 'ne' | 'sw' | 'se';
type TransformMode = 'move' | 'scale' | 'rotate';
type PreviewZoom = 'fit' | 25 | 50 | 100;

interface OverlayMediaProps {
  clip: VideoEditorClip;
  playhead: number;
  playing: boolean;
  muted: boolean;
  volume: number;
  canvasDisplayScale: number;
}

/**
 * 叠加视频拥有独立媒体元素，但时间由主轨播放头统一驱动。
 * 静音可避免多轨预览时重复出声，也允许 WebView 自动跟播。
 */
function OverlayMedia({ clip, playhead, playing, muted, volume, canvasDisplayScale }: OverlayMediaProps) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = resolveClipUrl(clip);
  const failed = !!url && failedUrl === url;
  const sourceTime = clip.sourceIn + (playhead - clip.timelineStart);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || clip.kind !== 'video') return;
    if (Math.abs(video.currentTime - sourceTime) > 0.05) {
      video.currentTime = Math.max(0, sourceTime);
    }
  }, [clip.kind, sourceTime, url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || clip.kind !== 'video' || failed) return;
    if (playing) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [clip.kind, failed, playing, url]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);

  if (clip.kind === 'text') {
    const textStyle = { ...DEFAULT_TEXT_STYLE, ...clip.textStyle };
    return (
      <div
        className="video-editor-overlay-text"
        style={{
          color: textStyle.color,
          fontFamily: textStyle.fontFamily,
          fontSize: `${Math.max(8, textStyle.fontSize * canvasDisplayScale)}px`,
          fontWeight: textStyle.fontWeight,
          textAlign: textStyle.align,
        }}
      >
        {textStyle.content || DEFAULT_TEXT_STYLE.content}
      </div>
    );
  }

  if (!url || failed) {
    return <div className="video-editor-stage-empty">{t('素材无法预览')}</div>;
  }

  if (clip.kind === 'image') {
    return (
      <img
        src={url}
        alt=""
        draggable={false}
        className="video-editor-overlay-img"
        onError={() => setFailedUrl(url)}
      />
    );
  }

  return (
    <video
      ref={videoRef}
      src={url}
      className="video-editor-overlay-img"
      preload="auto"
      muted={muted}
      playsInline
      onError={() => setFailedUrl(url)}
    />
  );
}

/** 主轨画面在画布上的摆放；与导出共用 computeDrawRect，避免预览/成片偏差 */
function mediaRectStyle(
  source: { width: number; height: number } | null | undefined,
  canvas: VideoEditorCanvasSize,
  transform: VideoEditorTransform,
  opacity: number,
): CSSProperties {
  const resolved = source && source.width > 0 && source.height > 0 ? source : canvas;
  const rect = computeDrawRect(resolved, canvas, transform);
  return {
    left: `${(rect.x / Math.max(1, canvas.width)) * 100}%`,
    top: `${(rect.y / Math.max(1, canvas.height)) * 100}%`,
    width: `${(rect.width / Math.max(1, canvas.width)) * 100}%`,
    height: `${(rect.height / Math.max(1, canvas.height)) * 100}%`,
    opacity,
    transform: `rotate(${transform.rotation}deg)`,
  };
}

interface TransitionUnderlayProps {
  clip: VideoEditorClip;
  /** 素材坐标：交叠淡入取的是前一段出点之后的画面 */
  sourceTime: number;
  playing: boolean;
  style: CSSProperties;
}

/**
 * 交叠淡入期间垫在底下的前一段画面。
 *
 * 这一段在时间轴上已经结束，取的是它出点之后的素材，没法复用主轨那个
 * <video>，只能单开一个元素。转场窗口最长 3s，多解一路的代价可以接受。
 */
function TransitionUnderlay({ clip, sourceTime, playing, style }: TransitionUnderlayProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const url = resolveClipUrl(clip);
  const target = Math.max(0, sourceTime);

  // 转场期间底画面与播放头同速前进，靠原生播放跟随即可，只在漂移时纠偏
  useEffect(() => {
    const video = videoRef.current;
    if (!video || video.readyState === 0) return;
    if (Math.abs(video.currentTime - target) > 0.08) video.currentTime = target;
  }, [target]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) void video.play().catch(() => {});
    else video.pause();
  }, [playing, url]);

  const applyReadyState = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = target;
    if (playing) void video.play().catch(() => {});
  };

  if (!url || clip.kind === 'text') return null;
  if (clip.kind === 'image') {
    return (
      <img src={url} alt="" draggable={false} className="video-editor-video underlay" style={style} />
    );
  }
  return (
    <video
      ref={videoRef}
      src={url}
      className="video-editor-video underlay"
      style={style}
      preload="auto"
      muted
      playsInline
      onLoadedMetadata={applyReadyState}
    />
  );
}

interface AudioPreviewProps {
  clip: VideoEditorClip;
  playhead: number;
  playing: boolean;
  muted: boolean;
  volume: number;
}

/** 音频轨走带：由统一播放头定位，播放状态与主走带保持一致。 */
function AudioPreview({ clip, playhead, playing, muted, volume }: AudioPreviewProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const url = resolveClipUrl(clip);
  const sourceTime = clip.sourceIn + (playhead - clip.timelineStart);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (Math.abs(audio.currentTime - sourceTime) > 0.05) {
      audio.currentTime = Math.max(0, sourceTime);
    }
  }, [sourceTime, url]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) void audio.play().catch(() => {});
    else audio.pause();
  }, [playing, url]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);

  if (!url) return null;
  return <audio ref={audioRef} src={url} preload="auto" muted={muted} />;
}

function VideoEditorPreview({
  clip,
  clipUrl,
  playhead,
  timelineDuration,
  tracks,
  selectedClipIds,
  canvasSize,
  sourceSize,
  onPlayheadChange,
  onSelectClips,
  onBeginInteraction,
  onEndInteraction,
  onTransformChange,
}: VideoEditorPreviewProps) {
  const t = useT();
  const previewRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasFrameRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [previewZoom, setPreviewZoom] = useState<PreviewZoom>('fit');
  const [fullscreen, setFullscreen] = useState(false);
  const [editingTimecode, setEditingTimecode] = useState(false);
  const [timecodeDraft, setTimecodeDraft] = useState(() => formatTime(playhead));
  const [canvasDisplayScale, setCanvasDisplayScale] = useState(1);
  const [stageContentSize, setStageContentSize] = useState({ width: 0, height: 0 });
  // 由播放推动的时间更新不该再写回 video.currentTime，否则会打断播放
  const drivenByPlayback = useRef(false);
  // 画面内直接变换状态：主轨和叠加层共用同一套拖拽手势。
  const [dragTransform, setDragTransform] = useState<{
    clipId: string;
    mode: TransformMode;
    handle?: HandlePos;
    startClientX: number;
    startClientY: number;
    startTransform: VideoEditorTransform;
    frameRect: DOMRect;
  } | null>(null);
  const [snapGuides, setSnapGuides] = useState({ x: false, y: false });

  const clipEnd = clip ? clip.timelineStart + getClipDuration(clip) : 0;
  const sourceTime = clip ? clip.sourceIn + (playhead - clip.timelineStart) : 0;
  const mainTrack = useMemo(() => getVideoTrack(tracks), [tracks]);
  const mainTrackHidden = mainTrack?.hidden === true;
  const mainTrackMuted = mainTrack?.muted === true || mainTrackHidden;
  const mainVolume = (mainTrack?.volume ?? 1) * (clip?.volume ?? 1);

  useEffect(() => {
    const handleFullscreenChange = () => setFullscreen(document.fullscreenElement === previewRef.current);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const commitTimecode = useCallback(() => {
    const parsed = parseTimecode(timecodeDraft);
    if (parsed !== null) onPlayheadChange(Math.min(timelineDuration, parsed));
    else setTimecodeDraft(formatTime(playhead));
    setEditingTimecode(false);
  }, [onPlayheadChange, playhead, timecodeDraft, timelineDuration]);

  const toggleFullscreen = useCallback(() => {
    const preview = previewRef.current;
    if (!preview) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    void preview.requestFullscreen().catch(() => {});
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      const styles = window.getComputedStyle(stage);
      const horizontalPadding = (Number.parseFloat(styles.paddingLeft) || 0)
        + (Number.parseFloat(styles.paddingRight) || 0);
      const verticalPadding = (Number.parseFloat(styles.paddingTop) || 0)
        + (Number.parseFloat(styles.paddingBottom) || 0);
      setStageContentSize({
        width: Math.max(0, stage.clientWidth - horizontalPadding),
        height: Math.max(0, stage.clientHeight - verticalPadding),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const frame = canvasFrameRef.current;
    if (!frame || canvasSize.width <= 0) return;
    const update = () => setCanvasDisplayScale(frame.clientWidth / canvasSize.width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [canvasSize.width]);

  // 换片段会重设 <video src>，元数据就绪前的定位与播放都会被随后的 load 打断，
  // 所以把目标位置存下来，等 loadedmetadata / canplay 再补上。
  const pendingSeekRef = useRef(0);
  useEffect(() => { pendingSeekRef.current = Math.max(0, sourceTime); }, [sourceTime]);

  // 外部拖动播放头 → 同步到 video
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clip || clip.kind !== 'video' || drivenByPlayback.current) return;
    // readyState 为 0 表示新素材还在加载：此时写 currentTime 会被 load 丢掉
    if (video.readyState === 0) return;
    if (Math.abs(video.currentTime - sourceTime) > 0.05) {
      video.currentTime = sourceTime;
    }
  }, [clip, sourceTime]);

  /**
   * 新素材可播时补上定位并续播。
   *
   * 缺了这一步，播到两段交界处切换 src 时，之前那次 play() 会被新的 load 打断，
   * 走带状态还是「播放中」，画面却停在交界处不动。
   */
  const handleMediaReady = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const target = pendingSeekRef.current;
    if (Math.abs(video.currentTime - target) > 0.05) {
      video.currentTime = target;
    }
    if (playing && video.paused) void video.play().catch(() => {});
  }, [playing]);

  const playheadRef = useRef(playhead);
  useEffect(() => { playheadRef.current = playhead; }, [playhead]);

  const advanceTo = useCallback((nextPlayhead: number) => {
    if (nextPlayhead < clipEnd - 0.001) {
      onPlayheadChange(nextPlayhead);
      return;
    }
    if (clipEnd >= timelineDuration - 0.001) {
      videoRef.current?.pause();
      setPlaying(false);
      onPlayheadChange(timelineDuration);
      return;
    }
    onPlayheadChange(clipEnd + 0.001);
  }, [clipEnd, onPlayheadChange, timelineDuration]);

  useEffect(() => {
    if (!playing || clip?.kind !== 'image') return;
    const timer = setInterval(() => advanceTo(playheadRef.current + 0.1), 100);
    return () => clearInterval(timer);
  }, [advanceTo, clip?.kind, playing]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !clip) return;
    drivenByPlayback.current = true;
    advanceTo(clip.timelineStart + (video.currentTime - clip.sourceIn));
    drivenByPlayback.current = false;
  }, [advanceTo, clip]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (playing) {
      video?.pause();
      setPlaying(false);
      return;
    }
    if (playhead >= timelineDuration - 0.01) onPlayheadChange(0);
    setPlaying(true);
    if (clip?.kind === 'video') {
      void video?.play().catch(() => setPlaying(false));
    }
  }, [clip?.kind, onPlayheadChange, playhead, playing, timelineDuration]);

  const pausePlayback = useCallback(() => {
    videoRef.current?.pause();
    setPlaying(false);
  }, []);

  // 剪辑软件的播放控制是高频动作：在非输入区域支持 Space 与 J/K/L 走带。
  // 键盘操作保持即时，不附加额外动画或延迟。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, [contenteditable="true"]')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        pausePlayback();
      } else if (event.key === 'l' || event.key === 'L') {
        event.preventDefault();
        if (!playing) togglePlay();
      } else if (event.key === 'j' || event.key === 'J') {
        event.preventDefault();
        pausePlayback();
        onPlayheadChange(Math.max(0, playhead - 1));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onPlayheadChange, pausePlayback, playhead, playing, togglePlay]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || clip?.kind !== 'video') return;
    if (playing && video.paused) void video.play().catch(() => {});
    if (!playing && !video.paused) video.pause();
  }, [clip?.kind, clipUrl, playing]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = Math.max(0, Math.min(1, mainVolume));
  }, [mainVolume]);

  const step = useCallback((direction: 1 | -1) => {
    setPlaying(false);
    videoRef.current?.pause();
    onPlayheadChange(Math.min(timelineDuration, Math.max(0, playhead + direction / 30)));
  }, [onPlayheadChange, playhead, timelineDuration]);

  // ── 画面内直接拖拽、等比缩放和旋转 ──
  const overlayTracks = useMemo(
    () => getOverlayTracks(tracks).filter((track) => track.kind === 'video'),
    [tracks],
  );
  const activeOverlays = useMemo(() => {
    const result: { clip: VideoEditorClip; track: VideoEditorTrack }[] = [];
    for (const track of overlayTracks) {
      if (track.hidden) continue;
      for (const c of getActiveClips(track, playhead)) {
        result.push({ clip: c, track });
      }
    }
    return result;
  }, [overlayTracks, playhead]);
  const activeAudio = useMemo(() => {
    const result: { clip: VideoEditorClip; track: VideoEditorTrack }[] = [];
    for (const track of tracks) {
      if (track.kind !== 'audio' || track.hidden) continue;
      for (const activeClip of getActiveClips(track, playhead)) {
        result.push({ clip: activeClip, track });
      }
    }
    return result;
  }, [playhead, tracks]);

  const startTransformInteraction = useCallback((
    targetClip: VideoEditorClip,
    mode: TransformMode,
    event: React.PointerEvent,
    handle?: HandlePos,
  ) => {
    event.stopPropagation();
    event.preventDefault();
    if (event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const frame = canvasFrameRef.current;
    if (!frame) return;
    const frameRect = frame.getBoundingClientRect();
    onBeginInteraction();
    setSnapGuides({ x: false, y: false });
    setDragTransform({
      clipId: targetClip.id,
      mode,
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startTransform: targetClip.transform ?? DEFAULT_TRANSFORM,
      frameRect,
    });
    onSelectClips([targetClip.id]);
  }, [onBeginInteraction, onSelectClips]);

  useEffect(() => {
    if (!dragTransform) return;
    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - dragTransform.startClientX;
      const dy = moveEvent.clientY - dragTransform.startClientY;
      const { width: frameW, height: frameH } = dragTransform.frameRect;
      if (frameW <= 0 || frameH <= 0) return;

      if (dragTransform.mode === 'move') {
        const dxN = dx / frameW;
        const dyN = dy / frameH;
        const rawX = Math.max(0, Math.min(1, dragTransform.startTransform.x + dxN));
        const rawY = Math.max(0, Math.min(1, dragTransform.startTransform.y + dyN));
        const snapX = Math.abs(rawX - 0.5) <= 6 / frameW;
        const snapY = Math.abs(rawY - 0.5) <= 6 / frameH;
        setSnapGuides({ x: snapX, y: snapY });
        onTransformChange(dragTransform.clipId, {
          x: snapX ? 0.5 : rawX,
          y: snapY ? 0.5 : rawY,
        });
      } else {
        setSnapGuides({ x: false, y: false });
        const centerX = dragTransform.frameRect.left + dragTransform.startTransform.x * frameW;
        const centerY = dragTransform.frameRect.top + dragTransform.startTransform.y * frameH;
        if (dragTransform.mode === 'scale' && dragTransform.handle) {
          const startDistX = dragTransform.startClientX - centerX;
          const startDistY = dragTransform.startClientY - centerY;
          const startDist = Math.sqrt(startDistX * startDistX + startDistY * startDistY);
          const newDist = Math.sqrt(
            (moveEvent.clientX - centerX) ** 2 + (moveEvent.clientY - centerY) ** 2,
          );
          if (startDist > 4) {
            const ratio = newDist / startDist;
            onTransformChange(dragTransform.clipId, {
              scale: Math.max(0.05, Math.min(5, dragTransform.startTransform.scale * ratio)),
            });
          }
          return;
        }
        const startAngle = Math.atan2(
          dragTransform.startClientY - centerY,
          dragTransform.startClientX - centerX,
        );
        const currentAngle = Math.atan2(moveEvent.clientY - centerY, moveEvent.clientX - centerX);
        const angleDelta = ((currentAngle - startAngle) * 180) / Math.PI;
        const rawRotation = ((dragTransform.startTransform.rotation + angleDelta + 180) % 360 + 360) % 360 - 180;
        const snapAngle = [-180, -90, 0, 90, 180]
          .find((angle) => Math.abs(rawRotation - angle) <= 3);
        onTransformChange(dragTransform.clipId, { rotation: snapAngle ?? rawRotation });
      }
    };
    const finish = () => {
      setDragTransform(null);
      setSnapGuides({ x: false, y: false });
      onEndInteraction();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
    };
  }, [dragTransform, onEndInteraction, onTransformChange]);

  // ── 进度条 ──
  const startScrub = useCallback((event: React.PointerEvent) => {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const apply = (clientX: number) => {
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onPlayheadChange(ratio * timelineDuration);
    };
    apply(event.clientX);
    target.setPointerCapture(event.pointerId);
    const onMove = (moveEvent: PointerEvent) => apply(moveEvent.clientX);
    const onUp = (upEvent: PointerEvent) => {
      target.releasePointerCapture(upEvent.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  }, [onPlayheadChange, timelineDuration]);

  const progressPct = timelineDuration > 0 ? (playhead / timelineDuration) * 100 : 0;

  const stageInfo = useMemo(() => {
    if (canvasSize.width <= 0 || canvasSize.height <= 0) return null;
    return `${canvasSize.width}×${canvasSize.height}`;
  }, [canvasSize]);

  // 画布宽高比作为 canvas-frame 的 aspect-ratio
  const canvasAspect = canvasSize.width > 0 && canvasSize.height > 0
    ? `${canvasSize.width} / ${canvasSize.height}`
    : '16 / 9';

  const canvasFrameStyle = useMemo<CSSProperties>(() => {
    if (previewZoom !== 'fit') {
      return {
        aspectRatio: canvasAspect,
        width: `${canvasSize.width * (previewZoom / 100)}px`,
        height: `${canvasSize.height * (previewZoom / 100)}px`,
      };
    }
    if (
      canvasSize.width <= 0
      || canvasSize.height <= 0
      || stageContentSize.width <= 0
      || stageContentSize.height <= 0
    ) {
      return { aspectRatio: canvasAspect };
    }
    const fit = Math.min(
      stageContentSize.width / canvasSize.width,
      stageContentSize.height / canvasSize.height,
    );
    return {
      aspectRatio: canvasAspect,
      width: `${canvasSize.width * fit}px`,
      height: `${canvasSize.height * fit}px`,
    };
  }, [canvasAspect, canvasSize.height, canvasSize.width, previewZoom, stageContentSize]);

  // 转场用与合成端同一个函数求不透明度，避免预览和成片两套算法漂移
  const transitionAlpha = clip ? evaluateTransitionAlpha(clip, playhead - clip.timelineStart) : 1;

  /**
   * 交叠淡入垫在底下的前一段；规则与 videoCompositor 一致：
   * 只认时间轴上首尾严丝合缝相接的那一段。
   */
  const dissolveUnderlay = useMemo(() => {
    if (!clip || mainTrackHidden || transitionAlpha >= 1) return null;
    if (clip.transitionIn?.kind !== 'dissolve') return null;
    const index = mainTrack?.clips.indexOf(clip) ?? -1;
    if (index <= 0) return null;
    const previous = mainTrack!.clips[index - 1];
    if (Math.abs(getClipEnd(previous) - clip.timelineStart) > 0.001) return null;
    return previous;
  }, [clip, mainTrack, mainTrackHidden, transitionAlpha]);

  // 主轨与导出都通过 computeDrawRect 计算 contain、位置和缩放，避免预览/成片偏差。
  const mainMediaStyle = useMemo<CSSProperties>(() => mediaRectStyle(
    sourceSize,
    canvasSize,
    clip?.transform ?? DEFAULT_TRANSFORM,
    mainTrackHidden ? 0 : (clip?.transform ?? DEFAULT_TRANSFORM).opacity * transitionAlpha,
  ), [canvasSize, clip?.transform, mainTrackHidden, sourceSize, transitionAlpha]);
  const mainSelectionStyle = useMemo<CSSProperties>(() => ({
    ...mainMediaStyle,
    opacity: 1,
  }), [mainMediaStyle]);
  // 底画面尺寸未知（探测数据只跟着当前片段走），退回画布尺寸按 contain 铺满
  const underlayStyle = useMemo<CSSProperties>(() => mediaRectStyle(
    null,
    canvasSize,
    dissolveUnderlay?.transform ?? DEFAULT_TRANSFORM,
    (dissolveUnderlay?.transform ?? DEFAULT_TRANSFORM).opacity,
  ), [canvasSize, dissolveUnderlay?.transform]);
  const mainSelected = !!clip && selectedClipIds.includes(clip.id);
  const mainLocked = mainTrack?.locked === true;

  return (
    <section ref={previewRef} className="video-editor-preview">
      <div
        ref={stageRef}
        className={`video-editor-stage ${playing ? 'playing' : ''}`}
      >
        <div
          ref={canvasFrameRef}
          className={`video-editor-canvas-frame ${previewZoom === 'fit' ? 'fit' : 'zoomed'}`}
          style={canvasFrameStyle}
          aria-label={stageInfo ? `${t('输出画布')} ${stageInfo}` : t('输出画布')}
        >
          {/* 交叠淡入的底画面：必须排在主轨画面之前，靠 z-index 压在下层 */}
          {dissolveUnderlay && clip && (
            <TransitionUnderlay
              key={dissolveUnderlay.id}
              clip={dissolveUnderlay}
              sourceTime={dissolveUnderlay.sourceOut + (playhead - clip.timelineStart)}
              playing={playing}
              style={underlayStyle}
            />
          )}

          {/* 主轨画面：背景 + video/img 居中 */}
          {!clip || !clipUrl ? (
            <div className="video-editor-stage-empty">{t('无可预览的素材')}</div>
          ) : clip.kind === 'image' ? (
            <img
              src={clipUrl}
              className={`video-editor-video ${mainTrackHidden ? 'track-hidden' : ''}`}
              style={mainMediaStyle}
              alt=""
              draggable={false}
            />
          ) : (
            <video
              ref={videoRef}
              src={clipUrl}
              className={`video-editor-video ${mainTrackHidden ? 'track-hidden' : ''}`}
              style={mainMediaStyle}
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleMediaReady}
              onCanPlay={handleMediaReady}
              onPause={() => { if (!playing) setPlaying(false); }}
              preload="auto"
              muted={mainTrackMuted}
            />
          )}
          {mainTrackHidden && (
            <div className="video-editor-stage-empty">{t('主视频轨已隐藏')}</div>
          )}

          {clip && clipUrl && !mainTrackHidden && (
            <div
              className={[
                'video-editor-main-selection',
                mainSelected ? 'selected' : '',
                mainLocked ? 'locked' : '',
              ].filter(Boolean).join(' ')}
              style={mainSelectionStyle}
              aria-label={t('画面内调整 {name}', { name: clip.fileName })}
              onPointerDown={mainLocked
                ? (event) => {
                  event.stopPropagation();
                  onSelectClips([clip.id]);
                }
                : (event) => startTransformInteraction(clip, 'move', event)}
            >
              {mainSelected && !mainLocked && (
                <>
                  {(['nw', 'ne', 'sw', 'se'] as HandlePos[]).map((pos) => (
                    <button
                      type="button"
                      key={pos}
                      className={`video-editor-overlay-handle ${pos}`}
                      aria-label={t('等比缩放')}
                      onPointerDown={(event) => startTransformInteraction(clip, 'scale', event, pos)}
                    />
                  ))}
                  <span className="video-editor-rotation-stem" aria-hidden="true" />
                  <button
                    type="button"
                    className="video-editor-rotation-handle"
                    aria-label={t('旋转')}
                    onPointerDown={(event) => startTransformInteraction(clip, 'rotate', event)}
                  >
                    <Icon icon="lucide:rotate-cw" width={11} height={11} />
                  </button>
                </>
              )}
            </div>
          )}

          {/* 叠加层片段：绝对定位在画布之上，可直接拖拽编辑 */}
          {activeOverlays.map(({ clip: overlayClip, track }) => {
            const transform = overlayClip.transform ?? DEFAULT_TRANSFORM;
            const isSelected = selectedClipIds.includes(overlayClip.id);
            const locked = track.locked === true;
            const isText = overlayClip.kind === 'text';
            return (
              <div
                key={overlayClip.id}
                className={[
                  'video-editor-overlay',
                  isText ? 'text' : '',
                  isSelected ? 'selected' : '',
                  locked ? 'locked' : '',
                ].filter(Boolean).join(' ')}
                style={isText ? {
                  left: `${transform.x * 100}%`,
                  top: `${transform.y * 100}%`,
                  transform: `translate(-50%, -50%) rotate(${transform.rotation}deg) scale(${transform.scale})`,
                  opacity: transform.opacity,
                } : {
                  left: `${transform.x * 100}%`,
                  top: `${transform.y * 100}%`,
                  width: `${transform.scale * 100}%`,
                  height: `${transform.scale * 100}%`,
                  transform: `translate(-50%, -50%) rotate(${transform.rotation}deg)`,
                  opacity: transform.opacity,
                }}
                onPointerDown={locked
                  ? (event) => {
                    event.stopPropagation();
                    onSelectClips([overlayClip.id]);
                  }
                  : (event) => startTransformInteraction(overlayClip, 'move', event)}
              >
                <OverlayMedia
                  clip={overlayClip}
                  playhead={playhead}
                  playing={playing}
                  muted={track.muted === true}
                  volume={(track.volume ?? 1) * (overlayClip.volume ?? 1)}
                  canvasDisplayScale={canvasDisplayScale}
                />
                {isSelected && !locked && (
                  <>
                    {(['nw', 'ne', 'sw', 'se'] as HandlePos[]).map((pos) => (
                      <button
                        type="button"
                        key={pos}
                        className={`video-editor-overlay-handle ${pos}`}
                        aria-label={t('等比缩放')}
                        onPointerDown={(event) => startTransformInteraction(overlayClip, 'scale', event, pos)}
                      />
                    ))}
                    <span className="video-editor-rotation-stem" aria-hidden="true" />
                    <button
                      type="button"
                      className="video-editor-rotation-handle"
                      aria-label={t('旋转')}
                      onPointerDown={(event) => startTransformInteraction(overlayClip, 'rotate', event)}
                    >
                      <Icon icon="lucide:rotate-cw" width={11} height={11} />
                    </button>
                  </>
                )}
              </div>
            );
          })}

          {snapGuides.x && <span className="video-editor-snap-guide vertical" aria-hidden="true" />}
          {snapGuides.y && <span className="video-editor-snap-guide horizontal" aria-hidden="true" />}

          {activeAudio.map(({ clip: audioClip, track }) => (
            <AudioPreview
              key={`${track.id}:${audioClip.id}`}
              clip={audioClip}
              playhead={playhead}
              playing={playing}
              muted={track.muted === true}
              volume={(track.volume ?? 1) * (audioClip.volume ?? 1)}
            />
          ))}

          {/* 点击空白区域取消选中 */}
          <div
            className="video-editor-stage-passthrough"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) {
                onSelectClips([]);
              }
            }}
          />
        </div>
      </div>

      {stageInfo && (
        <div className="video-editor-stage-info">
          <span className="video-editor-canvas-size-label">{t('输出画布')}</span>
          <span>{stageInfo}</span>
          {activeOverlays.length > 0 && (
            <span className="dim">· {t('{count} 个叠加层', { count: activeOverlays.length })}</span>
          )}
          <span className="dim">· {previewZoom === 'fit' ? t('适应窗口') : `${previewZoom}%`}</span>
        </div>
      )}

      <div
        className="video-editor-progress-bar"
        onPointerDown={startScrub}
      >
        <div className="video-editor-progress-fill" style={{ width: `${progressPct}%` }} />
        <div className="video-editor-progress-thumb" style={{ left: `${progressPct}%` }} />
      </div>

      <div className="video-editor-transport">
        <div className="video-editor-transport-time">
          {editingTimecode ? (
            <input
              autoFocus
              className="video-editor-timecode-input"
              value={timecodeDraft}
              aria-label={t('当前时间码')}
              onChange={(event) => setTimecodeDraft(event.target.value)}
              onBlur={commitTimecode}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  setTimecodeDraft(formatTime(playhead));
                  setEditingTimecode(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="video-editor-timecode-edit"
              aria-label={t('编辑当前时间码')}
              onClick={() => {
                setTimecodeDraft(formatTime(playhead));
                setEditingTimecode(true);
              }}
            >
              {formatTime(playhead)}
            </button>
          )}
          <span className="video-editor-timecode-separator">/</span>
          <span className="video-editor-timecode-total">{formatTime(timelineDuration)}</span>
        </div>

        <div className="video-editor-transport-playback">
          <button type="button" className="video-editor-transport-btn" onClick={() => step(-1)} aria-label={t('上一帧')}>
            <Icon icon="lucide:chevron-first" width={16} height={16} />
          </button>
          <button
            type="button"
            className="video-editor-transport-btn primary"
            onClick={togglePlay}
            aria-label={playing ? t('暂停') : t('播放')}
            aria-keyshortcuts="Space"
            data-tooltip={playing ? t('暂停 Space') : t('播放 Space')}
          >
            <Icon icon={playing ? 'lucide:pause' : 'lucide:play'} width={16} height={16} />
          </button>
          <button type="button" className="video-editor-transport-btn" onClick={() => step(1)} aria-label={t('下一帧')}>
            <Icon icon="lucide:chevron-last" width={16} height={16} />
          </button>
          <span className="video-editor-shortcut-hint" aria-hidden="true">
            <kbd>Space</kbd>
          </span>
        </div>

        <div className="video-editor-transport-view">
          <label className="video-editor-preview-zoom">
            <Icon icon="lucide:search" width={13} height={13} />
            <Select fixedMenu
              value={previewZoom}
              aria-label={t('预览缩放')}
              onChange={(selectedOptionValue) => {
                const value = selectedOptionValue;
                setPreviewZoom(value === 'fit' ? 'fit' : Number(value) as PreviewZoom);
              }}
            >
              <option value="fit">{t('适应')}</option>
              <option value="25">25%</option>
              <option value="50">50%</option>
              <option value="100">100%</option>
            </Select>
          </label>
          <button
            type="button"
            className="video-editor-transport-btn"
            aria-label={fullscreen ? t('退出全屏') : t('全屏预览')}
            onClick={toggleFullscreen}
          >
            <Icon icon={fullscreen ? 'lucide:minimize-2' : 'lucide:maximize-2'} width={16} height={16} />
          </button>
          <details className="video-editor-shortcuts">
            <summary aria-label={t('查看快捷键')} data-tooltip={t('快捷键')}>
              <Icon icon="lucide:keyboard" width={16} height={16} />
            </summary>
            <div className="video-editor-shortcuts-popover">
              <strong>{t('快捷键')}</strong>
              <span><em>{t('播放 / 暂停')}</em><kbd>Space</kbd></span>
              <span><em>{t('后退 1 秒 / 暂停 / 播放')}</em><kbd>J K L</kbd></span>
              <span><em>{t('逐帧 / 跳转 1 秒')}</em><kbd>← → / Shift</kbd></span>
              <span><em>{t('分割 / 复制 / 删除')}</em><kbd>S / ⌘D / Del</kbd></span>
              <span><em>{t('撤销 / 重做')}</em><kbd>⌘Z / ⇧⌘Z</kbd></span>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}

export default memo(VideoEditorPreview);
