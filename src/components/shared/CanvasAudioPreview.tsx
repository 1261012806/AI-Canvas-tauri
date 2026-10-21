import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Music2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useAudioSpectrum } from '../../hooks/useAudioSpectrum';
import { useT } from '../../i18n';

function formatTime(value: number) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Mounted only inside the full-screen overlay; browsing never changes canvas selection/history. */
export default function CanvasAudioPreview({ nodeId, openingProjectId, initialTime = 0, initiallyPlaying = false, onClose }: {
  nodeId: string;
  openingProjectId: string | null;
  initialTime?: number;
  initiallyPlaying?: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const nodes = useAppStore((state) => state.nodes);
  const projectId = useAppStore((state) => state.currentProjectId);
  const tracks = useMemo(() => nodes.filter((node) =>
    (node.type === 'ai-audio' || node.type === 'source-audio')
    && !node.data.hiddenByCharacterLibrary && !!node.data.audioUrl)
    .sort((a, b) => (a.data.displayId ?? Number.MAX_SAFE_INTEGER) - (b.data.displayId ?? Number.MAX_SAFE_INTEGER)), [nodes]);
  const [session, setSession] = useState(() => ({
    id: nodeId, url: tracks.find((node) => node.id === nodeId)?.data.audioUrl,
    time: initialTime, autoPlay: initiallyPlaying, analysis: true,
  }));
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const index = tracks.findIndex((node) => node.id === session.id);
  const active = tracks[index];
  const valid = projectId === openingProjectId && !!active && active.data.audioUrl === session.url;

  useEffect(() => { if (!valid) onClose(); }, [valid, onClose]);
  const navigate = useCallback((direction: -1 | 1, playing: boolean) => {
    const target = tracks[index + direction];
    if (!valid || !target) return;
    setSession({ id: target.id, url: target.data.audioUrl, time: 0, autoPlay: playing, analysis: true });
  }, [tracks, index, valid]);
  const fallback = useCallback((time: number, playing: boolean) => {
    // A fresh media element is required: Web Audio cannot detach a MediaElementSource.
    setSession((previous) => ({ ...previous, time, autoPlay: playing, analysis: false }));
  }, []);

  if (!valid || !active || !session.url) return null;
  return (
    <div
      data-tauri-drag-region
      role="dialog" aria-modal="true" aria-label={t('音频播放器')}
      className="nodrag nopan nowheel flex h-full w-full flex-col overflow-y-auto bg-canvas-bg px-5 py-14 text-canvas-text sm:px-12"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div data-tauri-drag-region className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center gap-6">
        <header className="min-w-0">
          <div className="mb-3 flex items-center gap-2 text-sm text-canvas-text-muted"><Music2 size={18} />{t('音乐播放器')} · {index + 1} / {tracks.length}</div>
          <h2 className="break-words text-xl font-semibold sm:text-3xl" aria-live="polite">
            {active.data.displayId != null ? `#${active.data.displayId} · ` : ''}{active.data.label || active.data.fileName || t('音频')}
          </h2>
        </header>
        <AudioTrackPlayer
          key={`${session.id}:${session.url}:${session.analysis}`}
          src={session.url} initialTime={session.time} autoPlay={session.autoPlay} analysis={session.analysis}
          volume={volume} muted={muted} onVolume={setVolume} onMuted={setMuted}
          hasPrevious={index > 0} hasNext={index < tracks.length - 1}
          onNavigate={navigate} onAnalysisUnavailable={fallback}
        />
      </div>
    </div>
  );
}

export function AudioTrackPlayer({ src, initialTime, autoPlay, analysis, volume, muted, onVolume, onMuted, hasPrevious, hasNext, onNavigate, onAnalysisUnavailable }: {
  src: string; initialTime: number; autoPlay: boolean; analysis: boolean;
  volume: number; muted: boolean; onVolume: (value: number) => void; onMuted: (value: boolean) => void;
  hasPrevious: boolean; hasNext: boolean;
  onNavigate: (direction: -1 | 1, playing: boolean) => void;
  onAnalysisUnavailable: (time: number, playing: boolean) => void;
}) {
  const t = useT();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playButtonRef = useRef<HTMLButtonElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const scrubPointerRef = useRef<{ pointerId: number; value: number } | null>(null);
  const finishScrub = useCallback(() => {
    scrubPointerRef.current = null;
    progressRef.current?.classList.remove('is-scrubbing', 'is-scrubbing-forward', 'is-scrubbing-backward');
  }, []);
  const lifetime = useRef(0);
  const initialApplied = useRef(false);
  const playIntent = useRef(autoPlay);
  const pendingPlay = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(initialTime);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [error, setError] = useState('');
  const prepare = useAudioSpectrum(audioRef, canvasRef, analysis);
  const played = duration ? Math.min(100, Math.max(0, time / duration * 100)) : 0;
  const buffered = duration ? Math.min(100, Math.max(time, bufferedEnd) / duration * 100) : 0;

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || pendingPlay.current) return;
    const version = lifetime.current;
    pendingPlay.current = true;
    playIntent.current = true;
    setError('');
    const ready = await prepare();
    if (version !== lifetime.current) return;
    if (!ready) {
      onAnalysisUnavailable(audio.currentTime, true);
      return;
    }
    try {
      if (playIntent.current) await audio.play();
    } catch {
      if (version === lifetime.current) {
        playIntent.current = false;
        setError(t('播放失败，请检查音频来源后重试'));
      }
    } finally {
      if (version === lifetime.current) pendingPlay.current = false;
    }
  }, [prepare, onAnalysisUnavailable, t]);
  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused || pendingPlay.current) {
      playIntent.current = false;
      audio.pause();
    } else void play();
  }, [play]);

  useEffect(() => {
    const audio = audioRef.current;
    const previousFocus = document.activeElement;
    if (audio && audio.getAttribute('src') !== src) audio.src = src;
    playButtonRef.current?.focus();
    const hide = () => {
      if (document.hidden && audio) { playIntent.current = false; audio.pause(); }
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      lifetime.current += 1;
      document.removeEventListener('visibilitychange', hide);
      audio?.pause();
      audio?.removeAttribute('src');
      audio?.load();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [src]);
  useEffect(() => {
    if (audioRef.current) { audioRef.current.volume = volume; audioRef.current.muted = muted; }
  }, [volume, muted]);
  useEffect(() => () => finishScrub(), [finishScrub]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (document.querySelector('.reference-content-preview') && !audioRef.current?.closest('.reference-content-preview')) return;
      // 关闭交给宿主焦点栈，允许资源预览和画布预览复用同一播放器。
      if (event.key === 'Escape') return;
      // Consume canvas shortcuts at window capture, but preserve native slider/button defaults.
      event.stopImmediatePropagation();
      const target = event.target;
      if (event.key === 'Tab') {
        const dialog = audioRef.current?.closest('[role="dialog"]');
        const overlay = dialog?.closest('.fullscreen-overlay') ?? dialog;
        const controls = overlay?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
        if (controls?.length) {
          const first = controls[0]; const last = controls[controls.length - 1];
          if (event.shiftKey && (target === first || !overlay?.contains(target as Node))) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && target === last) { event.preventDefault(); first.focus(); }
        }
        return;
      }
      if (target instanceof HTMLInputElement || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const direction = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1
        : event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : null;
      if (direction !== null) {
        event.preventDefault();
        onNavigate(direction, !audioRef.current?.paused || pendingPlay.current);
      } else if (event.code === 'Space' && !(target instanceof HTMLButtonElement)) {
        event.preventDefault(); toggle();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [onNavigate, toggle]);

  const updateDuration = () => {
    const value = audioRef.current?.duration ?? 0;
    setDuration(Number.isFinite(value) && value > 0 ? value : 0);
  };
  const updateBuffer = () => {
    const audio = audioRef.current;
    if (!audio) return;
    let end = audio.currentTime;
    for (let index = 0; index < audio.buffered.length; index += 1) {
      if (audio.buffered.start(index) <= audio.currentTime && audio.buffered.end(index) >= audio.currentTime) end = audio.buffered.end(index);
    }
    setBufferedEnd(end);
  };
  return (
    <>
      <div className="rounded-2xl border border-canvas-border bg-canvas-surface p-4 sm:p-6">
        <div className="mb-3 flex justify-between text-xs text-canvas-text-muted"><span>{t('实时频谱')}</span><span>20 Hz – 20 kHz · dB</span></div>
        {analysis ? (
          <canvas ref={canvasRef} className="h-[min(42vh,380px)] min-h-40 w-full" aria-label={t('实时音频频谱曲线')} />
        ) : (
          <div className="flex h-[min(42vh,380px)] min-h-40 items-center justify-center text-sm text-canvas-text-muted" role="status">
            {t('此音频暂不支持频谱分析，仍可正常播放')}
          </div>
        )}
        {analysis && !playing && <p className="mt-2 text-xs text-canvas-text-muted">{t('播放后显示实时频率曲线')}</p>}
      </div>
      <audio
        ref={audioRef} src={src} crossOrigin={analysis ? 'anonymous' : undefined} preload="metadata"
        onLoadedMetadata={() => {
          updateDuration();
          const audio = audioRef.current;
          if (!audio || initialApplied.current) return;
          initialApplied.current = true;
          if (initialTime > 0 && Number.isFinite(audio.duration)) audio.currentTime = Math.min(initialTime, audio.duration);
          setTime(audio.currentTime);
          if (autoPlay) void play();
        }}
        onDurationChange={updateDuration}
        onTimeUpdate={() => { setTime(audioRef.current?.currentTime ?? 0); updateBuffer(); }}
        onProgress={updateBuffer}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); if (hasNext) onNavigate(1, true); }}
        onError={() => {
          if (analysis) onAnalysisUnavailable(audioRef.current?.currentTime || initialTime, playIntent.current);
          else { setPlaying(false); setError(t('音频加载失败，请检查文件或链接')); }
        }}
      />
      <div className="ui-video-player__controls p-3">
        <div ref={progressRef} className="ui-video-player__progress" style={{ '--video-played': `${played}%`, '--video-buffered': `${buffered}%` } as CSSProperties}>
          <div className="ui-video-player__progress-track" aria-hidden="true"><span className="ui-video-player__progress-empty" /><span className="ui-video-player__progress-buffer" /><span className="ui-video-player__progress-played" /></div>
          {duration > 0 && <span className="ui-video-player__progress-marker" aria-hidden="true" />}
          <input
            type="range" data-native-range className="ui-video-player__range-hit" aria-label={t('播放进度')}
            min={0} max={duration || 1} step={0.01} value={Math.min(time, duration || 0)} disabled={!duration}
            aria-valuetext={`${formatTime(time)} / ${formatTime(duration)}`}
            onPointerDown={(event) => {
              if (event.button !== 0 || event.currentTarget.disabled || scrubPointerRef.current) return;
              scrubPointerRef.current = { pointerId: event.pointerId, value: Number(event.currentTarget.value) };
              progressRef.current?.classList.add('is-scrubbing');
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerUp={(event) => { if (scrubPointerRef.current?.pointerId === event.pointerId) finishScrub(); }}
            onPointerCancel={finishScrub} onLostPointerCapture={finishScrub} onBlur={finishScrub}
            onChange={(event) => {
              const value = Math.min(duration, Math.max(0, Number(event.target.value)));
              const scrub = scrubPointerRef.current;
              if (scrub && value !== scrub.value) {
                progressRef.current?.classList.toggle('is-scrubbing-forward', value > scrub.value);
                progressRef.current?.classList.toggle('is-scrubbing-backward', value < scrub.value);
                scrub.value = value;
              }
              if (audioRef.current && duration) { audioRef.current.currentTime = value; setTime(value); }
            }}
          />
        </div>
        <div className="ui-video-player__control-row">
          <div className="ui-video-player__control-left">
            <button type="button" className="ui-btn ui-btn--ghost ui-video-player__control" aria-label={t('上一曲')} title={`${t('上一曲')} (↑ / ←)`} disabled={!hasPrevious} onClick={() => onNavigate(-1, playing)}><SkipBack size={20} /></button>
            <button type="button" ref={playButtonRef} className="ui-btn ui-btn--ghost ui-video-player__control" aria-label={t(playing ? '暂停' : '播放')} title={t(playing ? '暂停' : '播放')} onClick={toggle}>{playing ? <Pause className="ui-video-player__play-icon" /> : <Play className="ui-video-player__play-icon" />}</button>
            <button type="button" className="ui-btn ui-btn--ghost ui-video-player__control" aria-label={t('下一曲')} title={`${t('下一曲')} (↓ / →)`} disabled={!hasNext} onClick={() => onNavigate(1, playing)}><SkipForward size={20} /></button>
          </div>
          <div className="ui-video-player__time-format">
            <time className="text-sm font-medium tabular-nums text-canvas-text">{formatTime(time)} / {formatTime(duration)}</time>
          </div>
          <div className="flex justify-end">
            <div className="ui-video-player__volume">
              <button type="button" className="ui-btn ui-btn--ghost ui-video-player__control" aria-label={t(muted ? '取消静音' : '静音')} onClick={() => onMuted(!muted)}>{muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}</button>
              <input type="range" className="ui-slider ui-video-player__volume-track" aria-label={t('音量')} min={0} max={1} step={0.01} value={muted ? 0 : volume}
                style={{ '--range-progress': `${muted ? 0 : volume * 100}%` } as CSSProperties}
                onChange={(event) => { onVolume(Number(event.target.value)); onMuted(false); }} />
            </div>
          </div>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-canvas-text-secondary">{error}</p>}
      <p className="text-xs text-canvas-text-muted">{t('按节点序号播放 · 方向键切歌 · Esc 关闭')}</p>
    </>
  );
}
