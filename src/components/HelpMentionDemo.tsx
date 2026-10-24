/**
 * 帮助中心里的「@ 工作流节点」动画演示。
 * 下拉用真实的 MentionPicker，芯片用真实的 buildWorkflowChipEl，
 * 保证演示里的样式和用户在提示词框里看到的完全一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import MentionPicker from './shared/MentionPicker';
import { buildWorkflowChipEl } from './nodes/shared/mentionEditorDom';
import { useT } from '../i18n';

const DEMO_VALUE = '夜色中的机械猫，霓虹反光';
const DEMO_TABS = [{ id: 'nodes', label: '工作流节点' }];
const STEP_HINTS = [
  '在提示词框里输入 @，列出当前工作流的输入节点。',
  '选中要写入的输入节点（这里是正向提示词节点 #6）。',
  '提示词写进 @ 出来的节点里，调用时才会送到 ComfyUI 对应输入。',
] as const;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export default function HelpMentionDemo() {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const chipHostRef = useRef<HTMLSpanElement>(null);
  const [playbackKey, setPlaybackKey] = useState(0);
  // 减少动效偏好：直接停在最终状态，首帧就被 reducer 兜底，
  // 避免 effect 内再 setState 触发 react-hooks/set-state-in-effect
  const [activeKey, setActiveKey] = useState<string | undefined>(() =>
    prefersReducedMotion() ? 'wf:6' : undefined,
  );
  const [step, setStep] = useState<number>(() =>
    prefersReducedMotion() ? STEP_HINTS.length - 1 : 0,
  );

  const replay = useCallback(() => setPlaybackKey((key) => key + 1), []);

  // 真实芯片 DOM：挂一次，之后只由时间线控制显隐
  useEffect(() => {
    const host = chipHostRef.current;
    if (!host) return;
    const chip = buildWorkflowChipEl('6', '正向提示词', 'prompt');
    const value = chip.querySelector<HTMLElement>('.prompt-chip-wf-value');
    if (value) {
      value.contentEditable = 'false';
      value.textContent = DEMO_VALUE;
    }
    host.replaceChildren(chip);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const query = root.querySelector<HTMLElement>('[data-demo-query]');
    const picker = root.querySelector<HTMLElement>('[data-demo-picker]');
    const chip = chipHostRef.current;
    const caret = root.querySelector<HTMLElement>('[data-demo-caret]');
    const result = root.querySelector<HTMLElement>('[data-demo-result]');
    if (!query || !picker || !chip || !caret || !result) return;

    // 减少动效：直接停在最终状态，不播时间线（DOM 用 ref 直接操作，状态已由 lazy initializer 设置）
    if (prefersReducedMotion()) {
      query.style.display = 'none';
      picker.style.opacity = '0';
      result.style.opacity = '1';
      return;
    }

    let cancelled = false;
    let context: { revert: () => void } | undefined;

    void import('gsap').then(({ gsap }) => {
      if (cancelled || !rootRef.current) return;

      context = gsap.context(() => {
        const timeline = gsap.timeline();
        gsap.set(caret, { opacity: 1 });
        gsap.to(caret, { opacity: 0.15, duration: 0.5, repeat: -1, yoyo: true, ease: 'steps(1)' });

        timeline
          .set(query, { display: 'inline', clipPath: 'inset(0 100% 0 0)' })
          .set(chip, { display: 'none' })
          .set(picker, { opacity: 0, y: 8, scale: 0.98, transformOrigin: 'top center' })
          .set(result, { opacity: 0, y: 8 })
          .call(() => { setStep(0); setActiveKey(undefined); })
          .to(query, { clipPath: 'inset(0 0% 0 0)', duration: 0.45, ease: 'steps(4)' })
          .to(picker, { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'power3.out' })
          .call(() => { setStep(1); setActiveKey('wf:6'); })
          .to({}, { duration: 0.7 })
          .to(picker, { opacity: 0, y: 6, scale: 0.98, duration: 0.22, ease: 'power2.in' })
          .set(query, { display: 'none' })
          .set(chip, { display: 'inline' })
          .fromTo(
            chip,
            { opacity: 0, scale: 0.86 },
            { opacity: 1, scale: 1, duration: 0.32, ease: 'back.out(2)' },
          )
          .call(() => setStep(2))
          .to(result, { opacity: 1, y: 0, duration: 0.3, ease: 'power3.out' }, '<0.05');
      }, root);
    });

    return () => {
      cancelled = true;
      context?.revert();
    };
  }, [playbackKey]);

  return (
    <section
      ref={rootRef}
      aria-label={t('@ 工作流节点操作演示')}
      className="help-dialog__demo relative mt-4 overflow-hidden rounded-lg border border-canvas-border bg-canvas-bg/60 px-3 py-3"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(var(--separator-color)_1px,transparent_1px)] [background-size:12px_12px]"
        aria-hidden="true"
      />
      <div className="relative mb-3 flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-canvas-text-secondary">{t('@ 节点演示')}</span>
        <button
          type="button"
          aria-label={t('重新播放 @ 节点演示')}
          data-tooltip={t('重新播放')}
          onClick={replay}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-canvas-text-muted transition-colors hover:bg-canvas-hover hover:text-canvas-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/50"
        >
          <Icon icon="lucide:rotate-ccw" width="14" height="14" aria-hidden="true" />
        </button>
      </div>

      <div className="relative flex flex-col gap-2 pt-[168px]">
        {/* 真实的 @ 选中器 —— 和收起后的结果说明共用这块预留区域 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[160px] justify-center">
          <div data-demo-picker className="pointer-events-auto w-full max-w-[280px] self-end">
            <MentionPicker
              ariaLabel={t('工作流输入节点')}
              tabs={DEMO_TABS.map((tab) => ({ ...tab, label: t(tab.label) }))}
              activeTab="nodes"
              onTabChange={() => {}}
              activeKey={activeKey}
              items={[
                {
                  key: 'wf:6',
                  label: '正向提示词',
                  icon: 'mdi:text-box-outline',
                  badge: t('工作流'),
                  onSelect: replay,
                },
                {
                  key: 'wf:12',
                  label: '参考图输入',
                  icon: 'mdi:image-outline',
                  badge: t('工作流'),
                  onSelect: replay,
                },
              ]}
            />
          </div>
          <div
            data-demo-result
            className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-4 text-center"
          >
            <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
              <Icon icon="lucide:check-circle-2" width="15" height="15" aria-hidden="true" />
              {t('提示词已写入 #{id} {name}节点', { id: 6, name: '正向提示词' })}
            </span>
            <span className="text-[11px] leading-5 text-canvas-text-secondary">
              {t('在“工作流管理”里点节点徽章把它设为 ★ 默认节点，下次不 @ 也会自动注入。')}
            </span>
          </div>
        </div>

        {/* 提示词输入框（仿真外观，内容是真实芯片 DOM） */}
        <div className="min-h-11 rounded-xl border border-canvas-border bg-canvas-card px-3 py-2 text-[13px] leading-6 text-canvas-text">
          <span data-demo-query className="text-canvas-text-secondary">@正向</span>
          <span data-demo-chip ref={chipHostRef} />
          <span
            data-demo-caret
            aria-hidden="true"
            className="ml-px inline-block h-3.5 w-px translate-y-0.5 bg-indigo-400"
          />
        </div>
      </div>

      <p className="relative mt-3 text-pretty text-[11px] leading-5 text-canvas-text-secondary">
        {t(STEP_HINTS[step])}
      </p>
    </section>
  );
}
