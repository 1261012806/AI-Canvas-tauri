import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, t } from '../../src/i18n';
import type { PresetAdvancedConfig, PresetParameterDefinition } from '../../src/types';
import {
  changePresetParameterPurpose,
  createPresetParameterKey,
  getPresetParameterLabel,
  getPresetParameterPurpose,
  updatePresetParameterOptions,
} from '../../src/utils/presetParameterPresentation';

const parameter: PresetParameterDefinition = {
  id: 'parameter-product', key: 'productInfo', label: '产品信息（名称、类别、已确认质地与用法）',
  type: 'textarea', required: true, defaultValue: '保留的产品信息',
};
const config: PresetAdvancedConfig = {
  executionMode: 'parallel',
  parameters: [parameter, { id: 'other', key: 'param_1', label: '我的内容', type: 'text' }],
  steps: [
    { id: 'one', name: '步骤 1', nodeType: 'ai-image', referenceSource: 'source', promptTemplate: '{{ productInfo }} / {{param_1}} / productInfo' },
    { id: 'two', name: '步骤 2', nodeType: 'ai-image', referenceSource: 'source', promptTemplate: '{{productInfo}} + {{productInfoExtra}} + {{currentPrompt}}' },
  ],
};

afterEach(() => setLocale('zh-CN'));

describe('快捷指令内容用途', () => {
  it('已有英文 key 只决定用途，自定义 key 不被改写', () => {
    expect(getPresetParameterPurpose('productInfo').label).toBe('产品信息');
    expect(getPresetParameterPurpose('my-existing-key').key).toBe('custom');
    expect(changePresetParameterPurpose(config, 'other', 'custom')).toBe(config);
  });

  it('切换用途同步全部精确占位符，保留普通文字和其他引用', () => {
    const next = changePresetParameterPurpose(config, parameter.id, 'visualStyle');
    expect(next.parameters[0]).toEqual({ ...parameter, key: 'visualStyle', label: '统一风格' });
    expect(next.parameters[1]).toBe(config.parameters[1]);
    expect(next.steps.map((step) => step.promptTemplate)).toEqual([
      '{{visualStyle}} / {{param_1}} / productInfo',
      '{{visualStyle}} + {{productInfoExtra}} + {{currentPrompt}}',
    ]);
    expect(next.executionMode).toBe('parallel');
    expect(config.parameters[0].key).toBe('productInfo');
    expect(config.steps[0].promptTemplate).toContain('{{ productInfo }}');
  });

  it('重复用途和未知用途不能覆盖现有参数', () => {
    const occupied: PresetAdvancedConfig = {
      ...config, parameters: [...config.parameters, { id: 'style', key: 'visualStyle', label: '统一风格', type: 'text' }],
    };
    expect(changePresetParameterPurpose(occupied, parameter.id, 'visualStyle')).toBe(occupied);
    expect(changePresetParameterPurpose(config, parameter.id, 'unknown')).toBe(config);
  });

  it('切成自定义内容分配不重复的内部 key，并保留所有设置', () => {
    expect(createPresetParameterKey(config.parameters)).toBe('param_2');
    const next = changePresetParameterPurpose(config, parameter.id, 'custom');
    expect(next.parameters[0]).toEqual({ ...parameter, key: 'param_2', label: '自定义内容' });
    expect(next.steps[0].promptTemplate).toBe('{{param_2}} / {{param_1}} / productInfo');
  });

  it('可选内容支持逐行或逗号输入，去除空项与重复项且保留有效默认内容', () => {
    const choices: PresetParameterDefinition = {
      ...parameter, type: 'select', options: ['暖调', '冷调'], defaultValue: '暖调',
    };
    const next = updatePresetParameterOptions(choices, ' 暖调\n冷调，暖调, 中性\n\n');
    expect(next.options).toEqual(['暖调', '冷调', '中性']);
    expect(next.defaultValue).toBe('暖调');
    expect(next.key).toBe(choices.key);
    expect(next.id).toBe(choices.id);
    expect(choices.options).toEqual(['暖调', '冷调']);
  });

  it('删除已选默认内容会清空默认值，避免保存无法匹配的选项', () => {
    const choices: PresetParameterDefinition = {
      ...parameter, type: 'select', options: ['暖调', '冷调'], defaultValue: '暖调',
    };
    expect(updatePresetParameterOptions(choices, '冷调').defaultValue).toBe('');
    expect(updatePresetParameterOptions(choices, '\n，,').options).toEqual([]);
    expect(updatePresetParameterOptions({ ...choices, defaultValue: undefined }, '冷调').defaultValue).toBeUndefined();
  });

  it.each(['zh-CN', 'en-US', 'ja-JP', 'ko-KR'] as const)('内置旧名称随 %s 界面翻译，用户名称和内部 key 保留', (locale) => {
    setLocale(locale);
    expect(getPresetParameterLabel(parameter, t)).toBe(t('产品信息'));
    expect(getPresetParameterLabel({ ...parameter, label: '我写的个性要求' }, t)).toBe('我写的个性要求');
    expect(getPresetParameterLabel({ ...parameter, key: 'param_2', label: '参数 2' }, t)).toBe(t('参数 {index}', { index: 2 }));
    expect(parameter.key).toBe('productInfo');
    if (locale !== 'zh-CN') expect(getPresetParameterLabel(parameter, t)).not.toBe('产品信息');
  });
});
