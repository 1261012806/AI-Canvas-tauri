/**
 * 校验高级预设参数定义与取值，并安全渲染提示词模板变量。
 */
import { t } from '../i18n';
import type {
  PresetAdvancedConfig,
  PresetParameterDefinition,
  PresetParameterValue,
} from '../types';

export type PresetParameterValues = Record<string, PresetParameterValue>;

export const CURRENT_PROMPT_VARIABLE = 'currentPrompt';
export const LEGACY_PROMPT_VARIABLE = '文章内容';
/** 本步骤所选参考节点的 @ 引用，保留旧变量名；不写则自动前置，写了则原位插入。 */
export const PREVIOUS_RESULT_VARIABLE = 'previousResult';
export const MAX_PRESET_CONCURRENCY = 3;

const RESERVED_VARIABLES = [CURRENT_PROMPT_VARIABLE, LEGACY_PROMPT_VARIABLE, PREVIOUS_RESULT_VARIABLE];

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const PARAMETER_KEY_PATTERN = /^[\p{L}_][\p{L}\p{N}_-]*$/u;

function isBlank(value: PresetParameterValue | undefined): boolean {
  return value === undefined || (typeof value === 'string' && !value.trim());
}

function coerceDefaultValue(parameter: PresetParameterDefinition): PresetParameterValue {
  if (parameter.defaultValue !== undefined) return parameter.defaultValue;
  if (parameter.type === 'boolean') return false;
  if (parameter.type === 'number') return '';
  if (parameter.type === 'select') return parameter.options?.[0] ?? '';
  return '';
}

export function createPresetParameterValues(
  parameters: PresetParameterDefinition[],
): PresetParameterValues {
  return Object.fromEntries(
    parameters.map((parameter) => [parameter.key, coerceDefaultValue(parameter)]),
  );
}

export function extractPresetTemplateVariables(template: string): string[] {
  return [...new Set(
    Array.from(template.matchAll(TEMPLATE_VARIABLE_PATTERN), (match) => match[1].trim()),
  )];
}

export function renderPresetTemplate(
  template: string,
  values: PresetParameterValues,
  currentPrompt: string,
): string {
  return template.replace(TEMPLATE_VARIABLE_PATTERN, (match, rawKey: string) => {
    const key = rawKey.trim();
    if (key === CURRENT_PROMPT_VARIABLE || key === LEGACY_PROMPT_VARIABLE) {
      return currentPrompt;
    }
    if (!(key in values)) return match;
    return String(values[key]);
  });
}

/**
 * 渲染一个步骤的最终提示词：模板里出现 {{previousResult}} 就原位插入所选参考，
 * 否则把参考引用前置，保持旧预设的默认行为。
 */
export function composeStepPrompt(
  template: string,
  values: PresetParameterValues,
  currentPrompt: string,
  referenceMention: string,
): string {
  const rendered = renderPresetTemplate(
    template,
    { ...values, [PREVIOUS_RESULT_VARIABLE]: referenceMention },
    currentPrompt,
  ).trim();
  return extractPresetTemplateVariables(template).includes(PREVIOUS_RESULT_VARIABLE)
    ? rendered
    : referenceMention + '\n' + rendered;
}

export function validatePresetParameterValues(
  parameters: PresetParameterDefinition[],
  values: PresetParameterValues,
  translate: typeof t = t,
): string[] {
  const errors: string[] = [];
  for (const parameter of parameters) {
    const value = values[parameter.key];
    if (parameter.required && isBlank(value)) {
      errors.push(translate('请填写“{label}”', { label: parameter.label || parameter.key }));
      continue;
    }
    if (parameter.type === 'number' && !isBlank(value) && !Number.isFinite(Number(value))) {
      errors.push(translate('“{label}”必须是数字', { label: parameter.label || parameter.key }));
    }
    if (
      parameter.type === 'select'
      && !isBlank(value)
      && !(parameter.options ?? []).includes(String(value))
    ) {
      errors.push(translate('“{label}”的选项无效', { label: parameter.label || parameter.key }));
    }
  }
  return errors;
}

export function validatePresetAdvancedConfig(config: PresetAdvancedConfig, translate: typeof t = t): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  if (config.executionMode !== undefined && !['sequential', 'parallel'].includes(config.executionMode)) {
    errors.push(translate('快捷指令的执行方式无效'));
  }

  for (const [index, parameter] of config.parameters.entries()) {
    const displayIndex = index + 1;
    const key = parameter.key.trim();
    if (!parameter.label.trim()) errors.push(translate('参数 {index} 缺少名称', { index: displayIndex }));
    if (!key) {
      errors.push(translate('参数 {index} 缺少变量名', { index: displayIndex }));
    } else if (!PARAMETER_KEY_PATTERN.test(key)) {
      errors.push(translate('参数“{label}”的变量名格式无效', { label: parameter.label || displayIndex }));
    } else if (RESERVED_VARIABLES.includes(key)) {
      errors.push(translate('变量名“{key}”是内置变量，请换一个', { key }));
    } else if (keys.has(key)) {
      errors.push(translate('变量名“{key}”重复', { key }));
    }
    keys.add(key);

    if (parameter.type === 'select') {
      const options = (parameter.options ?? []).map((option) => option.trim()).filter(Boolean);
      if (options.length === 0) {
        errors.push(translate('参数“{label}”至少需要一个选项', { label: parameter.label || displayIndex }));
      }
    }
  }

  if (config.steps.length === 0) {
    errors.push(translate('高级快捷指令至少需要一个执行步骤'));
    return errors;
  }

  const allowedVariables = new Set([...RESERVED_VARIABLES, ...keys]);
  for (const [index, step] of config.steps.entries()) {
    const displayIndex = index + 1;
    if (!step.name.trim()) errors.push(translate('步骤 {index} 缺少名称', { index: displayIndex }));
    if (!step.promptTemplate.trim()) errors.push(translate('步骤 {index} 缺少提示词模板', { index: displayIndex }));
    if (step.referenceSource !== undefined && !['source', 'previous'].includes(step.referenceSource)) {
      errors.push(translate('步骤 {index} 的参考来源无效', { index: displayIndex }));
    }
    for (const variable of extractPresetTemplateVariables(step.promptTemplate)) {
      if (!allowedVariables.has(variable)) {
        errors.push(translate('步骤 {index} 使用了未定义变量“{variable}”', { index: displayIndex, variable }));
      }
    }
  }

  return errors;
}
