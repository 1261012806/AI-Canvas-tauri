import { describe, expect, it } from 'vitest';
import type { UserPreset } from '../../src/types';
import { MAX_JSON_FILE_BYTES } from '../../src/services/fs/jsonFileTransfer';
import { parsePresetShare, serializePresetShare } from '../../src/services/presetShareService';

const bitmap = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=';
const basic: UserPreset = {
  id: 'local-preset', folderId: 'local-folder', nodeType: 'ai-image', name: '产品图',
  description: '产品特写', promptTemplate: '', triggerMode: 'insertPrompt',
  model: 'image-model', provider: 'general', imageSize: '2K', aspectRatio: '4:5', icon: 'mdi:image', thumbnail: bitmap,
};
const advanced: UserPreset = {
  ...basic,
  mode: 'advanced',
  advanced: {
    executionMode: 'parallel',
    parameters: [
      { id: 'local-parameter-1', key: 'theme', label: '主题', type: 'select', options: ['产品', '生活'], defaultValue: '生活', required: true },
      { id: 'local-parameter-2', key: 'count', label: '数量', type: 'number', defaultValue: 0 },
      { id: 'local-parameter-3', key: 'enabled', label: '启用', type: 'boolean', defaultValue: false },
    ],
    steps: [
      { id: 'local-step-1', name: '产品特写', nodeType: 'ai-image', promptTemplate: '{{theme}} {{currentPrompt}}', referenceSource: 'source', provider: 'comfyui', model: 'comfyui/workflow', workflowId: 'workflow-reference', imageSize: '2K', aspectRatio: '4:5' },
      { id: 'local-step-2', name: '细化', nodeType: 'ai-image', promptTemplate: '{{previousResult}} 细化', referenceSource: 'previous' },
    ],
  },
};

