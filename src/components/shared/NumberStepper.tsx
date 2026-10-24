/**
 * NumberStepper — 高精数字微调步进输入框
 *
 * 专为 AI 画布参数节点、属性检查器、工具栏缩放等场景打造。
 * 遵循 W3C WAI-ARIA Spinbutton 规范，支持：
 * 1. 键入数值与单位智能识别（失焦/回车自动裁切到 [min, max]）
 * 2. 上下微调按键（单点 ±step、Shift+点按 ±shiftMultiplier*step、长按连续加速）
 * 3. 键盘 ↑/↓ 快捷微调（支持 Shift 加速）
 * 4. 鼠标滚轮穿透微调
 * 5. 鼠标水平横向拖拽调节（Scrubbing）
 * 6. 等宽数字（tabular-nums）与三档尺寸（sm: 26px / md: 32px / lg: 40px）
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type WheelEvent } from 'react';
import { useT } from '../../i18n';

export interface NumberStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** 按住 Shift 时的倍率，默认 10 */
  shiftMultiplier?: number;
  /** 单位后缀（如 'px', '%', 'deg', 'ms', 'x' 等） */
  unit?: string;
  /** 尺寸档位：sm (26px) / md (32px, 默认) / lg (40px) */
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  id?: string;
  name?: string;
  precision?: number;
  'aria-label'?: string;
  title?: string;
  /** 拖拽微调状态变化回调 */
  onScrubStateChange?: (isScrubbing: boolean) => void;
}

function getPrecision(step: number, precisionProp?: number): number {
  if (typeof precisionProp === 'number') return precisionProp;
  const stepStr = String(step);
  const dotIndex = stepStr.indexOf('.');
  return dotIndex >= 0 ? stepStr.length - dotIndex - 1 : 0;
}

function roundToPrecision(val: number, precision: number): number {
  const factor = Math.pow(10, precision);
  return Math.round(val * factor) / factor;
}

