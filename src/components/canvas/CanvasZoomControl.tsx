import { memo } from 'react';
import { useStore, type ReactFlowState } from '@xyflow/react';
import { LockKeyhole, Minus, Plus, Scan, UnlockKeyhole } from 'lucide-react';
import type { CanvasViewportMode } from '../../types';
import { CANVAS_ZOOM_PRESETS, MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM } from '../../utils/canvasViewportPreferences';
import { useT } from '../../i18n';
import Select from '../shared/Select';

export interface CanvasZoomControlProps {
  mode: CanvasViewportMode;
  disabled: boolean;
  onAutoFit: () => void;
  onZoomChange: (zoom: number) => void;
  onStepZoom: (direction: number) => void;
  onToggleLock: () => void;
}

const selectZoomPercent = (state: ReactFlowState) => Math.round(state.transform[2] * 100);

function CanvasZoomControl({ mode, disabled, onAutoFit, onZoomChange, onStepZoom, onToggleLock }: CanvasZoomControlProps) {
  const t = useT();
  const percent = useStore(selectZoomPercent);
  const locked = mode === 'locked';
  const presets = CANVAS_ZOOM_PRESETS.includes(percent)
    ? CANVAS_ZOOM_PRESETS : [...CANVAS_ZOOM_PRESETS, percent].sort((a, b) => a - b);
  const lockLabel = locked ? t('解锁画布缩放') : t('锁定当前缩放比例');

  return <>
    <button type="button" className={`ui-btn ui-btn--sm ui-btn--ghost ${mode === 'auto' ? 'is-active' : ''}`}
      aria-label={t('自动适配画布')} aria-pressed={mode === 'auto'} disabled={disabled || locked}
      onClick={onAutoFit} data-tooltip={t('自动适配窗口；手动移动或缩放后退出（F）')}>
      <Scan size={14} aria-hidden="true" />
    </button>
    <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost"
      aria-label={t('缩小画布')} disabled={disabled || locked || percent <= MIN_CANVAS_ZOOM * 100}
      onClick={() => onStepZoom(-1)} data-tooltip={t('缩小画布（-）')}>
      <Minus size={14} aria-hidden="true" />
    </button>
    {locked ? (
      <output className="canvas-zoom-value w-15 shrink-0 tabular-nums" aria-label={t('画布缩放比例')} aria-live="off">
        {percent}%
      </output>
    ) : <Select value={String(percent)} size="sm" fixedMenu className="canvas-zoom-select w-15 shrink-0 tabular-nums"
      aria-label={t('画布缩放比例')} disabled={disabled || locked}
      onChange={(value) => onZoomChange(Number(value) / 100)}
      options={presets.map((value) => ({ value: String(value), label: `${value}%` }))} />}
    <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost"
      aria-label={t('放大画布')} disabled={disabled || locked || percent >= MAX_CANVAS_ZOOM * 100}
      onClick={() => onStepZoom(1)} data-tooltip={t('放大画布（+）')}>
      <Plus size={14} aria-hidden="true" />
    </button>
    <button type="button" className={`ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost canvas-zoom-lock ${locked ? 'is-active' : ''}`}
      aria-label={lockLabel} aria-pressed={locked} disabled={disabled} onClick={onToggleLock}
      data-tooltip={`${lockLabel}（Shift+L）`}>
      {locked ? <LockKeyhole size={14} aria-hidden="true" /> : <UnlockKeyhole size={14} aria-hidden="true" />}
    </button>
  </>;
}

export default memo(CanvasZoomControl);
