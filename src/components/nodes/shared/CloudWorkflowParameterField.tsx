import { useId, useState, type CSSProperties } from 'react';
import {
  cloudWorkflowSliderTicks,
  createCloudWorkflowSliderBounds,
  formatCloudWorkflowSliderValue,
  resolveCloudWorkflowParameterControl,
  type CloudWorkflowParameterControlSpec,
} from '../../../services/cloudWorkflowParameterControls';
import Select from '../../shared/Select';

interface CloudWorkflowParameterFieldProps extends CloudWorkflowParameterControlSpec {
  required?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  onReset?: () => void;
  defaultValue?: string | number | boolean;
  /** 仅声明式工作流空串表示采用默认值；精确输入仍保持空串。 */
  displayDefaultWhenEmpty?: boolean;
}

const parseNumber = (text: string) => text.trim() === '' ? NaN : Number(text);
const rangeStyle = (progress: number): CSSProperties => ({ '--range-progress': `${Math.min(100, Math.max(0, progress))}%` } as CSSProperties);

/** 分辨率和时长仅通过滑块与刻度编辑，不自动吸附已有值。 */
export default function CloudWorkflowParameterField({
  name, label, type, value, options, min, max, step, multiline: declaredMultiline,
  required = false, disabled = false, onChange, onReset, defaultValue, displayDefaultWhenEmpty = false,
}: CloudWorkflowParameterFieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const [multiline] = useState(() => declaredMultiline ?? [value, String(defaultValue ?? '')].some((text) => /[\r\n]/.test(text) || text.length > 100));
  const effectiveValue = displayDefaultWhenEmpty && value === '' ? String(defaultValue ?? '') : value;
  const spec = { name, label, type, value: effectiveValue, options, min, max, step, multiline };
  const control = resolveCloudWorkflowParameterControl(spec);
  const isSlider = control.kind === 'options-slider' || control.kind === 'number-slider';
  const knownValue = control.options.some((option) => option.value === effectiveValue);
  const selectionOptions = [
    ...(!knownValue ? [{ value: effectiveValue, label: effectiveValue === '' ? '未填写' : `当前值：${effectiveValue}` }] : []),
    ...control.options,
  ];
  const numericValue = parseNumber(effectiveValue);
  const bounds = createCloudWorkflowSliderBounds(spec);
  const validBounds = [bounds.min, bounds.max, bounds.step].every(Number.isFinite) && bounds.step > 0 && bounds.max >= bounds.min;
  const validRange = validBounds && bounds.max > bounds.min;
  const rangeHasValue = validBounds && Number.isFinite(numericValue) && numericValue >= bounds.min && numericValue <= bounds.max;
  const stepIndex = (numericValue - bounds.min) / bounds.step;
  const onSliderStep = rangeHasValue && Number.isFinite(stepIndex) && Math.abs(stepIndex - Math.round(stepIndex)) < 1e-7;
  const numericStep = step !== undefined && Number.isFinite(step) && step > 0 ? step : type === 'integer' ? 1 : 'any';
  const numberInput = () => <input id={id} className="ui-input w-full" type="number" value={value}
    min={min} max={max} step={numericStep} required={required} disabled={disabled}
    placeholder={defaultValue === undefined ? '未填写' : String(defaultValue)} onChange={(event) => onChange(event.target.value)} />;
  const currentBadge = <output className="ui-badge min-w-0 max-w-full" aria-live="off" title={effectiveValue || '未填写'}>
    <span className="min-w-0 truncate">{effectiveValue || '未填写'}</span>
  </output>;
  const discreteTicks = control.sliderOptions.filter((_, index, all) => all.length <= 8
    || Array.from({ length: 8 }, (_, tick) => Math.round(tick * (all.length - 1) / 7)).includes(index));
  const renderScalar = () => {
    if (control.kind === 'number') return numberInput();
    if (control.kind === 'ratio-input') return <div className="img-rp-quality-segmented">
      <output id={id} aria-labelledby={labelId} className={`img-rp-quality-item flex min-w-0 items-center justify-center break-words text-center ${effectiveValue ? 'active' : ''}`}
        title={effectiveValue || undefined}>{effectiveValue.match(/\d+(?:\.\d+)?\s*[:：]\s*\d+(?:\.\d+)?/)?.[0] || effectiveValue || '未填写'}</output>
    </div>;
    return multiline ? <textarea id={id} className="ui-textarea w-full resize-y" rows={3} value={value}
      required={required} disabled={disabled} placeholder={defaultValue === undefined ? '未填写' : String(defaultValue)}
      onChange={(event) => onChange(event.target.value)} />
      : <input id={id} className="ui-input w-full" type="text" value={value} required={required} disabled={disabled}
        placeholder={defaultValue === undefined ? '未填写' : String(defaultValue)} onChange={(event) => onChange(event.target.value)} />;
  };

  return <div className="ui-field min-w-0">
    <div className={`flex min-w-0 items-center justify-between gap-2 ${isSlider ? 'min-h-[var(--ui-control-h-sm)]' : ''}`}>
      <label id={labelId} htmlFor={id} className="img-rp-section-label cloud-workflow-param-label min-w-0 break-words">{label}{required ? ' *' : ''}</label>
      {(isSlider || onReset) && <div className="flex min-w-0 items-center justify-end gap-2">
        {isSlider && currentBadge}
        {onReset && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm shrink-0" disabled={disabled}
          onClick={onReset} aria-label={`${label}：${defaultValue === undefined ? '清除' : '恢复默认'}`}>
          {defaultValue === undefined ? '清除' : '恢复默认'}
        </button>}
      </div>}
    </div>
    {control.kind === 'segments' ? <>
      <div role="group" aria-labelledby={labelId} className={`img-rp-quality-segmented ${control.semantic === 'ratio' ? 'rh-video-resolution-seg' : 'flex-wrap'}`}>
        {control.options.map((option) => <button type="button" key={option.value}
          className={`img-rp-quality-item min-w-0 break-words text-center disabled:cursor-not-allowed disabled:opacity-50 ${effectiveValue === option.value ? 'active' : ''}`}
          title={option.value} aria-pressed={effectiveValue === option.value} disabled={disabled} onClick={() => onChange(option.value)}>{option.label}</button>)}
      </div>
      {!knownValue && <p className="ui-hint break-words">{effectiveValue === '' ? '未填写' : `当前值：${effectiveValue}`}</p>}
    </> : control.kind === 'select' ? <Select id={id} className="w-full" fixedMenu aria-label={label}
      required={required} value={effectiveValue} options={selectionOptions} disabled={disabled} onChange={onChange} />
      : control.kind === 'options-slider' ? <div className="rh-duration-slider">
        <input id={id} className="w-full" type="range" min={0} max={Math.max(0, control.sliderOptions.length - 1)} step={1}
          value={Math.max(0, control.currentOptionIndex)} style={rangeStyle(control.currentOptionIndex < 0 || control.sliderOptions.length < 2 ? 0 : control.currentOptionIndex * 100 / (control.sliderOptions.length - 1))}
          disabled={disabled || control.currentOptionIndex < 0 || control.sliderOptions.length < 2} aria-label={`${label}滑块`} aria-valuetext={effectiveValue || '未填写'}
          onChange={(event) => { const option = control.sliderOptions[Number(event.target.value)]; if (option) onChange(option.value); }} />
        <div className="rh-duration-labels gap-1" role="group" aria-labelledby={labelId}>
          {discreteTicks.map((option) => <button type="button" key={option.value}
            className={`rh-duration-tick truncate disabled:cursor-not-allowed disabled:opacity-50 ${effectiveValue === option.value ? 'active' : ''}`} title={option.label}
            disabled={disabled} aria-pressed={effectiveValue === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
        </div>
        {control.specialOptions.length > 0 && <div className="flex flex-wrap gap-1" role="group" aria-label={`${label}特殊选项`}>
          {control.specialOptions.map((option) => <button type="button" key={option.value}
            className={`ui-btn ui-btn--sm ${option.value === effectiveValue ? 'ui-btn--primary' : ''}`} disabled={disabled}
            aria-pressed={option.value === effectiveValue} onClick={() => onChange(option.value)}>{option.label}</button>)}
        </div>}
        {control.currentOptionIndex < 0 && <p className="ui-hint">选择档位后可拖动调整。</p>}
      </div>
        : control.kind === 'number-slider' ? <div className="rh-duration-slider">
          <input id={id} className="w-full" type="range" min={Number.isFinite(bounds.min) ? bounds.min : 0} max={validBounds ? bounds.max : Number.isFinite(bounds.min) ? bounds.min : 0}
            step={rangeHasValue && !onSliderStep ? 'any' : Number.isFinite(bounds.step) && bounds.step > 0 ? bounds.step : 1} value={rangeHasValue ? numericValue : Number.isFinite(bounds.min) ? bounds.min : 0}
            style={rangeStyle(rangeHasValue && validRange ? (numericValue - bounds.min) / (bounds.max - bounds.min) * 100 : 0)} disabled={disabled || !validRange || !onSliderStep}
            aria-label={`${label}滑块`} aria-valuetext={effectiveValue || '未填写'}
            onChange={(event) => onChange(formatCloudWorkflowSliderValue(Number(event.target.value), bounds.precision))} />
          {validBounds && <div className="rh-duration-labels gap-1" role="group" aria-labelledby={labelId}>
            {cloudWorkflowSliderTicks(bounds).map((tick) => <button type="button" key={tick} disabled={disabled}
              className={`rh-duration-tick truncate disabled:cursor-not-allowed disabled:opacity-50 ${tick === effectiveValue ? 'active' : ''}`}
              aria-pressed={tick === effectiveValue} onClick={() => onChange(tick)}>{tick}</button>)}
          </div>}
          {!rangeHasValue && <p className="ui-hint break-words">{!validBounds ? '当前参数范围不可用，请核对工作流定义。'
            : effectiveValue === '' ? '未填写；请选择刻度设置。'
              : `当前值 ${effectiveValue} 不在滑块范围 ${bounds.min}–${bounds.max}，原值保留，可选择刻度调整。`}</p>}
          {rangeHasValue && !onSliderStep && <p className="ui-hint">原值保留；选择刻度后可拖动调整。</p>}
        </div> : renderScalar()}
  </div>;
}
