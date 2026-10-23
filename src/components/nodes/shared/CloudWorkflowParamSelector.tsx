import { Icon } from '@iconify/react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkflowDefinition } from '../../../types';
import { useT } from '../../../i18n';
import { getCloudWorkflowParameterSemantic } from '../../../services/cloudWorkflowParameterControls';
import { resolveRunningHubParameters, runningHubParameterKey } from '../../../services/runninghubWorkflowService';
import { calcAnchoredPosition } from '../../../utils/popupPosition';
import AnimatedButton from '../../shared/AnimatedButton';
import RunningHubParameterFields from './RunningHubParameterFields';
import WorkflowApiParameterFields from './WorkflowApiParameterFields';

interface CloudWorkflowParamSelectorProps {
  workflow: WorkflowDefinition;
  values?: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  disabled?: boolean;
  onContinuousEditEnd?: () => void;
}

/** 云参数沿用工作流键和值；只把编辑位置从提示词正文移到浮层。 */
export default function CloudWorkflowParamSelector({ workflow, values = {}, onChange, disabled, onContinuousEditEnd }: CloudWorkflowParamSelectorProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const manifest = workflow.workflowApi;
  const fields = workflow.adapterType === 'runninghub'
    ? resolveRunningHubParameters(workflow.runninghub?.parameters ?? []).filter((field) => field.source === 'value').map((field) => ({
      name: field.fieldName, label: field.label, value: values[runningHubParameterKey(field)] ?? String(field.defaultValue),
    }))
    : manifest?.version === 2 ? Object.entries(manifest.parameters).map(([name, field]) => ({
      name, label: field.label || name,
      value: values[`workflow::${name}`] ?? values[name] ?? String(field.default ?? ''),
    })) : [];
  const summary = fields.filter((field) => getCloudWorkflowParameterSemantic(field.name, field.label) !== 'other' && field.value !== '')
    .slice(0, 3).map((field) => getCloudWorkflowParameterSemantic(field.name, field.label) === 'duration'
      ? `${field.label} ${field.value}` : field.value).join(' · ');
  const triggerLabel = summary || t('参数 · {count} 项', { count: fields.length });
  const close = useCallback(() => {
    setOpen(false);
    onContinuousEditEnd?.();
  }, [onContinuousEditEnd, setOpen]);

  useEffect(() => {
    if (!open) return;
    const containsTarget = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      return triggerRef.current?.contains(target) || panelRef.current?.contains(target)
        || (target instanceof Element && Boolean(target.closest('[data-ui-select-portal]')));
    };
    const outside = (event: PointerEvent | FocusEvent) => {
      if (!containsTarget(event.target)) close();
    };
    const keydown = (event: KeyboardEvent) => {
      // 画布快捷键在 document 捕获；提前隔离浮层内的删除、数字键和撤销。
      // 不阻止默认动作或同层监听，输入与 Select 自身的键盘行为仍可使用。
      if (event.target instanceof Node && panelRef.current?.contains(event.target)
        && event.key !== 'F12' && !((event.ctrlKey || event.metaKey || event.altKey) && event.key.toLowerCase() === 's')) event.stopPropagation();
      // 下拉菜单先消费 Esc；第二次才关闭参数浮层。
      if (event.key !== 'Escape' || document.querySelector('[data-ui-select-portal]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    window.addEventListener('keydown', keydown, true);
    // 画布移动只改变锚点位置，不触发 DOM resize/scroll；Portal 应与宿主一起收起。
    const interactionObserver = new MutationObserver(() => {
      if (document.documentElement.classList.contains('canvas-interacting')) close();
    });
    interactionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      interactionObserver.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('keydown', keydown, true);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!open || !panel || !trigger) return;
    const position = () => {
      const rect = trigger.getBoundingClientRect();
      const available = Math.max(rect.top - 14, window.innerHeight - rect.bottom - 14, 0);
      panel.style.maxHeight = `${Math.min(560, available)}px`;
      let layer = 300;
      for (let parent: HTMLElement | null = trigger; parent; parent = parent.parentElement) {
        const current = Number.parseInt(window.getComputedStyle(parent).zIndex, 10);
        if (Number.isFinite(current)) layer = Math.max(layer, current + 1);
      }
      panel.style.zIndex = String(layer);
      const next = calcAnchoredPosition({ left: rect.right - panel.offsetWidth, top: rect.top, bottom: rect.bottom }, panel.offsetWidth, panel.offsetHeight, 6);
      panel.style.left = `${next.left}px`;
      panel.style.top = `${next.top}px`;
      panel.dataset.placement = next.placement;
    };
    position();
    panel.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    observer.observe(trigger);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open]);

  return <div className="ui-schema-renderer min-w-0" data-ui-schema-placement="cloudWorkflowParams">
    <AnimatedButton ref={triggerRef} type="button" className="img-pill-btn ui-schema-menu-trigger max-w-64"
      aria-label={t('云工作流参数')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      title={`${t('云工作流参数')} · ${triggerLabel}`}
      onClick={(event) => { event.stopPropagation(); if (open) close(); else setOpen(true); }}>
      <Icon icon="lucide:sliders-horizontal" width={14} className="shrink-0" />
      <span className="ui-schema-pill-label truncate">{triggerLabel}</span>
    </AnimatedButton>
    {open && createPortal(<div ref={panelRef} id={panelId} role="dialog" tabIndex={-1}
      aria-label={t('云工作流参数')} data-cloud-workflow-parameters=""
      className="img-ratio-popup ui-schema-popup cloud-workflow-params nodrag nowheel"
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onBlurCapture={() => onContinuousEditEnd?.()}>
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-canvas-border pb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-canvas-text">{t('云工作流参数')}</div>
          <div className="mt-1 truncate text-xs text-canvas-text-muted" title={workflow.name}>{workflow.name}</div>
        </div>
        <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost shrink-0" aria-label={t('关闭参数')}
          onClick={() => { close(); triggerRef.current?.focus({ preventScroll: true }); }}>
          <Icon icon="lucide:x" width={14} />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain pr-1">
        {workflow.adapterType === 'runninghub' ? <RunningHubParameterFields appearance="popover"
          parameters={workflow.runninghub?.parameters ?? []} values={values} onChange={onChange} disabled={disabled} />
          : manifest?.version === 2 ? <WorkflowApiParameterFields appearance="popover" manifest={manifest}
            values={values} onChange={onChange} disabled={disabled} /> : null}
        {fields.length === 0 && <p className="text-xs text-canvas-text-muted">{t('此工作流没有额外可调参数')}</p>}
      </div>
    </div>, document.body)}
  </div>;
}
