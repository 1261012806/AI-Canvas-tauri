import { describe, expect, it } from 'vitest';
import { getCustomConnectionReadiness, shouldListProviderConnection } from '../../src/components/settings/apiKeySettingsUtils';

describe('API Key 设置连接列表', () => {
  it('显示 Agent 保存但尚未填写密钥的自定义连接', () => {
    expect(shouldListProviderConnection({
      apiKey: '',
      catalogId: 'custom-openai',
    }, 'api-key')).toBe(true);
  });

  it('继续隐藏没有密钥的内置连接', () => {
    expect(shouldListProviderConnection({
      apiKey: '',
      catalogId: 'apimart',
    }, 'api-key')).toBe(false);
  });

  it('只配置工作流 Key 时显示 RunningHub 连接，不显示无关厂商', () => {
    expect(shouldListProviderConnection({
      apiKey: '',
      catalogId: 'runninghub-model',
    }, 'api-key', 'workflow-key')).toBe(true);
    expect(shouldListProviderConnection({
      apiKey: '',
      catalogId: 'runninghub-model',
    }, 'api-key')).toBe(false);
    expect(shouldListProviderConnection({
      apiKey: '',
      catalogId: 'apimart',
    }, 'api-key', 'workflow-key')).toBe(false);
  });

  it('显示已有密钥或使用 OAuth 的连接', () => {
    expect(shouldListProviderConnection({
      apiKey: 'configured',
      catalogId: 'custom-openai',
    }, 'api-key')).toBe(true);
    expect(shouldListProviderConnection({
      apiKey: '',
      catalogId: 'dreamina',
    }, 'oauth')).toBe(true);
  });
  it('当前站点为空时仍保留 RunningHub 入口，允许切回另一套已保存密钥', () => {
    expect(shouldListProviderConnection({ apiKey: '', catalogId: 'runninghub-model', runninghubSiteCredentials: true }, 'api-key')).toBe(true);
  });

  it('未配置媒体协议显示待配置，能力留空不会变成配置错误', () => {
    expect(getCustomConnectionReadiness([])).toBe('pending');
    expect(getCustomConnectionReadiness([{ id: 'v', name: '视频', category: 'video', provider: '', videoCapability: {} }])).toBe('pending');
  });

  it('本地校验区分合法协议与结果类别不符，不依赖是否填写密钥', () => {
    const video = { id: 'v', name: '视频', category: 'video' as const, provider: '' };
    expect(getCustomConnectionReadiness([{ ...video, executionProfile: { preset: 'custom', protocol: {
      version: 2, mode: 'sync', submit: { method: 'POST', path: '/generate' }, response: { type: 'json', result: { urlPath: 'url' } },
    } } }])).toBe('ready');
    expect(getCustomConnectionReadiness([{ ...video, executionProfile: { preset: 'openai-chat' } }])).toBe('invalid');
    expect(getCustomConnectionReadiness([{ id: 't', name: '文本', category: 'text', provider: '' }])).toBe('ready');
  });
});
