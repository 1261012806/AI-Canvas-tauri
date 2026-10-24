import { describe, expect, it } from 'vitest';
import { assertProviderModelsVideoCapabilities, materializeLegacyImageProtocolDefault, mergeModels } from '../../src/components/settings/providerConnection/providerConnectionModels';
import { assertModelProtocolResult } from '../../src/services/ai/modelCapabilityValidation';
import type { ModelExecutionProtocol, ModelProtocolPresetId } from '../../src/types/aiTypes';
import type { GeneralModelCategory, ProviderModelSelection } from '../../src/types';
import { LIBAPI_MODEL_MANIFEST } from '../../src/services/ai/providers/libapiModelManifest';

it('preserves configured image tiers and video limits when refreshing a raw catalog', () => {
  const configured = [
    { id: 'image', name: 'Image', category: 'image' as const, provider: 'custom', imageCapability: { resolutions: ['1K'], maxBatchCount: 2 } },
    { id: 'video', name: 'Video', category: 'video' as const, provider: 'custom', videoCapability: { minDuration: 4, maxDuration: 30 } },
  ];
  const refreshed = mergeModels(configured, configured.map(({ id, category, provider }) => ({ id, name: id, category, provider,
    imageCapability: undefined, videoCapability: undefined })));
  expect(refreshed[0].imageCapability).toEqual(configured[0].imageCapability);
  expect(refreshed[1].videoCapability).toEqual(configured[1].videoCapability);
});

it('LibAPI 刷新目录保留当前连接的显式协议和能力，不借用同名其他厂商合同', () => {
  const catalog = structuredClone(LIBAPI_MODEL_MANIFEST.find((model) => model.id === 'gt-image-2.5-flare')!);
  const configured: ProviderModelSelection = { ...catalog, provider: 'libapi',
    imageCapability: { resolutions: ['1K'] },
    executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
      submit: { method: 'POST', path: '/user/images', body: { prompt: '{{prompt}}' } },
      response: { type: 'json', result: { urlPath: 'output' } },
    } },
  };
  const original = JSON.stringify(configured);
  const refreshed = mergeModels([configured], [{ ...catalog, provider: 'libapi' }]);
  expect(refreshed[0].executionProfile).toEqual(configured.executionProfile);
  expect(refreshed[0].imageCapability).toEqual({ resolutions: ['1K'] });
  expect(refreshed[0].provider).toBe('libapi');
  expect(JSON.stringify(configured)).toBe(original);
  const other: ProviderModelSelection = { ...configured, provider: 'other-relay', executionProfile: { preset: 'openai-gpt-image' } };
  expect(mergeModels([other], [{ id: other.id, name: other.name, category: other.category, provider: 'other-relay' }])[0].executionProfile)
    .toEqual({ preset: 'openai-gpt-image' });
});

describe('legacy connection image protocol', () => {
  it('copies a saved connection default only to selected image models without overrides', () => {
    const models = materializeLegacyImageProtocolDefault([
      { id: 'image-a', name: '图片 A', category: 'image', provider: 'gateway' },
      { id: 'image-b', name: '图片 B', category: 'image', provider: 'gateway',
        executionProfile: { preset: 'openai-gpt-image' },
        imageReferenceRequestMode: 'edits-multipart' },
      { id: 'text-a', name: '文本 A', category: 'text', provider: 'gateway' },
    ], {
      imageProtocolDefault: { preset: 'gpt-image-gateway-json' },
      imageReferenceRequestModeDefault: 'generation-json-image-data-urls',
    });
    expect(models[0]).toMatchObject({
      executionProfile: { preset: 'gpt-image-gateway-json' },
      imageReferenceRequestMode: 'generation-json-image-data-urls',
    });
    expect(models[1]).toMatchObject({
      executionProfile: { preset: 'openai-gpt-image' },
      imageReferenceRequestMode: 'edits-multipart',
    });
    expect(models[2].executionProfile).toBeUndefined();
  });
});

