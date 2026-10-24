/**
 * ProjectSwitchOverlay — 切换画布时的遮罩，用项目 Logo（渐变 Sparkle）做加载动画。
 * 延迟 180ms 才淡入：切换够快时不会闪一下。
 */
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useAppStore } from '../store/useAppStore';
import { useT } from '../i18n';

function LogoSpinner({ still }: { still: boolean }) {
  return (
    <svg viewBox="0 0 1024 1024" className="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id="project-switch-logo" x1="200" y1="200" x2="824" y2="824" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4196FF" />
          <stop offset="50%" stopColor="#A259FF" />
          <stop offset="100%" stopColor="#FF5D70" />
        </linearGradient>
      </defs>
      <path
        d="M512,4 C898,4 1020,122 1020,512 C1020,902 898,1020 512,1020 C126,1020 4,902 4,512 C4,122 126,4 512,4Z"
        fill="none"
        stroke="var(--theme-text)"
        strokeOpacity="0.16"
        strokeWidth="8"
      />
      <g transform="translate(512, 512) scale(1.3)">
        <motion.path
          d="M0,-260 C15,-120 120,-15 260,0 C120,15 15,120 0,260 C-15,120 -120,15 -260,0 C-120,-15 -15,-120 0,-260Z"
          fill="url(#project-switch-logo)"
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          animate={still ? undefined : { rotate: 360, scale: [1, 0.88, 1] }}
          transition={{
            rotate: { duration: 2.4, repeat: Infinity, ease: 'linear' },
            scale: { duration: 1.2, repeat: Infinity, ease: 'easeInOut' },
          }}
        />
        <circle r="45" fill="var(--theme-bg)" />
      </g>
    </svg>
  );
}

export default function ProjectSwitchOverlay() {
  const t = useT();
  const switchingProjectName = useAppStore((state) => state.switchingProjectName);
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence>
      {switchingProjectName !== null && (
        <motion.div
          key="project-switch-overlay"
          className="absolute inset-0 z-[400] flex flex-col items-center justify-center gap-6"
          style={{ background: 'color-mix(in srgb, var(--theme-bg) 72%, transparent)', backdropFilter: 'blur(8px)' }}
          role="status"
          aria-live="polite"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.16 } }}
          transition={{ duration: 0.2, delay: 0.18 }}
        >
          <motion.div
            className="relative h-20 w-20"
            animate={reduceMotion ? undefined : { opacity: [0.75, 1, 0.75] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
          >
            <LogoSpinner still={Boolean(reduceMotion)} />
          </motion.div>
          <p className="text-sm tracking-wide" style={{ color: 'var(--theme-text-secondary)' }}>
            {switchingProjectName ? t('正在打开「{name}」', { name: switchingProjectName }) : t('正在打开画布')}
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
