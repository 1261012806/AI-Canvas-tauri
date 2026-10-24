/** Portable shortcut JSON. Imported values are validated data and never run here. */
import type {
  PresetAdvancedConfig,
  PresetParameterDefinition,
  PresetParameterType,
  PresetSequenceStep,
  UserPreset,
} from '../types';
import { PRESET_NODE_TYPES } from '../types';
import { generateId } from '../store/store.utils';
import { MAX_JSON_FILE_BYTES } from './fs/jsonFileTransfer';
import { validatePresetAdvancedConfig } from './presetTemplateService';

const SHARE_KIND = 'ai-canvas-preset';
const SHARE_VERSION = 1;
const MAX_ITEMS = 100;
const MAX_TEMPLATE_LENGTH = 128_000;
const MAX_THUMBNAIL_LENGTH = 4 * 1024 * 1024;
const PARAMETER_TYPES: PresetParameterType[] = ['text', 'textarea', 'number', 'select', 'boolean'];
const UNSAFE_PARAMETER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const INVALID_CONFIG = '快捷指令分享配置无效';
const INVALID_THUMBNAIL = '快捷指令缩略图格式无效';

type SharedParameter = Omit<PresetParameterDefinition, 'id'>;
type SharedStep = Omit<PresetSequenceStep, 'id'>;
type SharedAdvanced = Omit<PresetAdvancedConfig, 'parameters' | 'steps'> & {
  parameters: SharedParameter[];
  steps: SharedStep[];
};
type SharedPreset = Omit<UserPreset, 'id' | 'folderId' | 'advanced'> & { advanced?: SharedAdvanced };

function fail(message = INVALID_CONFIG): never {
  throw new Error(message);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (nonempty && !value.trim())) fail();
  return value;
}

function optionalText(value: unknown, maximum: number): string | undefined {
  return value === undefined ? undefined : text(value, maximum);
}

function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail();
  return value as T;
}

function boundedArray(value: unknown, maximum = MAX_ITEMS): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value;
}

function assertJsonSize(value: string): void {
  if (value.length > MAX_JSON_FILE_BYTES || new TextEncoder().encode(value).byteLength > MAX_JSON_FILE_BYTES) {
    fail('快捷指令 JSON 超过 8 MiB');
  }
}

function portableThumbnail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_THUMBNAIL_LENGTH) fail(INVALID_THUMBNAIL);
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) fail(INVALID_THUMBNAIL);
  let header: string;
  try { header = atob(match[2].slice(0, 32)); } catch { fail(INVALID_THUMBNAIL); }
  const valid = match[1] === 'png' ? header.startsWith('\x89PNG\r\n\x1a\n')
    : match[1] === 'jpeg' ? header.startsWith('\xff\xd8\xff')
      : match[1] === 'gif' ? /^GIF8[79]a/.test(header)
        : header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  if (!valid) fail(INVALID_THUMBNAIL);
  return value;
}

function readParameter(value: unknown): SharedParameter {
  const input = record(value);
  const type = choice(input.type, PARAMETER_TYPES);
  const key = text(input.key, 80, true).trim();
  if (UNSAFE_PARAMETER_KEYS.has(key)) fail();
  if (input.required !== undefined && typeof input.required !== 'boolean') fail();
  const options = input.options === undefined ? undefined
    : boundedArray(input.options, 200).map((option) => text(option, 2_000));
  const defaultValue = input.defaultValue;
  if (defaultValue !== undefined) {
    if (type === 'boolean') {
      if (typeof defaultValue !== 'boolean') fail();
    } else if (type === 'number') {
      if ((typeof defaultValue !== 'number' && typeof defaultValue !== 'string')
        || (typeof defaultValue === 'string' && defaultValue.length > 100)
        || !Number.isFinite(Number(defaultValue))) fail();
    } else {
      text(defaultValue, 32_000);
      if (type === 'select' && defaultValue !== '' && !options?.includes(defaultValue as string)) fail();
    }
  }
  return {
    key,
    label: text(input.label, 200, true),
    type,
    required: input.required as boolean | undefined,
    defaultValue: defaultValue as PresetParameterDefinition['defaultValue'],
    options,
  };
}