describe('自定义模型结果合同', () => {
  const validate = (category: GeneralModelCategory, protocol: ModelExecutionProtocol) => assertProviderModelsVideoCapabilities([
    { id: 'fixture', name: '测试模型', category, provider: '', executionProfile: { preset: 'custom', protocol } },
  ]);
  const submit = { method: 'POST' as const, path: '/generate' };

  it('保存视频文本结果映射时准确报告结果位置，未声明可选能力仍允许保存', () => {
    expect(() => validate('video', { version: 2, mode: 'sync', submit,
      response: { type: 'json', result: { textPath: 'prompt' } } })).toThrow('response.result');
    expect(() => validate('video', { version: 2, mode: 'sync', submit,
      response: { type: 'json', result: { urlPath: 'output' } } })).not.toThrow();
    expect(() => assertProviderModelsVideoCapabilities([
      { id: 'pending', name: '待配置', category: 'video', provider: '' },
    ])).not.toThrow();
  });

  it('接受 Base64、同步二进制和异步下载，不从 URL 后缀猜媒体类型', () => {
    expect(() => validate('image', { version: 2, mode: 'sync', submit,
      response: { type: 'json', result: { base64Path: 'image', mimeType: 'image/png' } } })).not.toThrow();
    expect(() => validate('audio', { version: 2, mode: 'sync', submit,
      response: { type: 'binary', result: { mimeType: 'audio/mpeg' } } })).not.toThrow();
    expect(() => validate('video', { version: 2, mode: 'async', submit, response: { type: 'json', taskIdPath: 'id' },
      poll: { method: 'GET', path: '/tasks/{{submit.id}}', response: { statusPath: 'status', successValues: ['completed'],
        failureValues: ['failed'], result: { download: { method: 'GET', path: '/tasks/{{submit.id}}/content' }, mimeType: 'video/mp4' } } } })).not.toThrow();
    expect(() => assertModelProtocolResult('video', { urls: ['https://example.test/signed-download?token=fixture'] })).not.toThrow();
  });

  it('声明的 MIME 类型、原生文本预设和未知预设不能冒充媒体协议', () => {
    expect(() => validate('video', { version: 2, mode: 'sync', submit,
      response: { type: 'json', result: { urlPath: 'output', mimeType: 'image/png' } } })).toThrow('mimeType');
    expect(() => validate('text', { version: 2, mode: 'sync', submit,
      response: { type: 'json', result: { urlPath: 'output' } } })).toThrow('文本模型');
    for (const preset of ['openai-chat', 'anthropic-chat', 'future-preset']) {
      expect(() => assertProviderModelsVideoCapabilities([{ id: 'v', name: '视频', category: 'video', provider: '',
        executionProfile: { preset: preset as ModelProtocolPresetId } }])).toThrow();
    }
  });

  it('真实试跑必须得到当前类别的非空结果，返回文本不能算视频成功', () => {
    expect(() => assertModelProtocolResult('video', { text: 'enhanced prompt' })).toThrow('没有解析出有效媒体结果地址');
    expect(() => assertModelProtocolResult('image', { urls: [] })).toThrow('有效媒体结果地址');
    expect(() => assertModelProtocolResult('text', { urls: ['https://example.test/result'] })).toThrow('文本');
    expect(() => assertModelProtocolResult('text', { text: '   ' })).toThrow('文本');
    expect(() => assertModelProtocolResult('text', { text: '完成' })).not.toThrow();
  });

  it('实际返回文本、带凭据 URL、JSON 二进制或错误媒体 MIME 不能算媒体试跑成功', () => {
    for (const url of ['enhanced prompt', 'file:///private/video.mp4', 'https://user:password@example.test/video',
      'javascript:alert(1)', 'data:application/json;base64,e30=', 'data:image/png;base64,aW1hZ2U=']) {
      expect(() => assertModelProtocolResult('video', { urls: [url] })).toThrow();
    }
    expect(() => assertModelProtocolResult('video', { urls: ['data:video/mp4;base64,dmlkZW8='] })).not.toThrow();
    expect(() => assertModelProtocolResult('image', { urls: ['data:image/png;base64,aW1hZ2U='] })).not.toThrow();
    expect(() => assertModelProtocolResult('audio', { urls: ['data:audio/wav;base64,YXVkaW8='] })).not.toThrow();
    expect(() => assertModelProtocolResult('video', { urls: ['https://example.test/result.png?signature=fixture'] })).not.toThrow();
    expect(() => assertModelProtocolResult('video', { urls: ['https://example.test/result', 'not a URL'] })).toThrow();
  });
});