describe('presetShareService', () => {
  it('基础草稿可分享空模板，保留便携字段且每次导入创建新指令', () => {
    const serialized = serializePresetShare(basic);
    const envelope = JSON.parse(serialized);
    expect(envelope).toMatchObject({ kind: 'ai-canvas-preset', version: 1, preset: { mode: 'basic', promptTemplate: '' } });
    const first = parsePresetShare(serialized);
    const second = parsePresetShare(serialized);
    expect(first).toMatchObject({ nodeType: 'ai-image', name: '产品图', description: '产品特写',
      promptTemplate: '', triggerMode: 'insertPrompt', model: 'image-model', provider: 'general',
      imageSize: '2K', aspectRatio: '4:5', icon: 'mdi:image', thumbnail: bitmap });
    expect(first.id).not.toBe(basic.id);
    expect(second.id).not.toBe(first.id);
    expect(first).not.toHaveProperty('folderId');
    expect(envelope.preset).not.toHaveProperty('id');
    expect(envelope.preset).not.toHaveProperty('folderId');
  });

  it('高级参数、引用来源、并发和工作流引用完整往返，所有内层 ID 重建', () => {
    const serialized = serializePresetShare(advanced);
    const imported = parsePresetShare(serialized);
    expect(serialized).not.toContain('local-parameter');
    expect(serialized).not.toContain('local-step');
    expect(imported.advanced).toMatchObject({ executionMode: 'parallel', parameters: [
      { key: 'theme', type: 'select', options: ['产品', '生活'], defaultValue: '生活', required: true },
      { key: 'count', type: 'number', defaultValue: 0 },
      { key: 'enabled', type: 'boolean', defaultValue: false },
    ], steps: [
      { name: '产品特写', referenceSource: 'source', workflowId: 'workflow-reference' },
      { name: '细化', referenceSource: 'previous' },
    ] });
    expect(imported.advanced!.parameters.every((parameter) => !parameter.id.startsWith('local-'))).toBe(true);
    expect(imported.advanced!.steps.every((step) => !step.id.startsWith('local-'))).toBe(true);
    expect(serializePresetShare(imported)).toBe(serialized);
  });

  it('导入忽略外部身份、文件夹、凭据和任意未知字段，模式缺省兼容基础指令', () => {
    const envelope = JSON.parse(serializePresetShare(basic));
    Object.assign(envelope.preset, { id: 'hostile-id', folderId: 'hostile-folder', apiKey: 'not-a-real-key',
      apiKeyRef: 'private-reference', absolutePath: 'private-path' });
    delete envelope.preset.mode;
    delete envelope.preset.triggerMode;
    const imported = parsePresetShare(JSON.stringify(envelope));
    expect(imported).toMatchObject({ mode: 'basic', triggerMode: 'direct' });
    for (const key of ['folderId', 'apiKey', 'apiKeyRef', 'absolutePath']) expect(imported).not.toHaveProperty(key);
    expect(imported.id).not.toBe('hostile-id');
  });

  it.each([
    ['invalid-json', '快捷指令 JSON 格式无效'],
    ['null', '不是有效的快捷指令分享文件'],
    ['[]', '不是有效的快捷指令分享文件'],
    ['{"kind":"other","version":1}', '不是有效的快捷指令分享文件'],
    ['{"kind":"ai-canvas-preset","version":2}', '不支持此快捷指令分享版本'],
  ])('拒绝错误文件 %s，错误不回显原始内容', (input, message) => {
    expect(() => parsePresetShare(input)).toThrow(message);
  });

  it.each(['mode', 'triggerMode', 'nodeType'])('拒绝非法的 %s 枚举', (field) => {
    const envelope = JSON.parse(serializePresetShare(basic));
    envelope.preset[field] = 'unknown';
    expect(() => parsePresetShare(JSON.stringify(envelope))).toThrow('快捷指令分享配置无效');
  });

  it.each(['__proto__', 'constructor', 'prototype'])('拒绝特殊参数键 %s', (key) => {
    const envelope = JSON.parse(serializePresetShare(advanced));
    envelope.preset.advanced.parameters[0].key = key;
    expect(() => parsePresetShare(JSON.stringify(envelope))).toThrow('快捷指令分享配置无效');
  });

  it('拒绝参数重名、未定义变量和非法步骤引用或执行模式', () => {
    const mutate = (change: (value: ReturnType<typeof JSON.parse>) => void) => {
      const envelope = JSON.parse(serializePresetShare(advanced));
      change(envelope.preset.advanced);
      expect(() => parsePresetShare(JSON.stringify(envelope))).toThrow('快捷指令分享配置无效');
    };
    mutate((value) => { value.parameters[1].key = 'theme'; });
    mutate((value) => { value.steps[0].promptTemplate = '{{undeclared}}'; });
    mutate((value) => { value.steps[0].referenceSource = 'unknown'; });
    mutate((value) => { value.executionMode = 'unknown'; });
    mutate((value) => { value.steps = []; });
    mutate((value) => { value.parameters[0].required = 'yes'; });
    mutate((value) => { value.parameters[0].defaultValue = '不在选项中'; });
    mutate((value) => { value.parameters[2].defaultValue = 'false'; });
  });

  it('保留数字空值和数字字符串，但拒绝非有限数字', () => {
    const envelope = JSON.parse(serializePresetShare(advanced));
    for (const defaultValue of ['', '12.5', 0]) {
      envelope.preset.advanced.parameters[1].defaultValue = defaultValue;
      expect(parsePresetShare(JSON.stringify(envelope)).advanced!.parameters[1].defaultValue).toBe(defaultValue);
    }
    envelope.preset.advanced.parameters[1].defaultValue = 'huge';
    const nonfiniteJson = JSON.stringify(envelope).replace('"huge"', '1e309');
    expect(() => parsePresetShare(nonfiniteJson)).toThrow('快捷指令分享配置无效');
    expect(() => serializePresetShare({ ...advanced, advanced: { ...advanced.advanced!,
      parameters: [{ id: 'number', key: 'theme', label: '主题', type: 'number', defaultValue: Infinity }] } })).toThrow('快捷指令分享配置无效');
  });

  it.each(['https://example.invalid/image.png', 'file:///private/image.png', 'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,PHN2Zz4=', 'data:image/png;base64,invalid!'])('拒绝导入非便携或格式不符的缩略图 %s', (thumbnail) => {
    const envelope = JSON.parse(serializePresetShare(basic));
    envelope.preset.thumbnail = thumbnail;
    expect(() => parsePresetShare(JSON.stringify(envelope))).toThrow('快捷指令缩略图格式无效');
    expect(JSON.parse(serializePresetShare({ ...basic, thumbnail })).preset).not.toHaveProperty('thumbnail');
  });

  it('拒绝过长名称、过量步骤和非数组参数', () => {
    const envelope = JSON.parse(serializePresetShare(advanced));
    envelope.preset.name = 'x'.repeat(201);
    expect(() => parsePresetShare(JSON.stringify(envelope))).toThrow('快捷指令分享配置无效');
    envelope.preset.name = '产品图';
    envelope.preset.advanced.steps = Array.from({ length: 101 }, () => envelope.preset.advanced.steps[0]);
    expect(() => parsePresetShare(JSON.stringify(envelope))).toThrow('快捷指令分享配置无效');
    envelope.preset.advanced.steps = [envelope.preset.advanced.steps[0]];
    envelope.preset.advanced.parameters = {};
    expect(() => parsePresetShare(JSON.stringify(envelope))).toThrow('快捷指令分享配置无效');
  });

  it('全文上限按 UTF-8 字节计算，恰好 8 MiB 可读，超出拒绝', () => {
    const serialized = serializePresetShare(basic);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    const atLimit = serialized + ' '.repeat(MAX_JSON_FILE_BYTES - bytes);
    expect(parsePresetShare(atLimit).name).toBe('产品图');
    expect(() => parsePresetShare(atLimit + ' ')).toThrow('快捷指令 JSON 超过 8 MiB');
    const multibyte = serialized + '中'.repeat(Math.floor(MAX_JSON_FILE_BYTES / 3) + 1);
    expect(multibyte.length).toBeLessThan(MAX_JSON_FILE_BYTES);
    expect(() => parsePresetShare(multibyte)).toThrow('快捷指令 JSON 超过 8 MiB');
  });
});
