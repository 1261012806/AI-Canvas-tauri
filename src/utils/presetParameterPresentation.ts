import type { PresetAdvancedConfig, PresetParameterDefinition } from '../types';
import type { t } from '../i18n';

interface ParameterPurpose {
  key: string;
  label: string;
  hint: string;
  aliases: readonly string[];
}

const CUSTOM_PURPOSE: ParameterPurpose = {
  key: 'custom',
  label: '自定义内容',
  hint: '在下拉框中直接输入内容名称，下方胶囊会同步更新。',
  aliases: [],
};

export const PRESET_PARAMETER_PURPOSES: readonly ParameterPurpose[] = [
  {
    key: 'productInfo', label: '产品信息',
    hint: '填写产品名称、类别，以及已确认的质地和使用方式。',
    aliases: ['产品信息（名称、类别、已确认质地与用法）', '产品信息（名称、类别、已确认质地及用法）'],
  },
  {
    key: 'sellingPoints', label: '已确认卖点',
    hint: '只填写已确认的卖点；不确定的内容可以留空。',
    aliases: ['已确认卖点（可留空）'],
  },
  {
    key: 'visualStyle', label: '统一风格',
    hint: '填写整组图片或内容需要保持一致的风格。',
    aliases: ['整套图片的统一风格'],
  },
  {
    key: 'personDescription', label: '人物设定',
    hint: '填写人物的年龄范围、发型、服装等外观要求。',
    aliases: ['人物外观设定'],
  },
  CUSTOM_PURPOSE,
];

export function getPresetParameterPurpose(key: string): ParameterPurpose {
  return PRESET_PARAMETER_PURPOSES.find((purpose) => purpose.key === key && purpose !== CUSTOM_PURPOSE)
    ?? CUSTOM_PURPOSE;
}

/** Only built-in/default names follow the UI language; authored names remain literal. */
export function getPresetParameterLabel(parameter: PresetParameterDefinition, translate: typeof t): string {
  const purpose = getPresetParameterPurpose(parameter.key);
  if (parameter.label === purpose.label || purpose.aliases.includes(parameter.label)) {
    return translate(purpose.label);
  }
  const defaultName = /^参数 (\d+)$/.exec(parameter.label);
  if (defaultName) return translate('参数 {index}', { index: defaultName[1] });
  return parameter.label || translate('未命名参数');
}

export function createPresetParameterKey(parameters: PresetParameterDefinition[]): string {
  const keys = new Set(parameters.map((parameter) => parameter.key));
  let index = 1;
  while (keys.has(`param_${index}`)) index += 1;
  return `param_${index}`;
}

/** Keep a free-form editing draft in the component; persist only complete, distinct choices. */
export function updatePresetParameterOptions(
  parameter: PresetParameterDefinition,
  text: string,
): PresetParameterDefinition {
  const options = [...new Set(text.split(/[\r\n，,]/).map((option) => option.trim()).filter(Boolean))];
  const defaultValue = parameter.defaultValue;
  return {
    ...parameter,
    options,
    defaultValue: defaultValue !== undefined && defaultValue !== '' && !options.includes(String(defaultValue))
      ? '' : defaultValue,
  };
}

/** Change a purpose and its template references together without changing the parameter identity. */
export function changePresetParameterPurpose(
  config: PresetAdvancedConfig,
  parameterId: string,
  purposeKey: string,
): PresetAdvancedConfig {
  const parameter = config.parameters.find((item) => item.id === parameterId);
  const purpose = PRESET_PARAMETER_PURPOSES.find((item) => item.key === purposeKey);
  if (!parameter || !purpose || getPresetParameterPurpose(parameter.key).key === purposeKey) return config;
  const nextKey = purpose === CUSTOM_PURPOSE ? createPresetParameterKey(config.parameters) : purpose.key;
  if (config.parameters.some((item) => item.id !== parameterId && item.key === nextKey)) return config;
  return {
    ...config,
    parameters: config.parameters.map((item) => item.id === parameterId
      ? { ...item, key: nextKey, label: purpose.label } : item),
    steps: config.steps.map((step) => ({
      ...step,
      promptTemplate: step.promptTemplate.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (token, key: string) => (
        key.trim() === parameter.key ? '{{' + nextKey + '}}' : token
      )),
    })),
  };
}
