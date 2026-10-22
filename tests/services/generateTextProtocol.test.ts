import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from '../../src/services/ai/generateText';
import { useAppStore } from '../../src/store/useAppStore';
import { resolvePromptWithMediaRefs } from '../../src/services/ai/promptResolver';
import type { ModelExecutionProfile } from '../../src/types/aiTypes';

const jsonResponse = (payload: unknown) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('custom text model protocol', () => {
  it('does not start a request when its signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateText({ provider: 'general', model: 'general/text', prompt: '预演', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses the configured endpoint, request body and text result path', async () => {
    const executionProfile = {
      preset: 'custom',
      protocol: {
        version: 1,
        mode: 'sync',
        auth: { type: 'header', name: 'X-API-Key' },
        submit: {
          method: 'POST',
          path: '/v1/chat/',
          body: {
            model_name: '{{model}}',
            input: '{{prompt}}',
            messages: '{{messages}}',
          },
        },
        resultTextPath: 'result.answer',
      },
    } as unknown as ModelExecutionProfile;
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          'custom-text-provider': {
            name: '自定义文本连接',
            apiKey: 'secret',
            baseUrl: 'https://gateway.example',
            catalogId: 'custom-openai',
          },
        },
        generalModels: [{
          id: 'custom-text',
          name: '自定义文本',
          modelId: 'vendor-chat',
          category: 'text',
          providerConfigId: 'custom-text-provider',
          executionProfile,
        }],
      },
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ result: { answer: '自定义结果' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateText({
      provider: 'general',
      model: 'general/custom-text',
      prompt: '你好',
    });

    expect(result).toBe('自定义结果');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/chat/');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-API-Key': 'secret' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model_name: 'vendor-chat',
      input: '你好',
    });
  });

  it.each([
    {
      protocol: 'anthropic-compatible' as const,
      expectedUrl: 'https://gateway.example/v1/messages',
      response: { content: [{ type: 'text', text: 'Anthropic 结果' }] },
      expectedText: 'Anthropic 结果',
      expectedHeader: ['x-api-key', 'secret'],
      expectedBody: { model: 'vendor-chat', max_tokens: 4096, messages: [{ role: 'user' }] },
    },
    {
      protocol: 'gemini-native' as const,
      expectedUrl: 'https://gateway.example/v1/models/vendor-chat:generateContent',
      response: { candidates: [{ content: { parts: [{ text: 'Gemini 结果' }] } }] },
      expectedText: 'Gemini 结果',
      expectedHeader: ['x-goog-api-key', 'secret'],
      expectedBody: { contents: [{ role: 'user', parts: [{ text: '你好' }] }] },
    },
  ])('uses $protocol for non-stream text generation', async ({
    protocol,
    expectedUrl,
    response,
    expectedText,
    expectedHeader,
    expectedBody,
  }) => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          'native-text-provider': {
            name: '原生文本连接',
            apiKey: 'secret',
            baseUrl: 'https://gateway.example/v1',
            catalogId: 'custom-openai',
            chatApiProtocol: protocol,
          },
        },
        generalModels: [{
          id: 'native-text',
          name: '原生文本',
          modelId: 'vendor-chat',
          category: 'text',
          providerConfigId: 'native-text-provider',
        }],
      },
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateText({
      provider: 'general',
      model: 'general/native-text',
      prompt: '你好',
    })).resolves.toBe(expectedText);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedUrl);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ [expectedHeader[0]]: expectedHeader[1] });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject(expectedBody);
  });

  it.each([
    {
      preset: 'anthropic-chat' as const,
      expectedUrl: 'https://gateway.example/v1/messages',
      response: { content: [{ type: 'text', text: 'Claude 回复' }] },
      expectedHeader: 'x-api-key',
    },
    {
      preset: 'gemini-chat' as const,
      expectedUrl: 'https://gateway.example/v1/models/vendor-chat:generateContent',
      response: { candidates: [{ content: { parts: [{ text: 'Gemini 回复' }] } }] },
      expectedHeader: 'x-goog-api-key',
    },
  ])('lets a $preset model override the connection chat protocol', async ({
    preset, expectedUrl, response, expectedHeader,
  }) => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          'mixed-text-provider': {
            name: '混合文本连接', apiKey: 'secret', baseUrl: 'https://gateway.example/v1',
            catalogId: 'custom-openai', chatApiProtocol: 'openai-compatible',
          },
        },
        generalModels: [{
          id: 'mixed-text', name: '混合文本', modelId: 'vendor-chat',
          category: 'text', providerConfigId: 'mixed-text-provider',
          executionProfile: { preset },
        }],
      },
    }));
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateText({ provider: 'general', model: 'general/mixed-text', prompt: '你好' }))
      .resolves.toBe(preset === 'anthropic-chat' ? 'Claude 回复' : 'Gemini 回复');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedUrl);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ [expectedHeader]: 'secret' });
  });
});

describe('shared protocol asset references', () => {
  it('extracts local video and audio assets once and keeps their prompt reference indices', async () => {
    const result = await resolvePromptWithMediaRefs(
      '参考 @asset{references%2Fclip.mp4} 和 @asset{references%2Fvoice.mp3}，再次参考 @asset{references%2Fclip.mp4}',
    );
    expect(result.prompt).toBe('参考 视频1 和 音频1，再次参考 视频1');
    expect(result.videoUrls).toHaveLength(1);
    expect(result.audioUrls).toHaveLength(1);
    expect(result.references).toEqual([
      expect.objectContaining({ kind: 'video', origin: 'prompt', role: 'reference', filePath: 'references/clip.mp4' }),
      expect.objectContaining({ kind: 'audio', origin: 'prompt', role: 'reference_audio', filePath: 'references/voice.mp3' }),
    ]);
  });
});
