/** 连点五次的隐藏片场；只持有短暂表演状态，不写入画布或持久化。 */
import { useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import type { MascotHandle } from './Mascot';
import { useT } from '../../../i18n';

interface HiddenFilmSetProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  available: boolean;
  reduceMotion: boolean;
  mascotHandleRef: RefObject<MascotHandle | null>;
  consumeDragClick: (event: MouseEvent<HTMLButtonElement>) => boolean;
  'data-tooltip'?: string;
}

const LINES = [
  '你负责想象，我负责喊开机。',
  '这个镜头预算为零，想象力不限。',
  '灯光就位，灵感可以入场了。',
  '今天的主角，是你的奇思妙想。',
  '好故事，值得再来一条。',
  '别紧张，宇宙也在即兴发挥。',
] as const;
const CLICK_GAP = 450;
const SHOW_DURATION = 6800;
const EASE = [0.23, 1, 0.32, 1] as const;

interface Take {
  number: number;
  line: string;
  left: number;
  top: number;
  width: number;
  boardPlacement: 'below' | 'left' | 'right';
}

export default function HiddenFilmSet({
  available, reduceMotion, mascotHandleRef, consumeDragClick, children, onClick, onDoubleClick, ...buttonProps
}: HiddenFilmSetProps) {
  const t = useT();
  const stageRef = useRef<HTMLDivElement>(null);
  const streakRef = useRef({ count: 0, lastAt: 0 });
  const takeCountRef = useRef(0);
  const previousLineRef = useRef(-1);
  const dismissClickRef = useRef(false);
  const clickTimerRef = useRef<number | null>(null);
  const [take, setTake] = useState<Take | null>(null);
  const id = useId().replace(/:/g, '');
  const showing = Boolean(take) && available;

  const clearClickTimer = useCallback(() => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = null;
  }, []);
  const cancelClickSequence = useCallback(() => {
    clearClickTimer();
    streakRef.current = { count: 0, lastAt: 0 };
  }, [clearClickTimer]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) cancelClickSequence(); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') cancelClickSequence(); };
    window.addEventListener('blur', cancelClickSequence);
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelClickSequence();
      window.removeEventListener('blur', cancelClickSequence);
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [cancelClickSequence]);

  useEffect(() => {
    if (buttonProps.disabled) cancelClickSequence();
  }, [buttonProps.disabled, cancelClickSequence]);

  useEffect(() => {
    // 下载、更新或生成接管吉祥物时，废弃当前表演。
    if (!available) {
      const frame = requestAnimationFrame(() => setTake(null));
      return () => cancelAnimationFrame(frame);
    }
  }, [available]);

  useEffect(() => {
    if (!showing) return;
    const mascot = mascotHandleRef.current;
    mascot?.setDirectorHat(true);
    const finish = () => setTake(null);
    const timeout = window.setTimeout(finish, SHOW_DURATION);
    const clap = window.setTimeout(() => {
      if (!reduceMotion) mascotHandleRef.current?.playClip('excited');
    }, 900);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish();
    };
    const onVisibility = () => { if (document.hidden) finish(); };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', finish);
    window.addEventListener('resize', finish);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mascot?.setDirectorHat(false);
      window.clearTimeout(timeout);
      window.clearTimeout(clap);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', finish);
      window.removeEventListener('resize', finish);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [showing, reduceMotion, mascotHandleRef]);

  return (
    <div ref={stageRef} className="relative h-full w-full">
      <button
        {...buttonProps}
        onClick={(event) => {
          // 拖动后的 click 先交给既有过滤器，不计入连击。
          if (consumeDragClick(event)) {
            cancelClickSequence();
            dismissClickRef.current = false;
            return;
          }
          if (dismissClickRef.current) {
            cancelClickSequence();
            dismissClickRef.current = false;
            return;
          }
          if (showing) {
            // 第六击及后续点击不关闭刚开始的彩蛋，也不打开助手。
            streakRef.current.lastAt = performance.now();
            return;
          }
          clearClickTimer();
          // 键盘激活没有鼠标连击语义，立即按当前显示偏好打开。
          if (event.detail === 0) {
            cancelClickSequence();
            onClick?.(event);
            return;
          }
          const now = performance.now();
          const streak = streakRef.current;
          if (now - streak.lastAt >= CLICK_GAP) streak.count = 0;
          streak.lastAt = now;
          streak.count += 1;
          // 整段点击结束后再分派，双击和五击都不能先执行单击。
          clickTimerRef.current = window.setTimeout(() => {
            const count = streakRef.current.count;
            cancelClickSequence();
            if (count === 1) onClick?.(event);
            else if (count === 2) onDoubleClick?.(event);
          }, CLICK_GAP);
          if (streak.count !== 5 || !available) return;
          const rect = stageRef.current?.getBoundingClientRect();
          if (!rect) return;
          const width = Math.min(268, window.innerWidth - 24);
          const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
          const above = rect.top - 150;
          const top = Math.max(12, Math.min(above >= 12 ? above : rect.bottom + 16, window.innerHeight - 148));
          // 每次随机抽取，但相邻两场不重复。
          const lineIndex = previousLineRef.current < 0
            ? Math.floor(Math.random() * LINES.length)
            : (previousLineRef.current + 1 + Math.floor(Math.random() * (LINES.length - 1))) % LINES.length;
          previousLineRef.current = lineIndex;
          takeCountRef.current += 1;
          const boardPlacement = rect.bottom + 16 <= window.innerHeight - 8
            ? 'below' : rect.left >= 60 ? 'left' : 'right';
          setTake({ number: takeCountRef.current, line: LINES[lineIndex], left, top, width, boardPlacement });
        }}
        onPointerDown={(event) => {
          buttonProps.onPointerDown?.(event);
          clearClickTimer();
          // 连续多点保持表演；间隔后的新手势收场，拖动不会留下台词卡。
          const continuing = performance.now() - streakRef.current.lastAt < CLICK_GAP;
          dismissClickRef.current = showing && !continuing;
          if (dismissClickRef.current) {
            cancelClickSequence();
            setTake(null);
          }
        }}
        onPointerCancel={(event) => {
          buttonProps.onPointerCancel?.(event);
          cancelClickSequence();
          dismissClickRef.current = false;
        }}
        data-tooltip={showing ? undefined : buttonProps['data-tooltip']}
      >
        {children}
      </button>

      <AnimatePresence>
        {showing && (
          <motion.div
            key={take!.number}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 select-none"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className={`absolute h-[58px] w-[70px] ${take!.boardPlacement === 'below'
                ? '-bottom-4 right-0' : take!.boardPlacement === 'left' ? '-left-12 top-7' : '-right-12 top-7'}`}
              initial={reduceMotion ? false : { x: 14, y: 12, rotate: 8, opacity: 0 }}
              animate={{ x: 0, y: 0, rotate: -8, opacity: 1 }}
              transition={{ delay: reduceMotion ? 0 : 0.35, duration: reduceMotion ? 0 : 0.35, ease: EASE }}
            >
              <svg viewBox="0 0 100 84" className="h-full w-full overflow-visible">
                <defs>
                  <pattern id={`${id}-stripes`} width="24" height="16" patternUnits="userSpaceOnUse" patternTransform="skewX(-25)">
                    <rect width="24" height="16" fill="var(--theme-bg)" />
                    <rect width="12" height="16" fill="var(--theme-text)" />
                  </pattern>
                </defs>
                <rect x="6" y="30" width="88" height="49" rx="5" fill="var(--theme-surface)" stroke="var(--theme-text-muted)" strokeWidth="1.5" />
                <rect x="6" y="29" width="88" height="12" fill={`url(#${id}-stripes)`} />
                <motion.g
                  className="origin-[8px_29px]"
                  initial={reduceMotion ? false : { rotate: -28 }}
                  animate={{ rotate: reduceMotion ? 0 : [-28, -28, 0, -3, 0] }}
                  transition={{ delay: 0.5, duration: reduceMotion ? 0 : 0.6, times: [0, 0.55, 0.7, 0.85, 1], ease: EASE }}
                >
                  <rect x="6" y="15" width="88" height="12" rx="2" fill={`url(#${id}-stripes)`} stroke="var(--theme-text-muted)" />
                </motion.g>
                <circle cx="11" cy="30" r="3.5" fill="var(--accent-amber)" stroke="var(--theme-surface)" />
                {!reduceMotion && (
                  <motion.path
                    d="M97 19l6-3M97 25l8 1M93 13l2-6"
                    fill="none" stroke="var(--accent-amber-text)" strokeWidth="1.5" strokeLinecap="round"
                    initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 0] }}
                    transition={{ delay: 0.9, duration: 0.3, times: [0, 0.15, 1] }}
                  />
                )}
                <text x="14" y="53" fontSize="7" letterSpacing="1.2" fill="var(--theme-text-muted)">AI CANVAS</text>
                <path d="M13 59h74M56 59v16" stroke="var(--theme-border)" />
                <text x="14" y="71" fontSize="7" fill="var(--theme-text-secondary)">SCENE 01</text>
                <text x="62" y="71" fontSize="7" fill="var(--accent-amber-text)">TAKE {String(take!.number).padStart(2, '0')}</text>
              </svg>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {createPortal(
        <AnimatePresence>
          {showing && (
            <motion.div
              key={take!.number}
              role="status"
              className="pointer-events-none fixed z-[60] select-none"
              style={{ left: take!.left, top: take!.top, width: take!.width }}
              initial={{ opacity: 0, y: reduceMotion ? 0 : 8, scale: reduceMotion ? 1 : 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : 4, scale: reduceMotion ? 1 : 0.98, transition: { duration: 0.18, delay: 0 } }}
              transition={{ duration: 0.22, delay: reduceMotion ? 0 : 1.05, ease: EASE }}
            >
              <div className="ui-card overflow-hidden shadow-xl">
                <div className="flex items-center justify-between border-b border-canvas-border bg-[var(--accent-amber-bg)] px-3 py-2">
                  <span className="flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] text-[var(--accent-amber-text)]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-amber)]" />
                    {t('幕后小剧场')}
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-canvas-text-muted">TAKE {String(take!.number).padStart(2, '0')}</span>
                </div>
                <div className="p-3">
                  <p className="mb-1 text-sm font-semibold text-canvas-text">{t('第 {number} 场 · 灵感，开机。', { number: take!.number })}</p>
                  <p className="text-xs leading-relaxed text-canvas-text-secondary">{t(take!.line)}</p>
                  <div className="mt-3 flex items-center justify-between text-[10px] text-canvas-text-muted">
                    <span>{t('献给每一个认真做梦的人')}</span>
                    <span className="font-mono">{t('ESC 收场')}</span>
                  </div>
                </div>
                <motion.div
                  aria-hidden="true"
                  className="h-0.5 origin-left bg-[var(--accent-amber-border)]"
                  initial={{ scaleX: 1 }} animate={{ scaleX: reduceMotion ? 1 : 0 }}
                  transition={{ delay: 1.05, duration: (SHOW_DURATION / 1000) - 1.05, ease: 'linear' }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
