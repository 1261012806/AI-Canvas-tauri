import { describe, expect, it } from 'vitest';
import { importRunningHubDefinition, parseRunningHubId, parseRunningHubJson, resolveRunningHubParameters, runningHubFieldValue, validateRunningHubManifest } from '../../src/services/runninghubWorkflowService';
import { runningHubConnection, workflowExecution } from '../../src/services/workflowExecutionService';
import { RunningHubRequestError } from '../../src/services/ai/providers/runninghubClient';
import type { RunningHubWorkflowManifest } from '../../src/types/runninghub';

const options = { kind: 'workflow' as const, remoteId: '1904152026220003329', connectionId: 'runninghub' as const };
const graph = { '6': { class_type: 'CLIPTextEncode', inputs: { text: '猫', link: ['1', 0] }, _meta: { title: '正面提示词' } }, '3': { class_type: 'KSampler', inputs: { seed: 0, denoise: 0.5, enabled: false, api_key: 'do-not-save' } } };

describe('RunningHub 导入与参数合同', () => {
  it('保留官方数字形式的长 ID，并区分工作流与应用链接', () => {
    expect(parseRunningHubJson('{"webappId":1904152026220003329}')).toEqual({ webappId: options.remoteId });
    expect(parseRunningHubId(`https://www.runninghub.cn/workflow/${options.remoteId}?x=1`, 'workflow')).toBe(options.remoteId);
    expect(parseRunningHubId(`https://www.runninghub.ai/ai-detail/${options.remoteId}`, 'app')).toBe(options.remoteId);
    expect(() => parseRunningHubId('https://evil.test/workflow/123', 'workflow')).toThrow();
    expect(() => parseRunningHubId('https://www.runninghub.cn/ai-detail/123', 'workflow')).toThrow();
  });
  it('兼容带语言前缀的官方分享链接，保持长 ID 和导入类型', () => {
    const appId = '2108920489564520450';
    expect(parseRunningHubId(`https://www.runninghub.ai/zh-cn/ai-detail/${appId}`, 'app')).toBe(appId);
    expect(parseRunningHubId(`https://runninghub.ai/en/webapp/${appId}/?share=1#detail`, 'app')).toBe(appId);
    expect(parseRunningHubId(`https://www.runninghub.cn/zh-CN/workflow/${options.remoteId}`, 'workflow')).toBe(options.remoteId);
    expect(parseRunningHubId(appId, 'app')).toBe(appId);
    const manifest = importRunningHubDefinition('{"nodeInfoList":[]}', { ...options, kind: 'app', remoteId: `https://www.runninghub.ai/zh-cn/ai-detail/${appId}` });
    expect(manifest.remoteId).toBe(appId);
    expect(manifest.connectionId).toBe(options.connectionId);
  });
  it('语言前缀不允许绕过域名、资源类型、凭据及路径结构校验', () => {
    for (const invalid of [
      'https://evil.test/zh-cn/ai-detail/123',
      'https://www.runninghub.ai.evil.test/zh-cn/ai-detail/123',
      'https://user:secret@www.runninghub.ai/zh-cn/ai-detail/123',
      'https://www.runninghub.ai/zh-cn/workflow/123',
      'https://www.runninghub.ai/arbitrary/ai-detail/123',
      'https://www.runninghub.ai/zh-cn/en/ai-detail/123',
      'https://www.runninghub.ai/zh-cn/ai-detail/123/extra',
    ]) expect(() => parseRunningHubId(invalid, 'app')).toThrow('AI 应用');
    expect(() => parseRunningHubId('https://www.runninghub.ai/zh-cn/ai-detail/123', 'workflow')).toThrow('工作流');
  });
  it('901 业务失败显示应用不存在，同时保留 HTTP 与业务码', () => {
    const error = new RunningHubRequestError(901, 200);
    expect(error.message).toContain('AI 应用不存在');
    expect(error.message).toContain('业务码 901，HTTP 200');
    expect(error).toMatchObject({ code: 901, httpStatus: 200 });
  });
  it('读取 API graph 的标量，仅识别明确的主提示词，不保存鉴权字段', () => {
    const manifest = importRunningHubDefinition(JSON.stringify({ code: 0, data: { prompt: JSON.stringify(graph) } }), options);
    expect(manifest.parameters).toHaveLength(4);
    expect(manifest.parameters.find((field) => field.fieldName === 'text')).toMatchObject({ source: 'prompt', label: '正面提示词 · text', defaultValue: '猫' });
    expect(manifest.parameters.find((field) => field.fieldName === 'enabled')?.defaultValue).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain('do-not-save');
  });
  it('新导入和旧定义共享唯一主提示词识别，排除负面与辅助文本，不修改原对象', () => {
    const imported = importRunningHubDefinition(JSON.stringify({ nodeInfoList: [
      { nodeId: '1', fieldName: 'prompt', fieldValue: '导入示例', description: '提示词' },
      { nodeId: '2', fieldName: 'negative_prompt', fieldValue: '保留负面' },
      { nodeId: '3', fieldName: 'text', fieldValue: '保留系统', description: '系统提示词' },
      { nodeId: '4', fieldName: 'style_prompt', fieldValue: '保留风格' },
    ] }), options);
    expect(imported.parameters.map((field) => field.source)).toEqual(['prompt', 'value', 'value', 'value']);
    const legacy = imported.parameters.map((field) => ({ ...field, source: 'value' as const }));
    expect(resolveRunningHubParameters(legacy)[0].source).toBe('prompt');
    expect(legacy[0].source).toBe('value');
  });
  it('尊重显式来源、枚举及多候选的歧义，不把固定提示词自动替换', () => {
    const field = { nodeId: '1', fieldName: 'prompt', label: '提示词', type: 'string' as const, defaultValue: '固定', source: 'value' as const };
    expect(resolveRunningHubParameters([{ ...field, sourceExplicit: true }])[0].source).toBe('value');
    expect(resolveRunningHubParameters([{ ...field, options: ['固定'] }])[0].source).toBe('value');
    for (const fieldName of ['neg_prompt', 'negPrompt', 'negative_prompt']) {
      expect(resolveRunningHubParameters([{ ...field, fieldName }])[0].source).toBe('value');
    }
    expect(resolveRunningHubParameters([field, { ...field, nodeId: '2' }]).map((item) => item.source)).toEqual(['value', 'value']);
    expect(resolveRunningHubParameters([field, { ...field, nodeId: '2', source: 'prompt' }]).map((item) => item.source)).toEqual(['value', 'prompt']);
    expect(() => validateRunningHubManifest({ version: 1, ...options, parameters: [{ ...field, sourceExplicit: true }] })).not.toThrow();
    expect(() => validateRunningHubManifest({ version: 1, ...options, parameters: [{ ...field, sourceExplicit: 'true' }] } as unknown as RunningHubWorkflowManifest)).toThrow();
  });
  it('静态解析 curl 请求体，保留 nodeInfoList 数值与布尔类型', () => {
    const input = `curl https://www.runninghub.cn/task/openapi/ai-app/run -H 'Authorization: Bearer secret' --data '{"apiKey":"secret","webappId":1904152026220003329,"nodeInfoList":[{"nodeId":"6","fieldName":"count","fieldType":"INT","fieldValue":"0"},{"nodeId":"7","fieldName":"enabled","fieldType":"BOOLEAN","fieldValue":false}]}'`;
    const result = importRunningHubDefinition(input, { ...options, kind: 'app', remoteId: '' });
    expect(result.remoteId).toBe(options.remoteId);
    expect(result.parameters.map((field) => field.defaultValue)).toEqual([0, false]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('只从类型匹配的 ComfyUI tuple 保留数值范围、控件步进和多行声明', () => {
    const result = importRunningHubDefinition(JSON.stringify({ nodeInfoList: [
      { nodeId: '1', fieldName: 'duration', fieldType: 'INT', fieldData: '["INT",{"default":12,"min":1,"max":60}]' },
      { nodeId: '2', fieldName: 'resolution', fieldType: 'FLOAT', fieldValue: '1.5', fieldData: '["FLOAT",{"default":1,"min":0.5,"max":3,"step":0.25}]' },
      { nodeId: '3', fieldName: 'text', fieldType: 'STRING', fieldData: '["STRING",{"default":"第一行\\n第二行","multiline":true}]' },
    ] }), options);
    expect(result.parameters).toMatchObject([
      { type: 'number', defaultValue: 12, min: 1, max: 60, step: 1 },
      { type: 'number', defaultValue: 1.5, min: 0.5, max: 3, step: 0.25 },
      { type: 'string', defaultValue: '第一行\n第二行', multiline: true },
    ]);
  });
  it('缺少 fieldType 时仅用已知 tuple 类型推断，不给 FLOAT 创造范围或步进', () => {
    const result = importRunningHubDefinition(JSON.stringify({ nodeInfoList: [
      { nodeId: '1', fieldName: 'resolution', fieldValue: '1.5', fieldData: '["FLOAT",{"default":1.5}]' },
      { nodeId: '2', fieldName: 'text', fieldValue: '短文本', fieldData: ['STRING', { multiline: false }] },
    ] }), options);
    expect(result.parameters[0]).toMatchObject({ type: 'number', defaultValue: 1.5 });
    expect(result.parameters[0].min).toBeUndefined();
    expect(result.parameters[0].max).toBeUndefined();
    expect(result.parameters[0].step).toBeUndefined();
    expect(result.parameters[1]).toMatchObject({ type: 'string', defaultValue: '短文本', multiline: false });
  });
  it('不从类型冲突、未知对象或无效标量中提取参数约束', () => {
    const result = importRunningHubDefinition(JSON.stringify({ nodeInfoList: [
      { nodeId: '1', fieldName: 'ratio', fieldType: 'STRING', fieldValue: '16:9 (Widescreen)', fieldData: ['FLOAT', { default: 9, min: 1, max: 10, step: 1, multiline: true }] },
      { nodeId: '2', fieldName: 'resolution', fieldValue: 1.5, fieldData: { min: 1, max: 10, step: 1 } },
      { nodeId: '3', fieldName: 'scale', fieldType: 'FLOAT', fieldValue: 1.5, fieldData: ['FLOAT', { min: '0', max: null, step: 0, apiKey: 'must-not-persist' }] },
      { nodeId: '4', fieldName: 'text', fieldValue: '原值', fieldData: ['STRING', { multiline: 'true' }] },
      { nodeId: '5', fieldName: 'count', fieldValue: 2, fieldData: ['INT', { min: 1, max: 5, step: 1 }, {}] },
      { nodeId: '6', fieldName: 'factor', fieldValue: 2, fieldData: [['INT'], { min: 1, max: 5, step: 1 }] },
    ] }), options);
    expect(result.parameters[0]).toMatchObject({ type: 'string', defaultValue: '16:9 (Widescreen)' });
    for (const field of result.parameters) {
      expect(field.min).toBeUndefined();
      expect(field.max).toBeUndefined();
      expect(field.step).toBeUndefined();
      expect(field.multiline).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain('must-not-persist');
  });
  it('新展示字段验证类型与范围，字符串切换素材或提示词绑定仍可保留多行声明', () => {
    const fields = importRunningHubDefinition(JSON.stringify(graph), options).parameters;
    const numeric = fields.find((field) => field.fieldName === 'seed')!;
    const text = fields.find((field) => field.fieldName === 'text')!;
    const manifest = { version: 1 as const, ...options, parameters: [numeric] };
    for (const metadata of [
      { min: '1' }, { max: Infinity }, { step: 0 }, { step: -1 }, { step: NaN },
      { min: 2, max: 1 }, { min: 1 }, { max: -1 }, { multiline: true },
    ]) expect(() => validateRunningHubManifest({ ...manifest, parameters: [{ ...numeric, ...metadata }] } as unknown as RunningHubWorkflowManifest)).toThrow('范围');
    expect(() => validateRunningHubManifest({ ...manifest, parameters: [{ ...text, min: 0 }] })).toThrow('范围');
    expect(() => validateRunningHubManifest({ ...manifest, parameters: [{ ...text, multiline: 'true' }] } as unknown as RunningHubWorkflowManifest)).toThrow('范围');
    for (const source of ['value', 'prompt', 'image', 'video', 'audio'] as const) {
      expect(() => validateRunningHubManifest({ ...manifest, parameters: [{ ...text, source, multiline: true }] })).not.toThrow();
    }
    expect(() => validateRunningHubManifest({ ...manifest, parameters: [{ ...numeric, source: 'image', min: 0 }] })).toThrow('素材映射');
  });
  it('执行时只验证声明范围，控件步进不新增取整或倍数限制', () => {
    const numeric = importRunningHubDefinition(JSON.stringify(graph), options).parameters.find((field) => field.fieldName === 'denoise')!;
    const field = { ...numeric, defaultValue: 1.5, min: 1, max: 2, step: 0.5 };
    expect(runningHubFieldValue(field)).toBe(1.5);
    expect(runningHubFieldValue(field, '1.6')).toBe(1.6);
    expect(() => runningHubFieldValue(field, '0.9')).toThrow('范围');
    expect(() => runningHubFieldValue(field, '2.1')).toThrow('范围');
  });
  it('兼容没有新元数据的旧定义，枚举保留精确原值与原字段身份', () => {
    const legacy = importRunningHubDefinition(JSON.stringify(graph), options);
    expect(() => validateRunningHubManifest(legacy)).not.toThrow();
    for (const field of legacy.parameters) {
      expect(field.min).toBeUndefined();
      expect(field.max).toBeUndefined();
      expect(field.step).toBeUndefined();
      expect(field.multiline).toBeUndefined();
    }
    const result = importRunningHubDefinition(JSON.stringify({ nodeInfoList: [{
      nodeId: '37', fieldName: 'aspect_ratio', fieldType: 'LIST', fieldValue: '16:9 (Widescreen)',
      fieldData: [{ name: '宽屏', index: '16:9 (Widescreen)' }, { name: '方形', index: '1:1 (Square)' }, { default: '16:9 (Widescreen)' }],
    }] }), options);
    expect(result.parameters[0]).toMatchObject({ nodeId: '37', fieldName: 'aspect_ratio', options: ['16:9 (Widescreen)', '1:1 (Square)'] });
    expect(runningHubFieldValue(result.parameters[0], '16:9 (Widescreen)')).toBe('16:9 (Widescreen)');
    expect(() => runningHubFieldValue(result.parameters[0], '16:9')).toThrow('选项');
  });
  it('读取标量列表和 ComfyUI 枚举 tuple，保留实际顺序与精确值', () => {
    const result = importRunningHubDefinition(JSON.stringify({ nodeInfoList: [
      { nodeId: '1', fieldName: 'scheduler', fieldType: 'LIST', fieldValue: 'simple', fieldData: JSON.stringify(['simple', 'sgm_uniform', 'karras', 'beta']) },
      { nodeId: '2', fieldName: 'aspect_ratio', fieldType: 'LIST', fieldData: [['16:9 (Widescreen)', '9:16 (Portrait)'], { default: '9:16 (Portrait)' }] },
      { nodeId: '3', fieldName: 'count', fieldValue: 0, fieldData: [0, 1, 2] },
      { nodeId: '4', fieldName: 'enabled', fieldValue: false, fieldData: [[true, false], { default: true }] },
    ] }), options);
    expect(result.parameters[0].options).toEqual(['simple', 'sgm_uniform', 'karras', 'beta']);
    expect(result.parameters[1]).toMatchObject({ defaultValue: '9:16 (Portrait)', options: ['16:9 (Widescreen)', '9:16 (Portrait)'] });
    expect(result.parameters[2]).toMatchObject({ type: 'number', defaultValue: 0, options: [0, 1, 2] });
    expect(result.parameters[3]).toMatchObject({ type: 'boolean', defaultValue: false, options: [true, false] });
    expect(runningHubFieldValue(result.parameters[0], 'sgm_uniform')).toBe('sgm_uniform');
    expect(() => runningHubFieldValue(result.parameters[0], 'normal')).toThrow('选项');
  });
  it('枚举 tuple 不改写显式旧值，不从混合或类型不符的数据补造选项', () => {
    const result = importRunningHubDefinition(JSON.stringify({ nodeInfoList: [
      { nodeId: '1', fieldName: 'scheduler', fieldValue: 'old_custom', fieldData: [['simple', 'karras'], { default: 'simple' }] },
      { nodeId: '2', fieldName: 'scheduler', fieldValue: 'simple', fieldData: ['simple', { unrelated: true }] },
      { nodeId: '3', fieldName: 'factor', fieldValue: 2, fieldData: [['INT'], { min: 1, max: 5 }] },
      { nodeId: '4', fieldName: 'text', fieldValue: 'text', fieldData: ['STRING', { multiline: true }] },
    ] }), options);
    expect(result.parameters[0]).toMatchObject({ defaultValue: 'old_custom', options: ['simple', 'karras'] });
    for (const field of result.parameters.slice(1)) expect(field.options).toBeUndefined();
    expect(result.parameters[3].multiline).toBe(true);
  });
  it('识别确定的媒体节点且保留各类型顺序与上传格式', () => {
    const result = importRunningHubDefinition(JSON.stringify({ a: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, b: { class_type: 'LoadImageFromUrl', inputs: { image: 'https://cdn.test/b.png' } }, c: { class_type: 'LoadAudio', inputs: { audio: 'a.wav' } } }), options);
    expect(result.parameters).toMatchObject([{ source: 'image', referenceIndex: 0, mediaFormat: 'filename' }, { source: 'image', referenceIndex: 1, mediaFormat: 'url' }, { source: 'audio', referenceIndex: 0 }]);
  });
  it('拒绝 UI graph、超长定义、额外密钥、重复参数和本地路径', () => {
    expect(() => importRunningHubDefinition('{"nodes":[]}', options)).toThrow('API');
    expect(() => parseRunningHubJson(' '.repeat(1_500_001))).toThrow('限制');
    const manifest = importRunningHubDefinition(JSON.stringify(graph), options);
    expect(() => validateRunningHubManifest({ ...manifest, apiKey: 'secret' } as RunningHubWorkflowManifest)).toThrow();
    expect(() => validateRunningHubManifest({ ...manifest, parameters: [manifest.parameters[0], manifest.parameters[0]] })).toThrow('重复');
    expect(() => validateRunningHubManifest({ ...manifest, parameters: [{ ...manifest.parameters[0], type: 'string', defaultValue: 'G:\\private\\input.png' }] })).toThrow('本地');
  });
  it('空数字不变成零，false 不变成 true，枚举按真实类型校验', () => {
    const fields = importRunningHubDefinition(JSON.stringify(graph), options).parameters;
    const seed = fields.find((field) => field.fieldName === 'seed')!;
    const enabled = fields.find((field) => field.fieldName === 'enabled')!;
    expect(runningHubFieldValue(seed, '0')).toBe(0);
    expect(runningHubFieldValue(enabled, 'false')).toBe(false);
    expect(() => runningHubFieldValue(seed, '')).toThrow('数字');
    expect(() => runningHubFieldValue({ ...seed, options: [1, 2] }, '3')).toThrow('选项');
  });
  it('旧记录按 ComfyUI 执行，云连接必须使用其指定密钥', () => {
    const wf = { id: 'local', name: '旧工作流', category: 'ai-image' as const, fileContent: '{}', fileName: 'a.json', createdAt: 1 };
    expect(workflowExecution(wf)).toMatchObject({ provider: 'comfyui', model: 'comfyui/workflow' });
    expect(workflowExecution({ ...wf, adapterType: 'runninghub', runninghub: { version: 1, ...options, parameters: [] } })).toMatchObject({ provider: 'runninghubwf', model: 'runninghubwf/local' });
    expect(runningHubConnection({ runninghub: { name: 'RH', apiKey: 'secret', baseUrl: 'https://www.runninghub.cn/openapi/v2' } }, 'runninghub').baseUrl).toBe('https://www.runninghub.cn');
    const connections = {
      runninghub: { name: '国际工作流', apiKey: 'workflow-secret', baseUrl: 'https://www.runninghub.ai/openapi/v2' },
      'runninghub-model': { name: '国内模型', apiKey: 'model-secret', baseUrl: 'https://www.runninghub.cn/openapi/v2' },
    };
    expect(runningHubConnection(connections, 'runninghub')).toEqual({ apiKey: 'workflow-secret', baseUrl: 'https://www.runninghub.ai' });
    expect(runningHubConnection(connections, 'runninghub-model')).toEqual({ apiKey: 'model-secret', baseUrl: 'https://www.runninghub.cn' });
    expect(() => runningHubConnection({ runninghub: { name: 'RH', apiKey: 'secret' } }, 'runninghub-model')).toThrow('模型');
  });
});