function parseInputValue(text: string, unit?: string): number | undefined {
  let raw = text.trim();
  if (unit && raw.toLowerCase().endsWith(unit.toLowerCase())) {
    raw = raw.slice(0, -unit.length).trim();
  }
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export default function NumberStepper({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  shiftMultiplier = 10,
  unit,
  size = 'md',
  disabled = false,
  className = '',
  style,
  id,
  name,
  precision: precisionProp,
  'aria-label': ariaLabel,
  title,
  onScrubStateChange,
}: NumberStepperProps) {
  const t = useT();
  const precision = getPrecision(step, precisionProp);

  const clamp = useCallback((v: number): number => {
    const clamped = Math.max(min, Math.min(max, v));
    return roundToPrecision(clamped, precision);
  }, [min, max, precision]);

  // 当用户主动编辑时使用 draftText，未编辑时直接派生当前 value
  const [draftText, setDraftText] = useState<string | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const draftTextRef = useRef<string | null>(null);
  const updateDraftText = useCallback((text: string | null) => {
    // blur 可能在同一事件中同步发生，提交和取消都读取即时草稿。
    draftTextRef.current = text;
    setDraftText(text);
  }, []);

  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<HTMLDivElement>(null);
  const stopScrubRef = useRef<(() => void) | null>(null);
  const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const latestValueRef = useRef(value);
  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  const latestClampRef = useRef(clamp);
  useEffect(() => {
    latestClampRef.current = clamp;
  }, [clamp]);

  const latestOnChangeRef = useRef(onChange);
  useEffect(() => {
    latestOnChangeRef.current = onChange;
  }, [onChange]);

  // 清除长按定时器
  const clearRepeat = useCallback(() => {
    if (repeatTimerRef.current) clearTimeout(repeatTimerRef.current);
    if (repeatIntervalRef.current) clearInterval(repeatIntervalRef.current);
    repeatTimerRef.current = null;
    repeatIntervalRef.current = null;
  }, []);

  useEffect(() => {
    if (disabled) {
      clearRepeat();
      stopScrubRef.current?.();
    }
    return () => {
      clearRepeat();
      stopScrubRef.current?.();
    };
  }, [clearRepeat, disabled]);

  const cancelInput = useCallback(() => {
    updateDraftText(null);
    inputRef.current?.blur();
  }, [updateDraftText]);

  useEffect(() => {
    if (disabled) return;
    let cancelledEscape = false;
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      if (event.target !== inputRef.current && !cancelledEscape) return;
      // 在父弹窗的 document 捕获监听前取消编辑，本次按键只处理当前控件。
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelledEscape = true;
      cancelInput();
    };
    const keyup = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !cancelledEscape) return;
      cancelledEscape = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const resetEscape = () => { cancelledEscape = false; };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('keyup', keyup, true);
    window.addEventListener('blur', resetEscape);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
      window.removeEventListener('blur', resetEscape);
    };
  }, [cancelInput, disabled]);

  // 步进核心处理
  const stepBy = useCallback((delta: number) => {
    if (disabled) return;
    const draft = draftTextRef.current;
    const current = draft === null ? latestValueRef.current
      : latestClampRef.current(parseInputValue(draft, unit) ?? latestValueRef.current);
    const next = latestClampRef.current(current + delta);
    updateDraftText(null);
    if (next !== latestValueRef.current) {
      latestOnChangeRef.current(next);
    }
  }, [disabled, unit, updateDraftText]);

  // 长按连续触发
  const startRepeat = (direction: 1 | -1, isShift: boolean) => {
    if (disabled) return;
    clearRepeat();
    const delta = (isShift ? step * shiftMultiplier : step) * direction;
    stepBy(delta);

    repeatTimerRef.current = setTimeout(() => {
      let intervalMs = 100;
      let ticks = 0;
      repeatIntervalRef.current = setInterval(() => {
        stepBy(delta);
        ticks++;
        if (ticks > 6 && intervalMs > 35) {
          intervalMs = Math.max(30, intervalMs - 15);
          if (repeatIntervalRef.current) clearInterval(repeatIntervalRef.current);
          repeatIntervalRef.current = setInterval(() => stepBy(delta), intervalMs);
        }
      }, intervalMs);
    }, 350);
  };

  // 键盘快捷响应
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.shiftKey ? step * shiftMultiplier : step;
      stepBy(delta);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const delta = e.shiftKey ? step * shiftMultiplier : step;
      stepBy(-delta);
    } else if (e.key === 'Enter') {
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelInput();
    }
  };

  // 滚轮微调
  const handleWheel = (e: WheelEvent) => {
    if (disabled) return;
    e.preventDefault();
    const mult = e.shiftKey ? shiftMultiplier : 1;
    const delta = (e.deltaY < 0 ? step : -step) * mult;
    stepBy(delta);
  };

  // 提交输入框文本
  const commitInput = () => {
    const draft = draftTextRef.current;
    if (draft === null) return;
    const next = clamp(parseInputValue(draft, unit) ?? value);
    updateDraftText(null);
    onChange(next);
  };

  // 水平拖拽微调 (Scrubbing)
  const handleDragMouseDown = (e: React.MouseEvent) => {
    if (disabled || e.button !== 0) return;
    if (document.activeElement === inputRef.current) return;
    stopScrubRef.current?.();

    let hasMoved = false;
    const startX = e.clientX;
    const startVal = latestValueRef.current;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const diffX = moveEvent.clientX - startX;
      if (!hasMoved && Math.abs(diffX) > 2) {
        hasMoved = true;
        setIsScrubbing(true);
        onScrubStateChange?.(true);
        document.body.classList.add('cursor-ew-resize', 'select-none');
      }
      if (!hasMoved) return;

      const rate = moveEvent.shiftKey ? Math.max(step * 2, step * shiftMultiplier * 0.2) : step * 0.5;
      const rawDelta = diffX * rate;
      const roundedDelta = Math.round(rawDelta / step) * step;
      const next = latestClampRef.current(startVal + roundedDelta);
      if (next !== latestValueRef.current) {
        latestOnChangeRef.current(next);
        updateDraftText(null);
      }
    };

    const onMouseUp = () => {
      stopScrubRef.current = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.classList.remove('cursor-ew-resize', 'select-none');
      if (hasMoved) {
        setIsScrubbing(false);
        onScrubStateChange?.(false);
      }
    };

    stopScrubRef.current = onMouseUp;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const sizeClass = size === 'sm' ? 'ui-stepper--sm' : size === 'lg' ? 'ui-stepper--lg' : '';

  const activeValue = clamp(draftText === null ? value : parseInputValue(draftText, unit) ?? value);
  const canIncrease = !disabled && activeValue < max;
  const canDecrease = !disabled && activeValue > min;
  const displayValue = draftText !== null ? draftText : String(clamp(value));

  return (
    <div
      className={`ui-stepper ${sizeClass} ${isScrubbing ? 'is-scrubbing' : ''} ${disabled ? 'is-disabled' : ''} ${className}`.trim()}
      style={style}
      title={title}
      role="group"
      aria-label={ariaLabel || t('数字步进微调')}
    >
      {/* 拖拽微调与数值键入区域 */}
      <div
        ref={dragRef}
        className="ui-stepper__drag"
        onMouseDown={handleDragMouseDown}
        onWheel={handleWheel}
        title={t('双击或点击编辑，左右拖拽可平滑微调数值')}
      >
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="text"
          inputMode="decimal"
          className="ui-stepper__input"
          value={displayValue}
          disabled={disabled}
          role="spinbutton"
          aria-label={ariaLabel}
          aria-valuenow={value}
          aria-valuemin={min !== -Infinity ? min : undefined}
          aria-valuemax={max !== Infinity ? max : undefined}
          aria-disabled={disabled}
          onFocus={() => {
            updateDraftText(String(clamp(value)));
            inputRef.current?.select();
          }}
          onBlur={commitInput}
          onChange={(e) => updateDraftText(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>

      {/* 步进微调双向按钮盒 */}
      <div className="ui-stepper__actions" aria-hidden={disabled}>
        <button
          type="button"
          className="ui-stepper__btn ui-stepper__btn--up"
          title={t('增加 {step} (Shift+点击 +{largeStep})', { step, largeStep: step * shiftMultiplier })}
          disabled={!canIncrease}
          tabIndex={-1}
          onPointerDown={(e) => startRepeat(1, e.shiftKey)}
          onPointerUp={clearRepeat}
          onPointerLeave={clearRepeat}
          onPointerCancel={clearRepeat}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
        <span className="ui-stepper__divider" />
        <button
          type="button"
          className="ui-stepper__btn ui-stepper__btn--down"
          title={t('减少 {step} (Shift+点击 -{largeStep})', { step, largeStep: step * shiftMultiplier })}
          disabled={!canDecrease}
          tabIndex={-1}
          onPointerDown={(e) => startRepeat(-1, e.shiftKey)}
          onPointerUp={clearRepeat}
          onPointerLeave={clearRepeat}
          onPointerCancel={clearRepeat}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {/* 单位后缀 */}
      {unit ? <span className="ui-stepper__unit">{unit}</span> : null}
    </div>
  );
}
