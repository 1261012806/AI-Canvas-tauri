import { describe, expect, it } from 'vitest';
import {
  getCloudWorkflowParameterSemantic,
  resolveCloudWorkflowParameterControl,
  createCloudWorkflowSliderBounds,
  cloudWorkflowSliderTicks,
  formatCloudWorkflowSliderValue,
  type CloudWorkflowParameterControlSpec,
} from '../../src/services/cloudWorkflowParameterControls';

function resolve(overrides: Partial<CloudWorkflowParameterControlSpec> = {}) {
  return resolveCloudWorkflowParameterControl({ name: 'scheduler', label: '调度器', type: 'string', value: 'simple', ...overrides });
}

describe('云工作流参数控件匹配', () => {
  it('识别语义但保留比例选项的完整提交值', () => {
    expect(getCloudWorkflowParameterSemantic('aspectRatio', '画面比例')).toBe('ratio');
    const control = resolve({ name: 'aspect_ratio', label: '画面比例', value: '16:9 (Widescreen)', options: ['16:9 (Widescreen)', '9:16 (Portrait)'] });
    expect(control.kind).toBe('segments');
    expect(control.options).toEqual([
      { value: '16:9 (Widescreen)', label: '16:9' },
      { value: '9:16 (Portrait)', label: '9:16' },
    ]);
  });

  it('浮点分辨率和时长使用数值滑块，不把比例字符串补造成允许值', () => {
    expect(resolve({ name: 'resolution', label: '分辨率', type: 'number', value: '1.5' }).kind).toBe('number-slider');
    expect(resolve({ name: 'duration', label: '时长（秒）', type: 'number', value: '12' }).kind).toBe('number-slider');
    expect(resolve({ name: 'aspect_ratio', label: '比例', value: '16:9 (Widescreen)' }).kind).toBe('ratio-input');
  });

  it('离散时长按原选项索引，自动值和未知值不被夹进数值范围', () => {
    const spec = { name: 'duration', label: '时长', type: 'number' as const, options: [4, 6, 9, -1, 'auto'] };
    const control = resolve({ ...spec, value: '6' });
    expect(control.kind).toBe('options-slider');
    expect(control.sliderOptions.map((option) => option.value)).toEqual(['4', '6', '9']);
    expect(control.currentOptionIndex).toBe(1);
    expect(resolve({ ...spec, value: '-1' }).currentOptionIndex).toBe(-1);
    expect(resolve({ ...spec, value: 'auto' }).currentOptionIndex).toBe(-1);
    expect(resolve({ ...spec, value: '7' }).currentOptionIndex).toBe(-1);
    expect(resolve({ ...spec, value: 'auto' }).kind).toBe('options-slider');
    const resolution = resolve({ name: 'resolution', label: '分辨率', value: '2K', options: ['768P', '2K', 'auto'] });
    expect(resolution.kind).toBe('options-slider');
    expect(resolution.sliderOptions.map((option) => option.value)).toEqual(['768P', '2K']);
    expect(resolution.specialOptions.map((option) => option.value)).toEqual(['auto']);
  });

  it('false 使用明确的关闭选项，声明的零枚举不会丢失', () => {
    const booleanControl = resolve({ name: 'enabled', label: '启用声音', type: 'boolean', value: 'false' });
    expect(booleanControl.options).toEqual([{ value: 'true', label: '启用' }, { value: 'false', label: '关闭' }]);
    expect(resolve({ name: 'high_resolution', label: '高分辨率', type: 'boolean', value: 'false' }).kind).toBe('segments');
    expect(resolve({ name: 'seed', label: '种子', type: 'number', value: '0', options: [0, 1] }).options[0].value).toBe('0');
  });

  it('长枚举使用下拉，普通字符串不再总是多行输入', () => {
    expect(resolve({ options: ['a'.repeat(40), 'b'.repeat(40)] }).kind).toBe('select');
    expect(resolve().kind).toBe('text');
    expect(resolve({ value: '第一行\n第二行' }).kind).toBe('textarea');
  });
  it('调度器有实际枚举时始终用下拉，其他短枚举保持原展示', () => {
    const options = ['simple', 'sgm_uniform', 'karras', 'exponential', 'ddim_uniform', 'beta', 'normal'];
    expect(resolve({ options }).kind).toBe('select');
    expect(resolve({ options: ['custom_a', 'custom_b'] })).toMatchObject({ kind: 'select', options: [
      { value: 'custom_a', label: 'custom_a' }, { value: 'custom_b', label: 'custom_b' },
    ] });
    expect(resolve({ name: 'schedule_mode', label: '调度模式', options: ['fast', 'slow'] }).kind).toBe('segments');
    expect(resolve({ name: 'scheduler_description', label: '调度器说明', options: ['short', 'long'] }).kind).toBe('segments');
  });

  it('缺少声明时使用固定文档区间，不随已有值扩大或缩小', () => {
    const bounds = createCloudWorkflowSliderBounds({ name: 'resolution', label: '分辨率', type: 'number', value: '1.5' });
    expect(bounds).toEqual({ min: 0.2, max: 4, step: 0.1, precision: 1, declared: false });
    expect(createCloudWorkflowSliderBounds({ name: 'resolution', label: '分辨率', type: 'number', value: '3.8' })).toEqual(bounds);
    expect(createCloudWorkflowSliderBounds({ name: 'duration', label: '时长', type: 'number', value: '12' }))
      .toEqual({ min: 2, max: 30, step: 1, precision: 0, declared: false });
    expect(formatCloudWorkflowSliderValue(0.1 + 0.2, bounds.precision)).toBe('0.3');
    expect(cloudWorkflowSliderTicks(bounds).every((tick) => Number.isFinite(Number(tick)))).toBe(true);
  });

  it('整数显示端点向内取整，固定声明不误当未知范围', () => {
    const fixed = createCloudWorkflowSliderBounds({ name: 'duration', label: '时长', type: 'integer', value: '2', min: 2, max: 2 });
    expect(fixed.declared).toBe(true);
    expect(cloudWorkflowSliderTicks(fixed)).toEqual(['2']);
    const integer = createCloudWorkflowSliderBounds({ name: 'duration', label: '时长', type: 'integer', value: '2', min: 1.2, max: 3.8 });
    expect(integer.min).toBe(2);
    expect(integer.max).toBe(3);
    expect(cloudWorkflowSliderTicks({ ...integer, max: Infinity })).toEqual([]);
  });

  it('单侧声明不与默认区间交叠时保留可选择的真实边界', () => {
    const duration = createCloudWorkflowSliderBounds({ name: 'duration', label: '时长', type: 'number', value: '', min: 60 });
    expect(duration.min).toBe(60);
    expect(duration.max).toBe(60);
    expect(cloudWorkflowSliderTicks(duration)).toEqual(['60']);
    const resolution = createCloudWorkflowSliderBounds({ name: 'resolution', label: '分辨率', type: 'number', value: '', max: 0.1 });
    expect(resolution.min).toBe(0.1);
    expect(resolution.max).toBe(0.1);
  });
});
