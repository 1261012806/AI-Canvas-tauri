export type CloudWorkflowParameterSemantic = 'ratio' | 'resolution' | 'duration' | 'other';
export type CloudWorkflowParameterValue = string | number | boolean;

export interface CloudWorkflowParameterControlSpec {
  name: string;
  label: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  value: string;
  options?: readonly CloudWorkflowParameterValue[];
  min?: number;
  max?: number;
  step?: number;
  multiline?: boolean;
}

export interface CloudWorkflowParameterOption {
  value: string;
  label: string;
}

export interface CloudWorkflowParameterControl {
  kind: 'segments' | 'select' | 'options-slider' | 'number-slider' | 'ratio-input' | 'number' | 'text' | 'textarea';
  semantic: CloudWorkflowParameterSemantic;
  options: CloudWorkflowParameterOption[];
  /** 离散滑块按原始选项索引拖动，不补造中间值。 */
  sliderOptions: CloudWorkflowParameterOption[];
  specialOptions: CloudWorkflowParameterOption[];
  currentOptionIndex: number;
}

/** 语义只决定展示方式；调用方始终使用工作流原有字段名和值。 */
export function getCloudWorkflowParameterSemantic(name: string, label: string): CloudWorkflowParameterSemantic {
  const words = `${name} ${label}`.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_-]+/g, ' ');
  if (/宽高比|画面比例|图像比例|画幅比例|宽高比例|(?:^|\s)(?:aspect\s+ratio|ratio)(?:\s|$)/.test(words)) return 'ratio';
  if (/分辨率|解析度|(?:^|\s)resolution(?:\s|$)/.test(words)) return 'resolution';
  if (/时长|持续时间|(?:^|\s)duration(?:\s|$)/.test(words)) return 'duration';
  return 'other';
}

function optionLabel(value: string, semantic: CloudWorkflowParameterSemantic, type: CloudWorkflowParameterControlSpec['type']): string {
  if (value === '') return '空值';
  if (type === 'boolean') {
    if (value === 'true') return '启用';
    if (value === 'false') return '关闭';
  }
  if (semantic === 'ratio') {
    const ratio = value.match(/^\s*(\d+(?:\.\d+)?\s*[:：]\s*\d+(?:\.\d+)?)(?=\s|\(|$)/)?.[1];
    if (ratio) return ratio.replace(/\s/g, '').replace('：', ':');
  }
  return value;
}

function specialSliderValue(value: string): boolean {
  const text = value.trim();
  return text === '' || /^(auto|automatic|adaptive|default|自动|自适应|默认)$/i.test(text)
    || (Number.isFinite(Number(text)) && Number(text) < 0);
}

export function resolveCloudWorkflowParameterControl(spec: CloudWorkflowParameterControlSpec): CloudWorkflowParameterControl {
  const semantic = getCloudWorkflowParameterSemantic(spec.name, spec.label);
  const sourceOptions = spec.options?.length ? spec.options : spec.type === 'boolean' ? [true, false] : [];
  const options = [...new Set(sourceOptions.map(String))].map((value) => ({ value, label: optionLabel(value, semantic, spec.type) }));
  const sliderOptions = spec.type !== 'boolean' && (semantic === 'duration' || semantic === 'resolution')
    ? options.filter((option) => !specialSliderValue(option.value)) : [];
  const specialOptions = options.filter((option) => !sliderOptions.includes(option));
  const currentOptionIndex = sliderOptions.findIndex((option) => option.value === spec.value);
  const common = { semantic, options, sliderOptions, specialOptions, currentOptionIndex };

  if (options.length) {
    if (sliderOptions.length) return { ...common, kind: 'options-slider' };
    const shortOptions = options.length >= 2 && options.length <= 8 && options.every((option) => option.label.length <= 18)
      && options.reduce((total, option) => total + option.label.length, 0) <= 80;
    return { ...common, kind: shortOptions ? 'segments' : 'select' };
  }

  if (spec.type === 'number' || spec.type === 'integer') {
    return { ...common, kind: semantic === 'duration' || semantic === 'resolution' ? 'number-slider' : 'number' };
  }
  if (semantic === 'ratio') return { ...common, kind: 'ratio-input' };
  const multiline = spec.multiline ?? (/[\r\n]/.test(spec.value) || spec.value.length > 100);
  return { ...common, kind: multiline ? 'textarea' : 'text' };
}

export interface CloudWorkflowSliderBounds {
  min: number;
  max: number;
  step: number;
  precision: number;
  declared: boolean;
}

function decimalPlaces(value: number): number {
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e');
  return Math.min(12, Math.max(0, (coefficient.split('.')[1]?.length ?? 0) - Number(exponent)));
}

export function formatCloudWorkflowSliderValue(value: number, precision: number): string {
  return String(Number(value.toFixed(Math.min(12, Math.max(0, precision)))));
}

/** 优先使用工作流声明，缺失边界采用用户确认的文档范围，不随当前值改变。 */
export function createCloudWorkflowSliderBounds(spec: CloudWorkflowParameterControlSpec): CloudWorkflowSliderBounds {
  const semantic = getCloudWorkflowParameterSemantic(spec.name, spec.label);
  const defaults = semantic === 'resolution' ? { min: 0.2, max: 4, step: 0.1 }
    : { min: 2, max: 30, step: 1 };
  const knownMin = spec.min !== undefined && Number.isFinite(spec.min) ? spec.min : undefined;
  const knownMax = spec.max !== undefined && Number.isFinite(spec.max) ? spec.max : undefined;
  const declared = knownMin !== undefined && knownMax !== undefined;
  const explicitStep = spec.step !== undefined && Number.isFinite(spec.step) && spec.step > 0 ? spec.step : undefined;
  const step = spec.type === 'integer' ? Math.max(1, Math.round(explicitStep ?? 1)) : explicitStep ?? defaults.step;
  let min = knownMin ?? defaults.min;
  let max = knownMax ?? defaults.max;
  if (spec.type === 'integer') min = Math.ceil(min);
  if (spec.type === 'integer') max = Math.floor(max);
  // 单侧声明与默认区间不相交时仍提供真实边界值，不能造出反向区间。
  if (knownMin !== undefined && knownMax === undefined) max = Math.max(min, max);
  if (knownMax !== undefined && knownMin === undefined) min = Math.min(min, max);
  const precision = spec.type === 'integer' ? 0 : Math.max(decimalPlaces(min), decimalPlaces(max), decimalPlaces(step));
  return { min: Number(formatCloudWorkflowSliderValue(min, precision)), max: Number(formatCloudWorkflowSliderValue(max, precision)), step, precision, declared };
}

export function cloudWorkflowSliderTicks(bounds: CloudWorkflowSliderBounds): string[] {
  if (![bounds.min, bounds.max, bounds.step].every(Number.isFinite) || bounds.max < bounds.min || !(bounds.step > 0)) return [];
  if (bounds.max === bounds.min) return [formatCloudWorkflowSliderValue(bounds.min, bounds.precision)];
  const intervals = Math.floor((bounds.max - bounds.min) / bounds.step + 1e-9);
  if (!Number.isFinite(intervals)) return [bounds.min, bounds.max].map((value) => formatCloudWorkflowSliderValue(value, bounds.precision));
  const count = Math.min(7, intervals + 1);
  if (count < 2) return [formatCloudWorkflowSliderValue(bounds.min, bounds.precision)];
  return [...new Set(Array.from({ length: count }, (_, index) => formatCloudWorkflowSliderValue(
    bounds.min + Math.round(index / (count - 1) * intervals) * bounds.step, bounds.precision,
  )))];
}