function readStep(value: unknown): SharedStep {
  const input = record(value);
  return {
    name: text(input.name, 200, true),
    nodeType: choice(input.nodeType, PRESET_NODE_TYPES),
    promptTemplate: text(input.promptTemplate, MAX_TEMPLATE_LENGTH, true),
    referenceSource: input.referenceSource === undefined ? undefined : choice(input.referenceSource, ['source', 'previous']),
    model: optionalText(input.model, 240),
    provider: optionalText(input.provider, 240),
    workflowId: optionalText(input.workflowId, 240),
    imageSize: optionalText(input.imageSize, 80),
    aspectRatio: optionalText(input.aspectRatio, 80),
  };
}

function readAdvanced(value: unknown): SharedAdvanced {
  const input = record(value);
  const advanced: SharedAdvanced = {
    executionMode: input.executionMode === undefined ? undefined : choice(input.executionMode, ['sequential', 'parallel']),
    parameters: boundedArray(input.parameters).map(readParameter),
    steps: boundedArray(input.steps).map(readStep),
  };
  const validation: PresetAdvancedConfig = {
    executionMode: advanced.executionMode,
    parameters: advanced.parameters.map((parameter, index) => ({ ...parameter, id: `parameter-${index}` })),
    steps: advanced.steps.map((step, index) => ({ ...step, id: `step-${index}` })),
  };
  if (validatePresetAdvancedConfig(validation).length) fail();
  return advanced;
}

function readPreset(value: unknown, importing: boolean): SharedPreset {
  const input = record(value);
  const mode = input.mode === undefined ? 'basic' : choice(input.mode, ['basic', 'advanced']);
  let thumbnail: string | undefined;
  if (importing) thumbnail = portableThumbnail(input.thumbnail);
  else {
    // Local covers may be nonportable URLs. Share only a verified embedded bitmap.
    try { thumbnail = portableThumbnail(input.thumbnail); } catch { thumbnail = undefined; }
  }
  return {
    nodeType: choice(input.nodeType, PRESET_NODE_TYPES),
    name: text(input.name, 200, true),
    description: input.description === undefined ? '' : text(input.description, 32_000),
    promptTemplate: input.promptTemplate === undefined ? '' : text(input.promptTemplate, MAX_TEMPLATE_LENGTH),
    triggerMode: input.triggerMode === undefined ? 'direct' : choice(input.triggerMode, ['direct', 'insertPrompt']),
    mode,
    icon: optionalText(input.icon, 120),
    thumbnail,
    model: optionalText(input.model, 240),
    provider: optionalText(input.provider, 240),
    imageSize: optionalText(input.imageSize, 80),
    aspectRatio: optionalText(input.aspectRatio, 80),
    advanced: mode === 'advanced' ? readAdvanced(input.advanced) : undefined,
  };
}

/** Copy and file export use the same versioned, allowlisted JSON text. */
export function serializePresetShare(preset: UserPreset): string {
  const serialized = JSON.stringify({ kind: SHARE_KIND, version: SHARE_VERSION, preset: readPreset(preset, false) }, null, 2);
  assertJsonSize(serialized);
  return serialized;
}

/** Build a new shortcut. No existing IDs, folder bindings or unknown fields survive. */
export function parsePresetShare(source: string): UserPreset {
  if (typeof source !== 'string') fail('快捷指令 JSON 格式无效');
  assertJsonSize(source);
  let envelope: unknown;
  try { envelope = JSON.parse(source); } catch { fail('快捷指令 JSON 格式无效'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || (envelope as Record<string, unknown>).kind !== SHARE_KIND) fail('不是有效的快捷指令分享文件');
  const input = envelope as Record<string, unknown>;
  if (input.version !== SHARE_VERSION) fail('不支持此快捷指令分享版本');
  const preset = readPreset(input.preset, true);
  return {
    ...preset,
    id: 'preset-' + generateId(),
    advanced: preset.advanced ? {
      executionMode: preset.advanced.executionMode,
      parameters: preset.advanced.parameters.map((parameter) => ({ ...parameter, id: 'parameter-' + generateId() })),
      steps: preset.advanced.steps.map((step) => ({ ...step, id: 'step-' + generateId() })),
    } : undefined,
  };
}
