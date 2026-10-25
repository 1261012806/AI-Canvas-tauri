import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  corsSafeFetch: vi.fn(),
}));

vi.mock('../../src/services/ai/httpTransport', () => transportMocks);

import { streamAssistantReply } from '../../src/services/ai/assistantStream';
import { generateImagesBatch } from '../../src/services/ai/generateImage';
import { generateText } from '../../src/services/ai/generateText';
import { reversePromptAndTags } from '../../src/services/ai/reversePrompt';
import { generateVideo } from '../../src/services/ai/generateVideo';
import { generateAudio } from '../../src/services/ai/generateAudio';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import VideoParamSelector from '../../src/components/nodes/shared/VideoParamSelector';
import { parseResponseError } from '../../src/services/ai/httpUtils';
import { resolveImageDataUrlArray } from '../../src/services/ai/imageUtils';
import { getProviderDefinition } from '../../src/services/ai/providerCatalogService';
import { generateImageStandard } from '../../src/services/ai/providers/standardImage';
import { analyzeModelProtocolExamples } from '../../src/services/ai/modelProtocolImport';
import { useAppStore } from '../../src/store/useAppStore';
import { createImageQuickAdaptTemplate } from '../../src/services/ai/imageModelTemplates';
import { uploadToRemote } from '../../src/services/uploadService';
import { getPendingTasksForProject } from '../../src/services/pollManager';
import { LIBAPI_MODEL_MANIFEST } from '../../src/services/ai/providers/libapiModelManifest';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  transportMocks.corsSafeFetch.mockReset();
  useAppStore.setState(useAppStore.getInitialState(), true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CCC 图片异步任务与旧同步响应', () => {
  it.each([undefined, ''])('omits background and output format when CCC background is left at interface default (%s)', async (imageBackground) => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { cccapi: { name: 'CCC', apiKey: 'fixture', baseUrl: 'https://cccapi.cn/v1' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/image.png' }] }));
    await generateImagesBatch({ provider: 'cccapi', model: 'cccapi/gpt-image-2.5-sunburst',
      prompt: 'landscape', imageBackground }, 1);
    const body = JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('background');
    expect(body).not.toHaveProperty('output_format');
  });
  it('passes selected CCC quality through JSON and multipart without affecting resolution', async () => {
    useAppStore.getState().saveProviderConfig('ccc-quality', {
      name: 'CCC', catalogId: 'cccapi', apiKey: 'fixture', baseUrl: 'https://cccapi.cn/v1',
      selectedModels: [{ id: 'gpt-image-2.5-sunburst', name: 'Sunburst', category: 'image', provider: 'ccc-quality' }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'ccc-quality')!;
    const params = { provider: 'general', model: `general/${model.id}`, prompt: 'landscape',
      imageSize: '2K', aspectRatio: '16:9', imageQuality: 'max', imageBackground: 'transparent' };
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ data: [{ url: 'https://cdn.example/image.png' }] }));
    await generateImagesBatch(params, 1);
    expect(JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body)).toMatchObject({
      quality: 'max', size: '3648x2048', background: 'transparent', output_format: 'png',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('reference', { headers: { 'Content-Type': 'image/png' } }));
    await generateImagesBatch({ ...params, image_urls: ['asset://localhost/ref.png'], imageQuality: 'low' }, 1);
    const form = transportMocks.corsSafeFetch.mock.calls[1][1].body as FormData;
    expect(form.get('quality')).toBe('low');
    expect(form.get('background')).toBe('transparent');
    expect(form.get('output_format')).toBe('png');
    expect(form.get('size')).toBe('3648x2048');
    expect(form.getAll('image[]')).toHaveLength(1);
  });

  it('omits quality for a CCC model without documented support', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { cccapi: { name: 'CCC', apiKey: 'fixture', baseUrl: 'https://cccapi.cn/v1' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/image.png' }] }));
    await generateImagesBatch({ provider: 'cccapi', model: 'cccapi/gpt-image-2', prompt: 'landscape',
      imageQuality: 'max', imageBackground: 'transparent' }, 1);
    const body = JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('quality');
    expect(body).not.toHaveProperty('background');
    expect(body).not.toHaveProperty('output_format');
  });
  function configureCcc() {
    useAppStore.getState().saveProviderConfig('cccapi-discount', {
      name: 'CCC', catalogId: 'cccapi', cccGroup: 'discount', apiKey: 'discount-fixture', baseUrl: 'https://cccapi.cn/v1',
      selectedModels: [{ id: 'gpt-image-2', name: 'GPT Image 2', category: 'image', provider: 'cccapi-discount' }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'cccapi-discount')!;
    useAppStore.setState({ currentProjectId: 'ccc-project', nodes: [{ id: 'ccc-image', type: 'ai-image',
      position: { x: 0, y: 0 }, data: { type: 'ai-image', label: 'CCC', status: 'loading', prompt: '风景' } }] });
    return { provider: 'general', model: `general/${model.id}`, nodeId: 'ccc-image', prompt: '风景', imageSize: '4K' };
  }

  it('保存真实任务 ID，并用同一分组 Key 查询全部结果后等待交付确认', async () => {
    const params = configureCcc();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ code: 200, data: [{ status: 'submitted', task_id: 'ccc-task' }] }))
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: { id: 'ccc-task', status: 'completed', progress: 100,
        result: { images: [{ url: ['https://cdn.example/one.png', 'https://cdn.example/two.png'] }] } } }));
    const result = await generateImagesBatch(params, 2);
    expect(result.results.map((item) => item.url)).toEqual(['https://cdn.example/one.png', 'https://cdn.example/two.png']);
    expect(result.taskReceipt).toMatchObject({ projectId: 'ccc-project', nodeId: 'ccc-image', taskId: 'ccc-task' });
    expect(result.allTasksSettled).toBe(true);
    const task = getPendingTasksForProject('ccc-project')[0];
    expect(task).toMatchObject({ taskId: 'ccc-task', providerConfigId: 'cccapi-discount', submitted: true, mediaRecoveryState: 'delivery_pending' });
    expect(JSON.stringify(task)).not.toContain('discount-fixture');
    expect(transportMocks.corsSafeFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://cccapi.cn/v1/images/generations', 'https://cccapi.cn/v1/tasks/ccc-task',
    ]);
    expect(transportMocks.corsSafeFetch.mock.calls[1][1].headers).toMatchObject({ Authorization: 'Bearer discount-fixture' });
  });

  it('原任务只返回部分图片时不补交新生成，旧同步结果仍可接收', async () => {
    const params = configureCcc();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/legacy.png' }] }));
    const result = await generateImagesBatch(params, 2);
    expect(result.results).toHaveLength(1);
    expect(result.failedCount).toBe(1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(getPendingTasksForProject('ccc-project')).toEqual([]);
  });

  it('查询被拒绝保留可恢复记录，且不会重发提交', async () => {
    const params = configureCcc();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'retained-task' }] }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Key 权限已变化' } }), { status: 401 }));
    await expect(generateImagesBatch(params, 1)).rejects.toMatchObject({
      name: 'MediaTaskPausedError', taskReceipt: { taskId: 'retained-task' },
    });
    expect(getPendingTasksForProject('ccc-project')[0]).toMatchObject({ taskId: 'retained-task', submitted: true });
    expect(transportMocks.corsSafeFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each([404, 200])('CCC 本地参考图准备失败（HTTP %s）时不提交或保留空任务', async (status) => {
    const params = configureCcc();
    const referenceUrl = 'asset://localhost/reference.png';
    const localFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
    await expect(generateImagesBatch({ ...params, image_urls: [referenceUrl] }, 1))
      .rejects.toThrow(status === 404 ? '读取参考图 1 失败 (404)' : '参考图 1 内容为空');
    expect(localFetch).toHaveBeenCalledWith(referenceUrl, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(getPendingTasksForProject('ccc-project')).toEqual([]);
  });

  it('CCC 准备参考图期间取消时不提交或保留状态未知任务', async () => {
    const params = configureCcc();
    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('请求已取消', 'AbortError');
    });
    await expect(generateImagesBatch({ ...params, image_urls: ['asset://localhost/reference.png'] }, 1, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(getPendingTasksForProject('ccc-project')).toEqual([]);
  });

  it('CCC 生成 POST 已发出后断网仍保留提交状态未知，不重发', async () => {
    const params = configureCcc();
    transportMocks.corsSafeFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(generateImagesBatch(params, 1)).rejects.toMatchObject({
      name: 'MediaTaskPausedError', reason: 'submit_unknown', taskReceipt: { taskId: '' },
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith(
      'https://cccapi.cn/v1/images/generations', expect.objectContaining({ method: 'POST' }),
    );
    expect(getPendingTasksForProject('ccc-project')).toEqual([expect.objectContaining({
      taskId: '', submitted: false, mediaRecoveryState: 'submit_unknown',
    })]);
  });

  it('自定义兼容接口不会仅因出现 task_id 就猜测 CCC 的查询路径', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'unknown-provider-task' }] }));
    await expect(generateImageStandard({ apiKey: 'fixture', baseUrl: 'https://custom.example/v1', modelName: 'gpt-image-2',
      prompt: '风景', dimensions: { width: 1024, height: 1024 } })).rejects.toThrow('结果为空');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('ToAPIs 参考素材上传与图片提交', () => {
  function configure(id = 'gpt-image-2', baseUrl = 'https://toapis.cn/v1', apiKey = 'toapis-fixture') {
    const selected = getProviderDefinition('toapis')!.models!.find((model) => model.id === id)!;
    useAppStore.getState().saveProviderConfig('toapis-user', {
      name: 'ToAPIs', catalogId: 'toapis', apiKey, baseUrl, selectedModels: [selected],
    });
    const general = useAppStore.getState().config.generalModels!.find((model) => model.providerConfigId === 'toapis-user')!;
    return { provider: 'general', model: `general/${general.id}`, prompt: '测试参考图' };
  }

  it('upgrades a known old ToAPIs contract at execution without rewriting saved settings', async () => {
    const params = configure('gpt-image-2.5-sunburst-vip');
    const general = useAppStore.getState().config.generalModels![0];
    const legacyProfile = structuredClone(general.executionProfile)!;
    (legacyProfile.protocol!.submit.body as Record<string, unknown>).quality = 'high';
    delete (legacyProfile.protocol!.submit.body as Record<string, unknown>).background;
    useAppStore.setState((state) => ({ config: { ...state.config,
      generalModels: [{ ...general, executionProfile: legacyProfile,
        imageCapability: { ...general.imageCapability, qualities: undefined, defaultQuality: undefined,
          backgrounds: undefined, defaultBackground: undefined } }],
    } }));
    const saved = useAppStore.getState().config;
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'quality-task' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', result: { data: [{ url: 'https://cdn.example/image.png' }] } }));
    await generateImagesBatch({ ...params, imageQuality: 'max', imageBackground: 'transparent', imageSize: '2K', aspectRatio: '16:9' }, 1);
    const body = JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ quality: 'max', size: '2048x1152', background: 'transparent' });
    expect(body).not.toHaveProperty('output_format');
    expect(useAppStore.getState().config).toBe(saved);
    expect(saved.generalModels![0].executionProfile).toEqual(legacyProfile);
  });

  it.each([
    ['video', 'video/mp4', 'videos'], ['audio', 'audio/mpeg', 'audios'],
  ] as const)('本地 %s 使用当前连接 Key 和当前站点的上传接口', async (kind, mime, endpoint) => {
    configure('gpt-image-2', 'https://toapis.com/v1');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { url: `https://cdn.example/toapis-${kind}` } }));
    const result = await uploadToRemote(`data:${mime};base64,dG9hcGlzLXJlZmVyZW5jZQ==`, 'toapis-user', kind);
    expect(result).toBe(`https://cdn.example/toapis-${kind}`);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe(`https://toapis.com/v1/uploads/${endpoint}`);
    expect(init.headers).toEqual({ Authorization: 'Bearer toapis-fixture' });
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('file')).toBeInstanceOf(Blob);
    expect(init.body.get('purpose')).toBe('generation');
  });

  it('图片先上传当前 ToAPIs 连接，再提交异步任务并只查询同一个任务 ID', async () => {
    const params = configure();
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { url: 'https://cdn.example/toapis-image-ref' } }))
      .mockResolvedValueOnce(jsonResponse({ id: 'image-toapis-task', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', result: { data: [{ url: 'https://cdn.example/toapis-output.png' }] } }));
    const result = await generateImagesBatch({ ...params, image_urls: ['data:image/png;base64,dG9hcGlzLWltYWdlLWZpeHR1cmU='], imageSize: '2k', aspectRatio: '16:9' }, 1);
    expect(result.results[0].url).toBe('https://cdn.example/toapis-output.png');
    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls.map(([url]) => url)).toEqual(['https://toapis.cn/v1/uploads/images', 'https://toapis.cn/v1/images/generations', 'https://toapis.cn/v1/images/generations/image-toapis-task']);
    expect(JSON.parse(String(calls[1][1].body))).toMatchObject({ model: 'gpt-image-2', resolution: '2k', size: '16:9', n: 1,
      reference_images: ['https://cdn.example/toapis-image-ref'] });
    expect(JSON.parse(String(calls[1][1].body))).not.toHaveProperty('image_urls');
  });

  it('本连接未配置 Key 时不借用 APIMart 或其他连接 Key', async () => {
    configure('gpt-image-2', 'https://toapis.cn/v1', '');
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      apimart: { name: 'APIMart', apiKey: 'other-fixture' },
    } } }));
    await expect(uploadToRemote('data:video/mp4;base64,bWlzc2luZy1rZXk=', 'toapis-user', 'video')).rejects.toThrow('当前连接');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });
});

describe('上传策略使用显式厂商身份', () => {
  it.each(['toapis', 'libapi'])('连接 ID 为 %s 但显式配置为自定义时不使用内置上传或泄露 Key', async (connectionId) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      ...state.config.providers,
      [connectionId]: { name: '自定义连接', catalogId: 'custom-openai', apiKey: 'private-custom-upload-fixture',
        baseUrl: 'https://custom-upload.example/v1' },
    } } }));
    const directFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      success: true, files: [{ url: `https://cdn.example/custom-${connectionId}-reference` }],
    }));

    await expect(uploadToRemote('data:audio/mpeg;base64,cG9saWN5LW92ZXJyaWRl', connectionId, 'audio'))
      .resolves.toBe(`https://cdn.example/custom-${connectionId}-reference`);

    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(directFetch).toHaveBeenCalledExactlyOnceWith('https://uguu.se/upload', expect.objectContaining({
      method: 'POST', body: expect.any(FormData),
    }));
    expect(directFetch.mock.calls[0][1]?.headers).toBeUndefined();
    expect([...(directFetch.mock.calls[0][1]?.body as FormData).keys()]).toEqual(['files[]']);
  });
});

describe('LibAPI 图片原任务与请求合同', () => {
  function configureLibapiImage() {
    const selected = LIBAPI_MODEL_MANIFEST.find((model) => model.id === 'gt-image-2.5-flare')!;
    useAppStore.getState().saveProviderConfig('libapi-images', {
      name: 'LibAPI', catalogId: 'libapi', apiKey: 'libapi-image-fixture', baseUrl: 'https://libapi.cc/v1',
      selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'libapi-images')!;
    useAppStore.setState({ currentProjectId: 'libapi-image-project', nodes: [{ id: 'libapi-image', type: 'ai-image',
      position: { x: 0, y: 0 }, data: { type: 'ai-image', label: 'LibAPI 图片', status: 'loading' } }] });
    return { provider: 'general', model: `general/${model.id}`, nodeId: 'libapi-image', prompt: '透明背景的角色立绘' };
  }

  async function failedLibapiUpload(response: Response): Promise<string> {
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应回退其他图床'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(response);
    const error = await uploadToRemote('data:image/png;base64,bGliYXBpLWVycm9y', 'libapi-images', 'image')
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://libapi.cc/v1/files', expect.anything());
    expect(directFetch).not.toHaveBeenCalled();
    return (error as Error).message;
  }

  it.each([
    ['image', 'image/png', 'png'], ['video', 'video/mp4', 'mp4'], ['audio', 'audio/mpeg', 'mp3'],
  ] as const)('LibAPI 本地 %s 只用当前连接向 /v1/files 上传', async (kind, mime, extension) => {
    configureLibapiImage();
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      apimart: { name: 'APIMart', apiKey: 'unrelated-upload-fixture' },
    } } }));
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应请求其他图床'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: `file-libapi-${kind}`, url: `https://cdn.example/libapi-upload-${kind}`,
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));

    await expect(uploadToRemote(`data:${mime};base64,bGliYXBpLXVwbG9hZC1maXh0dXJl`, 'libapi-images', kind))
      .resolves.toBe(`https://cdn.example/libapi-upload-${kind}`);

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://libapi.cc/v1/files', expect.objectContaining({
      method: 'POST', headers: { Authorization: 'Bearer libapi-image-fixture' }, body: expect.any(FormData),
    }));
    const form = transportMocks.corsSafeFetch.mock.calls[0][1].body as FormData;
    expect([...form.keys()]).toEqual(['file']);
    expect(form.get('file')).toMatchObject({ name: `reference.${extension}`, type: mime });
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('LibAPI 上传响应没有公网 URL 时明确失败，不重试或回退公共图床', async () => {
    configureLibapiImage();
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应请求其他图床'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'file-without-url' }));

    await expect(uploadToRemote('data:audio/mpeg;base64,bGliYXBpLW1pc3NpbmctdXJs', 'libapi-images', 'audio'))
      .rejects.toThrow('LibAPI 上传未返回有效公网 URL');

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('LibAPI 未填写 Key 时不借用其他厂商 Key', async () => {
    configureLibapiImage();
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应请求其他图床'));
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      'libapi-images': { ...state.config.providers['libapi-images'], apiKey: '' },
      apimart: { name: 'APIMart', apiKey: 'unrelated-upload-fixture' },
    } } }));

    await expect(uploadToRemote('data:video/mp4;base64,bGliYXBpLW5vLWtleQ==', 'libapi-images', 'video'))
      .rejects.toThrow('当前连接的 Key');

    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401, hint: /认证|鉴权/u },
    { status: 402, hint: /额度|余额/u },
    { status: 400, hint: /参数|素材/u },
    { status: 413, hint: /50\s*MB/u },
    { status: 429, hint: /限频|容量|配额/u },
    { status: 500, hint: /服务.*(?:不可用|异常)|暂.*不可用/u },
    { status: 403, hint: /原因/u },
  ])('LibAPI 上传按 HTTP $status 给出固定提示，不回显服务端任意正文', async ({ status, hint }) => {
    configureLibapiImage();
    const message = await failedLibapiUpload(new Response(JSON.stringify({ error: {
      code: 'untrusted_server_code', message: 'libapi-image-fixture https://private.example/ref.png <html>private</html>',
    } }), { status, headers: { 'Content-Type': 'application/json' } }));
    expect(message).toContain('LibAPI 图片参考上传失败');
    expect(message).toContain(`HTTP ${status}`);
    expect(message).toMatch(hint);
    for (const privateText of ['untrusted_server_code', 'libapi-image-fixture', 'private.example', '<html>']) {
      expect(message).not.toContain(privateText);
    }
    if (status === 400) expect(message).not.toContain('格式不支持');
    if (status === 403) expect(message).not.toMatch(/Key.*(?:错误|无效)|已确认.*权限/u);
  });

  it.each([
    { payload: { error: { code: 'api_key_inactive' } }, hint: /停用|删除|撤销/u },
    { payload: { error: { type: 'api_key_inactive' } }, hint: /停用|删除|撤销/u },
    { payload: { error: { code: 'insufficient_permissions' } }, hint: /权限不足/u },
    { payload: { type: 'insufficient_permissions' }, hint: /权限不足/u },
    { payload: { error: { code: 'content_policy_violation' } }, hint: /安全.*策略|策略.*拒绝/u },
    { payload: { code: 'content_policy_violation' }, hint: /安全.*策略|策略.*拒绝/u },
    { payload: { error: { code: 'model_not_allowed' } }, hint: /模型.*(?:范围|受限)/u },
    { payload: { error: { type: 'model_not_available_for_api_key' } }, hint: /未.*开放/u },
    { payload: { error: { code: 'content_policy_violation', type: 'insufficient_permissions' } }, hint: /安全.*策略|策略.*拒绝/u },
    { payload: { error: { code: 'unknown_future_code', type: 'insufficient_permissions' } }, hint: /权限不足/u },
  ])('LibAPI 403 只按已确认的 code/type 分类：$payload', async ({ payload, hint }) => {
    configureLibapiImage();
    const message = await failedLibapiUpload(new Response(JSON.stringify(payload), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    }));
    expect(message).toContain('HTTP 403');
    expect(message).toMatch(hint);
    if (hint.source === '权限不足') expect(message).toContain('文件');
  });

  it('LibAPI HTML 403 提示非 JSON 或访问策略拒绝，不回显 HTML 或 Key', async () => {
    configureLibapiImage();
    const message = await failedLibapiUpload(new Response(
      '<!doctype html><html>Bearer libapi-image-fixture https://private.example/ref.png</html>',
      { status: 403, headers: { 'Content-Type': 'text/html' } },
    ));
    expect(message).toMatch(/非\s*JSON|网关|访问.*(?:策略|拒绝页面)/u);
    expect(message).not.toContain('<html>');
    expect(message).not.toContain('libapi-image-fixture');
    expect(message).not.toContain('private.example');
  });

  it('LibAPI 仅显示合法且不含密钥的请求 ID', async () => {
    configureLibapiImage();
    const requestId = 'req-20261025_abc:1.2';
    const message = await failedLibapiUpload(new Response('{}', {
      status: 403, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
    }));
    expect(message).toContain('请求 ID');
    expect(message).toContain(requestId);
  });

  it.each([
    { requestId: 'request with spaces' },
    { requestId: 'https://private.example/request' },
    { requestId: 'https:private.example' },
    { requestId: 'sk-private-token' },
    { requestId: 'x'.repeat(97) },
    { requestId: 'req-libapi-image-fixture' },
    { requestId: 'req-fixture%2Bprivate', key: 'fixture+private' },
  ])('LibAPI 不回显不安全请求 ID：$requestId', async ({ requestId, key }) => {
    configureLibapiImage();
    if (key) useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      ...state.config.providers, 'libapi-images': { ...state.config.providers['libapi-images'], apiKey: key },
    } } }));
    const message = await failedLibapiUpload(new Response('{}', {
      status: 403, headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
    }));
    expect(message).not.toContain('请求 ID');
    expect(message).not.toContain(requestId);
  });

  it('LibAPI 接受恰好 8 KiB 的完整 JSON 错误，但不回显其中的 message', async () => {
    configureLibapiImage();
    const prefix = '{"error":{"code":"insufficient_permissions","message":"';
    const suffix = '"}}';
    const body = prefix + 'x'.repeat(8192 - prefix.length - suffix.length) + suffix;
    const message = await failedLibapiUpload(new Response(body, { status: 403, headers: { 'Content-Type': 'application/json' } }));
    expect(message).toContain('权限不足');
    expect(message).not.toContain('x'.repeat(32));
  });

  it('LibAPI 超过 8 KiB 的错误流立即取消，不能把截断 JSON 当成完整原因', async () => {
    configureLibapiImage();
    const prefix = JSON.stringify({ error: { code: 'insufficient_permissions' } });
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(prefix.padEnd(4096)) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(4096).fill(32) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array([32]) });
    const cancel = vi.fn(async () => undefined);
    const response = { ok: false, status: 403, headers: new Headers({ 'Content-Type': 'application/json' }),
      body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
      text: vi.fn(), json: vi.fn(),
    } as unknown as Response;
    const message = await failedLibapiUpload(response);
    expect(message).toMatch(/原因/u);
    expect(message).not.toContain('权限不足');
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(3);
    expect(response.text).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(['invalid-json', 'missing-reader', 'reader-failure'] as const)(
    'LibAPI 错误体 %s 时安全降级，不回显底层诊断', async (failure) => {
      configureLibapiImage();
      const response = failure === 'invalid-json'
        ? new Response('{"error":', { status: 403, headers: { 'Content-Type': 'application/json' } })
        : failure === 'missing-reader'
          ? new Response(null, { status: 403, headers: { 'Content-Type': 'application/json' } })
          : { ok: false, status: 403, headers: new Headers({ 'Content-Type': 'application/json' }),
            body: { getReader: () => ({
              read: vi.fn().mockRejectedValue(new Error('libapi-image-fixture https://private.example/raw')),
              cancel: vi.fn(async () => undefined), releaseLock: vi.fn(),
            }) },
          } as unknown as Response;
      const text = failure === 'missing-reader' ? vi.spyOn(response, 'text') : undefined;
      const message = await failedLibapiUpload(response);
      expect(message).toMatch(/原因/u);
      expect(message).not.toContain('libapi-image-fixture');
      expect(message).not.toContain('private.example');
      if (text) expect(text).not.toHaveBeenCalled();
    },
  );

  it('LibAPI 读取错误体期间取消仍返回 AbortError，不误报 HTTP 分类', async () => {
    configureLibapiImage();
    const controller = new AbortController();
    let markReading: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => { markReading = resolve; });
    let finishRead: ((result: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
    const read = vi.fn(() => {
      markReading();
      return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { finishRead = resolve; });
    });
    const cancel = vi.fn(async () => { finishRead?.({ done: true, value: undefined }); });
    transportMocks.corsSafeFetch.mockResolvedValueOnce({ ok: false, status: 403,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
    });
    const pending = uploadToRemote('data:image/png;base64,bGliYXBpLWFib3J0', 'libapi-images', 'image', controller.signal)
      .catch((error: unknown) => error);
    await reading;
    controller.abort();
    const error = await pending;
    expect(error).toMatchObject({ name: 'AbortError' });
    expect((error as Error).message).not.toContain('HTTP 403');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    // 等底层取消结算，别把上传队列的临时隔离状态带进下个用例。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('LibAPI 参考图上传被拒绝时不提交依赖它的图片生成请求', async () => {
    const params = configureLibapiImage();
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应回退其他图床'));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'insufficient_permissions' } }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(generateImagesBatch({ ...params, image_urls: ['data:image/png;base64,bGliYXBpLWdlbmVyYXRl'] }, 1))
      .rejects.toThrow('文件');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://libapi.cc/v1/files', expect.anything());
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('LibAPI 视频参考上传只用选中自定义连接的 Key，拒绝后不进入视频提交', async () => {
    const selected = LIBAPI_MODEL_MANIFEST.find((model) => model.id === 'seedance-2-5')!;
    useAppStore.getState().saveProviderConfig('libapi-video-personal', {
      name: '自己的 LibAPI', catalogId: 'libapi', apiKey: 'video-selected-fixture',
      baseUrl: 'https://libapi.cc/v1', selectedModels: [selected],
    });
    const general = useAppStore.getState().config.generalModels!.find((model) => model.providerConfigId === 'libapi-video-personal')!;
    useAppStore.setState((state) => ({ currentProjectId: 'libapi-video-upload-denied-project',
      nodes: [{ id: 'libapi-upload-video', type: 'ai-video', position: { x: 0, y: 0 },
        data: { type: 'ai-video', label: '自己的 LibAPI 视频', status: 'loading' } }],
      config: { ...state.config, providers: { ...state.config.providers,
        libapi: { name: '默认 LibAPI', catalogId: 'libapi', apiKey: 'wrong-default-fixture' },
        apimart: { name: '其他厂商', apiKey: 'wrong-provider-fixture' },
      } },
    }));
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应回退其他图床'));
    const beforeSubmit = vi.fn();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'insufficient_permissions' } }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(generateVideo({ provider: 'general', model: `general/${general.id}`, nodeId: 'libapi-upload-video',
      prompt: '依据参考图生成视频', seedanceDuration: 5, seedanceResolution: '480p', seedanceRatio: '16:9',
      referenceMedia: [{ kind: 'image', role: 'reference', origin: 'connection', url: 'data:image/png;base64,bGliYXBpLXZpZGVv' }],
    }, undefined, beforeSubmit)).rejects.toThrow('文件');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledExactlyOnceWith('https://libapi.cc/v1/files', expect.objectContaining({
      method: 'POST', headers: { Authorization: 'Bearer video-selected-fixture' }, body: expect.any(FormData),
    }));
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(getPendingTasksForProject('libapi-video-upload-denied-project')).toEqual([]);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('LibAPI 不支持的音频格式在发送上传请求前拦截', async () => {
    configureLibapiImage();
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应请求其他图床'));

    await expect(uploadToRemote('data:audio/ogg;base64,bGliYXBpLW9nZw==', 'libapi-images', 'audio'))
      .rejects.toThrow('格式不支持');

    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('只提交一次统一异步请求，用 task_id 查询并保留交付凭据', async () => {
    const params = configureLibapiImage();
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ mode: 'async', task_id: 'libapi-image-task', status: 'pending' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', is_final: true,
        output_url: 'https://cdn.example/libapi-image.png' }));

    const result = await generateImagesBatch({ ...params, imageSize: '2K', aspectRatio: '9:16',
      imageQuality: 'high', imageBackground: 'transparent', image_urls: ['https://cdn.example/character.png'] }, 1);

    expect(result.results[0].url).toBe('https://cdn.example/libapi-image.png');
    expect(result.taskReceipt).toMatchObject({ projectId: 'libapi-image-project', nodeId: 'libapi-image', taskId: 'libapi-image-task' });
    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      'https://libapi.cc/api/v1/model-runtime/invoke', 'https://libapi.cc/v1/tasks/libapi-image-task',
    ]);
    expect(JSON.parse(String(calls[0][1].body))).toMatchObject({ model_id: 'gt-image-2.5-flare', modality: 'image', params: {
      aspect_ratio: '9:16', resolution: '2K', quality: 'high', background: 'transparent', count: 1,
      images: ['https://cdn.example/character.png'],
    } });
    expect(calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(calls[1][1].headers).toMatchObject({ Authorization: 'Bearer libapi-image-fixture' });
    const pending = getPendingTasksForProject('libapi-image-project');
    expect(pending).toEqual([expect.objectContaining({ providerConfigId: 'libapi-images', taskId: 'libapi-image-task',
      submitted: true, mediaRecoveryState: 'delivery_pending' })]);
    expect(JSON.stringify(pending)).not.toContain('libapi-image-fixture');
  });

  it('查询鉴权失败保留原 task_id，不重新提交生成', async () => {
    const params = configureLibapiImage();
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ task_id: 'libapi-retained-task' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: '权限已变化' } }), { status: 401 }));

    await expect(generateImagesBatch(params, 1)).rejects.toMatchObject({
      name: 'MediaTaskPausedError', taskReceipt: { taskId: 'libapi-retained-task' },
    });
    expect(transportMocks.corsSafeFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(getPendingTasksForProject('libapi-image-project')).toEqual([expect.objectContaining({
      taskId: 'libapi-retained-task', providerConfigId: 'libapi-images', submitted: true,
    })]);
  });
});

describe('LibAPI 音频合同与原任务交付', () => {
  function configureAudio(id: string) {
    const selected = LIBAPI_MODEL_MANIFEST.find((model) => model.id === id)!;
    useAppStore.getState().saveProviderConfig('libapi-audio', {
      name: 'LibAPI', catalogId: 'libapi', apiKey: 'libapi-audio-fixture', selectedModels: [selected],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'libapi-audio')!;
    useAppStore.setState({ currentProjectId: 'libapi-audio-project', nodes: [{ id: 'libapi-audio-node', type: 'ai-audio',
      position: { x: 0, y: 0 }, data: { type: 'ai-audio', label: 'LibAPI 音频', status: 'loading' } }] });
    return { provider: 'general', model: `general/${model.id}`, nodeId: 'libapi-audio-node', prompt: '欢迎来到创作空间' };
  }
  function successfulAudio() {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ task_id: 'libapi-audio-task' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'completed', output_url: 'https://cdn.example/libapi-audio.wav' }));
  }

  it('同名连接显式改为自定义后保留原协议，不强加内置音色或官方地址', async () => {
    const selected = LIBAPI_MODEL_MANIFEST.find((model) => model.id === 'speech-2.8')!;
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, libapi: { name: '自定义语音', catalogId: 'custom-openai',
        apiKey: 'custom-speech-fixture', baseUrl: 'https://custom-speech.example/v1' } },
      generalModels: [{ id: 'custom-speech', providerConfigId: 'libapi', name: selected.name,
        modelId: selected.id, category: 'audio', executionProfile: selected.executionProfile }],
    } }));
    successfulAudio();

    await expect(generateAudio({ provider: 'general', model: 'general/custom-speech', prompt: '沿用自定义协议' }))
      .resolves.toMatchObject({ url: 'https://cdn.example/libapi-audio.wav' });

    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      'https://custom-speech.example/api/v1/model-runtime/invoke', 'https://custom-speech.example/v1/tasks/libapi-audio-task',
    ]);
    expect(calls[0][1].headers).toMatchObject({ Authorization: 'Bearer custom-speech-fixture' });
    expect(JSON.parse(String(calls[0][1].body)).params).not.toHaveProperty('voice');
  });

  it.each([
    { id: 'gt-4o-mini-tts', expected: { voice: 'alloy', response_format: 'mp3', speed: 1 } },
    { id: 'gm-3.1-flash-tts', expected: { voice: 'Zephyr', response_format: 'wav' } },
    { id: 'gm-2.5-pro-tts', expected: { voice: 'Zephyr', response_format: 'wav' } },
  ])('$id 使用本型号默认参数，只提交一次并保留原音频任务', async ({ id, expected }) => {
    const params = configureAudio(id);
    successfulAudio();
    const result = await generateAudio(params);
    expect(result).toMatchObject({ url: 'https://cdn.example/libapi-audio.wav', taskReceipt: { taskId: 'libapi-audio-task' } });
    const calls = transportMocks.corsSafeFetch.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      'https://libapi.cc/api/v1/model-runtime/invoke', 'https://libapi.cc/v1/tasks/libapi-audio-task',
    ]);
    const body = JSON.parse(String(calls[0][1].body));
    expect(body).toMatchObject({ model_id: id, modality: 'audio', operation: 'speech', params: { input: params.prompt, ...expected } });
    expect(body.params).not.toHaveProperty('count');
    if (id.startsWith('gm-')) expect(body.params).not.toHaveProperty('speed');
    expect(getPendingTasksForProject('libapi-audio-project')).toEqual([expect.objectContaining({
      taskId: 'libapi-audio-task', providerConfigId: 'libapi-audio', mediaRecoveryState: 'delivery_pending',
    })]);
    expect(JSON.stringify(result.taskReceipt)).not.toContain('libapi-audio-fixture');
  });

  it.each(['speech-2.8', 'doubao-tts-2.0'])('%s 只传入用户明确填写的声音 ID', async (id) => {
    const params = configureAudio(id);
    successfulAudio();
    await generateAudio({ ...params, audioVoice: 'my-authorized-voice-id', audioSpeed: 1.25 });
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(body.params).toMatchObject({ input: params.prompt, voice: 'my-authorized-voice-id', speed: 1.25 });
    if (id === 'speech-2.8') expect(body.params).not.toHaveProperty('response_format');
    else expect(body.params.response_format).toBe('mp3');
  });

  it('音乐提交标题和歌词，不发送时长或 BPM，也不先提交另一个写词任务', async () => {
    const params = configureAudio('music');
    successfulAudio();
    await generateAudio({ ...params, prompt: '轻快的旅行歌曲', musicTitle: '旅途', musicLyrics: '迎着阳光向前走' });
    const body = JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body));
    expect(body).toMatchObject({ modality: 'audio', operation: 'generate', params: {
      prompt: '轻快的旅行歌曲', title: '旅途', lyrics: '迎着阳光向前走',
    } });
    for (const name of ['duration', 'bpm', 'count', 'response_format', 'voice']) expect(body.params).not.toHaveProperty(name);
    expect(transportMocks.corsSafeFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it.each([
    { id: 'speech-2.8', extra: {}, error: /音色|voice/i },
    { id: 'doubao-tts-2.0', extra: {}, error: /音色|voice/i },
    { id: 'gt-4o-mini-tts', extra: { audioFormat: 'pcm' as const }, error: /格式|format/i },
    { id: 'gm-3.1-flash-tts', extra: { audioSpeed: 1.25 }, error: /语速|速度|speed/i },
    { id: 'music', extra: { musicDuration: 60 }, error: /时长|duration/i },
  ])('$id 的不完整或不支持参数在提交前失败', async ({ id, extra, error }) => {
    const params = configureAudio(id);
    await expect(generateAudio({ ...params, ...extra })).rejects.toThrow(error);
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('参考音频不被当作即传即克隆，提交前停止且不上传素材', async () => {
    const params = configureAudio('gt-4o-mini-tts');
    useAppStore.setState((state) => ({ nodes: [...state.nodes, { id: 'audio-reference', type: 'source-audio', position: { x: 0, y: 0 },
      data: { type: 'source-audio', label: '原声', audioUrl: 'data:audio/mpeg;base64,YQ==' } }],
      edges: [{ id: 'audio-edge', source: 'audio-reference', target: params.nodeId }] }));
    await expect(generateAudio(params)).rejects.toThrow('不接受参考素材');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it.each(['node-image', 'asset-audio', 'drama-image'])('%s 的纯 @ 引用也会在提交前拦截，不把素材地址变成朗读正文', async (kind) => {
    const params = configureAudio('gt-4o-mini-tts');
    useAppStore.setState((state) => ({
      nodes: [...state.nodes, { id: 'image-reference', type: 'source-image', position: { x: 0, y: 0 },
        data: { type: 'source-image', label: '参考图', imageUrl: 'data:image/png;base64,YQ==' } }],
      dramaAssets: { ...state.dramaAssets, scenes: [{ id: 'scene-reference', kind: 'scene', name: '参考场景',
        key: 'scene-reference', summary: '', visualNotes: '', importance: 'main', confirmed: true,
        source: 'manual', createdAt: 1, updatedAt: 1, imageUrl: 'data:image/png;base64,YQ==' }] },
      edges: [],
    }));
    const reference = kind === 'node-image' ? '@{image-reference:参考图}'
      : kind === 'asset-audio' ? '@asset{fixtures/reference.mp3}' : '@drama{scene-reference:参考场景}';
    await expect(generateAudio({ ...params, prompt: `请参考 ${reference} 朗读欢迎词` })).rejects.toThrow('不接受参考素材');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('音频查询中断保留已有 task_id，避免重复提交扣费', async () => {
    const params = configureAudio('gt-4o-mini-tts');
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ task_id: 'libapi-retained-audio' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Key 权限已变化' } }), { status: 401 }));
    await expect(generateAudio(params)).rejects.toMatchObject({ name: 'MediaTaskPausedError', taskReceipt: { taskId: 'libapi-retained-audio' } });
    expect(transportMocks.corsSafeFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(getPendingTasksForProject('libapi-audio-project')).toEqual([expect.objectContaining({
      taskId: 'libapi-retained-audio', submitted: true, providerConfigId: 'libapi-audio',
    })]);
  });
});

describe('image quick template request transport', () => {
  function configureTemplate(templateId: string) {
    useAppStore.getState().saveProviderConfig('custom-template', {
      name: 'Custom images', catalogId: 'custom-openai', apiKey: 'template-fixture', baseUrl: 'https://images.example/v1',
      selectedModels: [{ id: 'actual-model-id', name: 'User model name', category: 'image', provider: 'custom-template',
        ...createImageQuickAdaptTemplate(templateId) }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'custom-template')!;
    return { provider: 'general', model: `general/${model.id}`, prompt: 'Edit the reference images' };
  }

  it.each([
    { id: 'banana-pro:google', path: '/v1/models/actual-model-id:generateContent', auth: { 'x-goog-api-key': 'template-fixture' }, field: 'responseFormat' },
    { id: 'banana-pro:gemini-relay', path: '/v1beta/models/actual-model-id:generateContent', auth: { Authorization: 'Bearer template-fixture' }, field: 'imageConfig' },
  ])('sends every prepared reference in the selected $id native contract', async ({ id, path, auth, field }) => {
    const params = configureTemplate(id);
    const references = ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg==', 'data:image/png;base64,Yw=='];
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { parts: [
      { text: 'Description' }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ] } }] }));
    const result = await generateImagesBatch({ ...params, image_urls: references, imageSize: '2K', aspectRatio: '16:9' }, 1);
    expect(result.results[0].url).toBe('data:image/png;base64,aW1hZ2U=');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe(`https://images.example${path}`);
    expect(init.headers).toMatchObject(auth);
    const body = JSON.parse(String(init.body));
    expect(body.contents[0].parts[0].text).toContain(params.prompt);
    expect(body.contents[0].parts[0].text).toContain('3 张参考图');
    expect(body.contents[0].parts[0].text).toContain('16:9');
    expect(body.contents[0].parts).toEqual([{ text: expect.any(String) }, ...references.map((reference) => ({
      inlineData: { mimeType: 'image/png', data: reference.split(',')[1] },
    }))]);
    expect(body.generationConfig[field]).toEqual(field === 'imageConfig'
      ? { aspectRatio: '16:9', imageSize: '2K' } : { image: { aspectRatio: '16:9', imageSize: '2K' } });
  });

  it('blocks references beyond the visible native transport budget before reading or submitting', async () => {
    const params = configureTemplate('banana-pro:google');
    await expect(generateImagesBatch({ ...params, image_urls: Array.from({ length: 7 }, (_, index) =>
      `https://cdn.example/reference-${index}.png`) }, 1)).rejects.toThrow('最多支持 6');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('replaces an older native reference mode when saving a URL-based gateway template', async () => {
    configureTemplate('banana-pro:google');
    const params = configureTemplate('gpt-2:images-json');
    expect(useAppStore.getState().config.generalModels!.find((model) => model.providerConfigId === 'custom-template')!
      .imageReferenceRequestMode).toBe('generation-json-image-urls');
    const references = Array.from({ length: 7 }, (_, index) => `https://cdn.example/reference-${index}.png`);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImagesBatch({ ...params, image_urls: references }, 1);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(transportMocks.corsSafeFetch.mock.calls[0][1].body)).images).toEqual(references);
  });

  it.each(['gpt-2:openai', 'gpt-2.5:images-json'])('uses explicit 4K pixels and numeric counts for %s', async (id) => {
    const params = configureTemplate(id);
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [
      { url: 'https://cdn.example/result-one.png' }, { url: 'https://cdn.example/result-two.png' },
    ] }));
    const result = await generateImagesBatch({ ...params, imageSize: '4K', aspectRatio: '16:9' }, 2);
    expect(result.results).toHaveLength(2);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://images.example/v1/images/generations');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'actual-model-id', size: '3840x2160', n: 2 });
    await expect(generateImagesBatch({ ...params, imageSize: '4K', aspectRatio: '8:1' }, 1)).rejects.toThrow('不支持比例');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('uses official multipart edits with the same selected pixel table', async () => {
    const params = configureTemplate('gpt-2:openai');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('reference', { headers: { 'Content-Type': 'image/png' } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: 'aW1hZ2U=' }] }));
    await generateImagesBatch({ ...params, image_urls: ['data:image/png;base64,YQ=='], imageSize: '1K', aspectRatio: '3:2' }, 1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://images.example/v1/images/edits');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('size')).toBe('1536x1024');
    expect(init.body.getAll('image[]')).toHaveLength(1);
  });

  it('submits APIMart once, then queries the returned task with the connection key', async () => {
    const params = configureTemplate('gpt-2.5:apimart');
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'task-123', status: 'submitted' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'completed', progress: 100,
        result: { images: [{ url: ['https://cdn.example/result.png'] }] } } }));
    const result = await generateImagesBatch({ ...params, imageSize: '2k', aspectRatio: '3:2',
      image_urls: ['https://cdn.example/reference.png'] }, 1);
    expect(result.results[0].url).toBe('https://cdn.example/result.png');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    const [submitUrl, submit] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(submitUrl).toBe('https://images.example/v1/images/generations');
    const submitted = JSON.parse(String(submit.body));
    expect(submitted.prompt).toContain(params.prompt);
    expect(submitted.prompt).toContain('1 张参考图');
    expect(submitted.prompt).toContain('3:2');
    expect(submitted).toEqual({ model: 'actual-model-id', prompt: expect.any(String),
      size: '3:2', resolution: '2k', quality: 'auto', n: 1, image_urls: ['https://cdn.example/reference.png'] });
    const [pollUrl, poll] = transportMocks.corsSafeFetch.mock.calls[1];
    expect(pollUrl).toBe('https://images.example/v1/tasks/task-123');
    expect(poll.headers).toMatchObject({ Authorization: 'Bearer template-fixture' });
  });
});

describe('model request transport boundary', () => {
  it('rejects legacy fixed transparent/JPEG protocols even without saved image capabilities', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { legacy: { name: 'Images', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://gateway.example/v1' } },
      generalModels: [{ id: 'legacy', name: 'Legacy Image', modelId: 'image', category: 'image', providerConfigId: 'legacy',
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}', background: 'transparent', output_format: 'jpeg' } },
          response: { type: 'json', result: { urlPath: 'url' } } } },
      }],
    } }));
    await expect(generateImagesBatch({ provider: 'general', model: 'general/legacy', prompt: 'sticker' }, 1))
      .rejects.toThrow('透明背景不能与固定 output_format: jpeg');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });
  it('honors explicit interface default over a custom background default without replacing the protocol', async () => {
    useAppStore.getState().saveProviderConfig('custom-background', {
      name: 'Images', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://gateway.example/v1',
      selectedModels: [{ id: 'image', name: 'Image', category: 'image', provider: 'custom-background',
        imageCapability: { backgrounds: ['transparent', 'opaque'], defaultBackground: 'transparent' },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}', background: '{{imageBackground}}', output_format: 'webp' } },
          response: { type: 'json', result: { urlPath: 'url' } } } },
      }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'custom-background')!;
    const params = { provider: 'general', model: `general/${model.id}`, prompt: 'sticker' };
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ url: 'https://cdn.example/image.webp' }));
    for (const imageBackground of [undefined, '', 'opaque']) await generateImagesBatch({ ...params, imageBackground }, 1);
    const bodies = transportMocks.corsSafeFetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies.map((body) => body.background)).toEqual(['transparent', undefined, 'opaque']);
    expect(bodies.every((body) => body.output_format === 'webp')).toBe(true);
    expect(transportMocks.corsSafeFetch.mock.calls.every(([url]) => url === 'https://gateway.example/v1/render')).toBe(true);
    await expect(generateImagesBatch({ ...params, imageBackground: 'auto' }, 1)).rejects.toThrow('不支持背景');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(3);
  });
  it('rejects unsupported Dreamina image ratios before the CLI can silently replace them', async () => {
    await expect(generateImagesBatch({ provider: 'dreamina', model: 'dreamina/4.0',
      prompt: 'portrait', aspectRatio: '1:8' }, 1)).rejects.toThrow('不支持比例 1:8');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });
  it('passes APIMart quality through its asynchronous adapter without a second generation', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { apimart: { name: 'APIMart', apiKey: 'fixture', baseUrl: 'https://apimart.example/v1' } },
    } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ data: [{ task_id: 'native-quality-task' }] }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'completed', result: { images: [{ url: ['https://cdn.example/image.png'] }] } } }));
    const result = await generateImagesBatch({ provider: 'apimart', model: 'apimart/gpt-image-2.5-sunburst',
      prompt: 'cat', imageSize: '2K', aspectRatio: '16:9', imageQuality: 'max', imageBackground: 'transparent' }, 1);
    expect(result.results[0].url).toBe('https://cdn.example/image.png');
    expect(JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body))
      .toMatchObject({ model: 'gpt-image-2.5-sunburst', resolution: '2k', size: '16:9', quality: 'max',
        background: 'transparent', output_format: 'png' });
    expect(transportMocks.corsSafeFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it('uses an explicitly declared custom quality and rejects unsupported values before submission', async () => {
    useAppStore.getState().saveProviderConfig('custom-quality', {
      name: 'Images', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://gateway.example/v1',
      selectedModels: [{ id: 'image', name: 'Image', category: 'image', provider: 'custom-quality',
        imageCapability: { qualities: ['low', 'high'], defaultQuality: 'low' },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/render', body: { prompt: '{{prompt}}', quality: '{{imageQuality}}' } },
          response: { type: 'json', result: { urlPath: 'url' } } } },
      }],
    });
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'custom-quality')!;
    const params = { provider: 'general', model: `general/${model.id}`, prompt: 'cat' };
    await expect(generateImagesBatch({ ...params, imageQuality: 'max' }, 1)).rejects.toThrow('不支持质量');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ url: 'https://cdn.example/image.png' }));
    await generateImagesBatch(params, 1);
    await generateImagesBatch({ ...params, imageQuality: 'high' }, 1);
    expect(transportMocks.corsSafeFetch.mock.calls.map(([, init]) => JSON.parse(init.body).quality)).toEqual(['low', 'high']);
  });
  it('uses custom image defaults and blocks unsupported tiers before submission', async () => {
    useAppStore.getState().saveProviderConfig('custom-image-parameters', {
      name: 'Images', catalogId: 'custom-openai', apiKey: 'fixture', baseUrl: 'https://gateway.example/v1',
      selectedModels: [{ id: 'image', name: 'Image', category: 'image', provider: 'custom-image-parameters',
        imageCapability: { resolutions: ['1K'], defaultResolution: '1K', ratios: ['1:1'], defaultRatio: '1:1',
          supportsBatch: true, maxBatchCount: 2, supportsImageReference: false },
        executionProfile: { preset: 'custom', protocol: { version: 2, mode: 'sync', auth: { type: 'bearer' },
          submit: { method: 'POST', path: '/images/generations', body: { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}', n: '{{n}}' } },
          response: { type: 'json', result: { urlPath: 'data.0.url' } } } },
      }],
    });
    const model = useAppStore.getState().config.generalModels![0];
    const params = { provider: 'general', model: `general/${model.id}`, prompt: 'cat' };
    for (const invalid of [{ imageSize: '4K' }, { aspectRatio: '16:9' }, { image_urls: ['https://cdn.example/ref.png'] }]) {
      await expect(generateImagesBatch({ ...params, ...invalid }, 1)).rejects.toThrow();
    }
    await expect(generateImagesBatch(params, 3)).rejects.toThrow('最多生成 2');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImagesBatch(params, 1);
    expect(JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body)).toMatchObject({ size: '1024x1024', n: 1 });
  });
  it.each([undefined, '   ', 'https://custom.example/v1/'])('reverses images and chats with the selected CCC group when its address is %s', async (baseUrl) => {
    for (const group of ['pro', 'discount']) useAppStore.getState().saveProviderConfig(`cccapi-${group}`, {
      name: 'CCC', catalogId: 'cccapi', cccGroup: group, apiKey: `${group}-fixture`, baseUrl,
      selectedModels: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', category: 'text', provider: `cccapi-${group}`,
        inputModalities: ['text', 'image'], executionProfile: { preset: 'openai-chat' } }],
    });
    const result = { prompt: '窗台上的橘猫', tags: ['橘猫', '窗台'] };
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }));
    const expectedUrl = `${baseUrl?.trim().replace(/\/+$/, '') || 'https://cccapi.cn/v1'}/chat/completions`;
    for (const model of useAppStore.getState().config.generalModels!) {
      await expect(reversePromptAndTags({ provider: 'general', model: `general/${model.id}`, imageUrls: ['data:image/png;base64,Y2F0'] })).resolves.toEqual(result);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)!;
      expect(url).toBe(expectedUrl);
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${useAppStore.getState().config.providers[model.providerConfigId].apiKey}` });
      expect(JSON.parse(init.body)).toMatchObject({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: expect.arrayContaining([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,Y2F0' } },
      ]) }] });
      useAppStore.getState().updateConfig({ assistantModelId: model.id });
      await expect(streamAssistantReply({ systemPrompt: '', userMessage: '你好', nonStream: true, onEvent: vi.fn() })).resolves.toBe(JSON.stringify(result));
      const [chatUrl, chatInit] = transportMocks.corsSafeFetch.mock.calls.at(-1)!;
      expect(chatUrl).toBe(expectedUrl);
      expect(chatInit.headers).toMatchObject({ Authorization: `Bearer ${useAppStore.getState().config.providers[model.providerConfigId].apiKey}` });
    }
    useAppStore.getState().setProviderKey('cccapi-discount', '');
    transportMocks.corsSafeFetch.mockClear();
    const model = useAppStore.getState().config.generalModels!.find((item) => item.providerConfigId === 'cccapi-discount')!;
    await expect(reversePromptAndTags({ provider: 'general', model: `general/${model.id}`, imageUrls: ['data:image/png;base64,Y2F0'] })).rejects.toThrow();
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('still rejects an unconfigured custom connection address instead of borrowing a built-in URL', async () => {
    useAppStore.getState().saveProviderConfig('custom-cccapi', { name: '自定义', catalogId: 'custom-openai', apiKey: 'fixture',
      selectedModels: [{ id: 'gpt-5.6-sol', name: 'GPT', category: 'text', provider: 'custom-cccapi' }],
    });
    const model = useAppStore.getState().config.generalModels![0];
    await expect(generateText({ provider: 'general', model: `general/${model.id}`, prompt: '你好' })).rejects.toThrow('未配置接口地址');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it.each(['text', 'image'] as const)('routes identical CCC %s model IDs through the selected group Key', async (category) => {
    const modelId = category === 'text' ? 'gpt-5' : 'gpt-image-2';
    for (const group of ['free', 'stable']) {
      useAppStore.getState().saveProviderConfig(`cccapi-${group}`, {
        name: 'CCC', catalogId: 'cccapi', cccGroup: group, apiKey: `${group}-fixture`, baseUrl: 'https://cccapi.cn/v1',
        selectedModels: [{ id: modelId, name: modelId, category, provider: `cccapi-${group}`,
          executionProfile: { preset: category === 'text' ? 'openai-chat' : 'openai-image' } }],
      });
    }
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse(category === 'text'
      ? { choices: [{ message: { content: '回复' }, finish_reason: 'stop' }] }
      : { data: [{ url: 'https://cdn.example/image.png' }] }));
    const models = useAppStore.getState().config.generalModels!;
    expect(new Set(models.map((model) => model.id)).size).toBe(2);
    for (const model of models) {
      const params = { provider: 'general', model: `general/${model.id}`, prompt: '测试' };
      if (category === 'text') await expect(generateText(params)).resolves.toBe('回复');
      else expect((await generateImagesBatch(params, 1)).results).toHaveLength(1);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)!;
      const key = useAppStore.getState().config.providers[model.providerConfigId].apiKey;
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${key}` });
      expect(url).toBe(`https://cccapi.cn/v1/${category === 'text' ? 'chat/completions' : 'images/generations'}`);
      expect(JSON.parse(init.body).model).toBe(modelId);
    }
    useAppStore.getState().setProviderKey('cccapi-stable', '');
    transportMocks.corsSafeFetch.mockClear();
    const model = models.find((item) => item.providerConfigId === 'cccapi-stable')!;
    const params = { provider: 'general', model: `general/${model.id}`, prompt: '测试' };
    if (category === 'text') await expect(generateText(params)).rejects.toThrow();
    else await expect(generateImagesBatch({ ...params, image_urls: ['https://cdn.example/reference.png'] }, 1)).rejects.toThrow('CCC API');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });
  it('routes a GRSAI H3 selection from the video entry into its native asynchronous adapter', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'fixture-key' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ id: 'h3-task', status: 'running' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/h3.mp4' }] }));
    await expect(generateVideo({ provider: 'grsai', model: 'grsai/minimax-h3', prompt: '写实短片', seedanceResolution: '768p', seedanceRatio: '9:16', seedanceDuration: 12 }))
      .resolves.toEqual({ url: 'https://cdn.example/h3.mp4' });
    expect(transportMocks.corsSafeFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://grsai.dakka.com.cn/v1/api/generate', 'https://grsai.dakka.com.cn/v1/api/result?id=h3-task',
    ]);
    expect(JSON.parse(transportMocks.corsSafeFetch.mock.calls[0][1].body)).toMatchObject({ aspectRatio: 'portrait', resolution: '768p', duration: 12, replyType: 'async' });
  });

  it('shows GRSAI H3 resolution and duration without unsupported audio toggle', () => {
    const html = renderToStaticMarkup(createElement(VideoParamSelector, { provider: 'grsai', selectedModel: 'grsai/minimax-h3', seedanceResolution: '1080p', seedanceDuration: 15 }));
    expect(html).toContain('1080p');
    expect(html).toContain('10s');
    expect(html).not.toContain('15s');
  });
  it.each(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-3.8-flash'])('uses GRSAI shared chat transport for %s', async (modelId) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'fixture-key' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '回复' }, finish_reason: 'stop' }] }));
    await expect(generateText({ provider: 'grsai', model: `grsai/${modelId}`, prompt: '你好' })).resolves.toBe('回复');
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/chat/completions');
    expect(JSON.parse(init.body)).toMatchObject({ model: modelId, stream: false });
  });

  it.each(['nano-banana-2.1', 'nano-banana-2-lite', 'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])('submits GRSAI %s through its native image contract', async (modelId) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'fixture-key' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/image.png' }] }));
    const result = await generateImagesBatch({ provider: 'grsai', model: `grsai/${modelId}`, prompt: '海报', imageSize: '4K', aspectRatio: '16:9' }, 1);
    expect(result.results).toHaveLength(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/api/generate');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: modelId, replyType: 'json', images: [] });
    expect(body).not.toHaveProperty('resolution');
    if (modelId === 'nano-banana-2-lite') expect(body.imageSize).toBe('1K');
    else if (modelId === 'nano-banana-2.1') expect(body.imageSize).toBe('4K');
    else expect(body).toMatchObject({ aspectRatio: modelId === 'gpt-image-2.5' ? '16:9' : '3840x2160', quality: modelId === 'gpt-image-2.5' ? 'auto' : 'medium' });
  });
  it.each(['DeepSeek-V4.1-Flash', 'GLM-5.3-Flash', 'Qwen3.8-Flash', 'mI MiMo-V2.5',
    'Hy3', 'claude-sonnet-4-6', 'gemini-3.5-flash', 'grok-4.5'])('uses shared OpenAI chat requests for CCC %s in nodes and conversations', async (modelId) => {
    const catalogModel = getProviderDefinition('cccapi')!.models!.find((model) => model.id === modelId)!;
    useAppStore.setState((state) => ({ config: {
      ...state.config, assistantModelId: 'ccc-text',
      providers: { ...state.config.providers, cccapi: {
        name: 'CCC', apiKey: 'fixture-key', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi',
      } },
      generalModels: [{ id: 'ccc-text', name: modelId, modelId, category: 'text',
        providerConfigId: 'cccapi', executionProfile: catalogModel.executionProfile }],
    } }));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({
      choices: [{ message: { content: 'CCC 回复' }, finish_reason: 'stop' }],
    }));
    await expect(generateText({ provider: 'general', model: 'general/ccc-text', prompt: '你好' }))
      .resolves.toBe('CCC 回复');
    await expect(streamAssistantReply({ systemPrompt: '系统', userMessage: '你好',
      nonStream: true, onEvent: vi.fn(),
    })).resolves.toBe('CCC 回复');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of transportMocks.corsSafeFetch.mock.calls as [string, RequestInit][]) {
      expect(url).toBe('https://cccapi.cn/v1/chat/completions');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
      expect(JSON.parse(String(init.body))).toMatchObject({ model: modelId, stream: false,
        messages: expect.arrayContaining([{ role: 'user', content: '你好' }]),
      });
    }
    transportMocks.corsSafeFetch.mockClear();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(
      'data: {"choices":[{"delta":{"content":"CCC 流式回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ));
    const onEvent = vi.fn();
    await expect(streamAssistantReply({ systemPrompt: '系统', userMessage: '你好', onEvent }))
      .resolves.toBe('CCC 流式回复');
    expect(onEvent).toHaveBeenCalledWith({ type: 'text.delta', delta: 'CCC 流式回复' });
    const [streamUrl, streamInit] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(streamUrl).toBe('https://cccapi.cn/v1/chat/completions');
    expect(JSON.parse(String(streamInit.body))).toMatchObject({ model: modelId, stream: true });
  });

  it.each(['gemini-3-pro-image-preview', 'gemini-3-pro-image', 'gemini-3.1-flash-image',
    'gemini-2.5-flash-image', 'nano-banana2', 'nano-banana-pro'])('uses CCC native Gemini image requests and Base64 results for %s', async (modelId) => {
    const catalogModel = getProviderDefinition('cccapi')!.models!.find((model) => model.id === modelId)!;
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, cccapi: {
        name: 'CCC', apiKey: 'fixture-key', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi',
      } },
      generalModels: [{ id: 'ccc-native-image', name: modelId, modelId, category: 'image',
        providerConfigId: 'cccapi', executionProfile: catalogModel.executionProfile }],
    } }));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ candidates: [{
      content: { parts: [{ text: '图片说明' }, { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] },
    }] }));
    const params = { provider: 'general', model: 'general/ccc-native-image', prompt: '画一只猫',
      imageSize: '4K', aspectRatio: '16:9' };
    await expect(generateImagesBatch(params, 1))
      .resolves.toMatchObject({ results: [{ url: 'data:image/png;base64,aW1hZ2U=' }] });
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://cccapi.cn/v1beta/models/${modelId}:generateContent`);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
    expect(JSON.parse(String(init.body))).toEqual({
      contents: [{ role: 'user', parts: [{ text: '画一只猫' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: {
        aspectRatio: '16:9', ...(modelId === 'gemini-2.5-flash-image' ? {} : { imageSize: '4K' }),
      } },
    });

    // 未接入的参考图必须在提交前报错，不能悄悄丢图。
    transportMocks.corsSafeFetch.mockClear();
    await expect(generateImagesBatch({ ...params, image_urls: ['https://cdn.example/ref.png'] }, 1))
      .rejects.toThrow('参考图');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    await expect(generateImagesBatch(params, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();

    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({ candidates: [{
      content: { parts: [{ text: '无法生成图片' }] },
    }] }));
    await expect(generateImagesBatch(params, 1)).rejects.toThrow('未找到配置的结果');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    transportMocks.corsSafeFetch.mockClear();
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: '上游生图超时' },
    }), { status: 504, headers: { 'Content-Type': 'application/json' } }));
    await expect(generateImagesBatch(params, 1)).rejects.toThrow('上游生图超时');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the gateway JSON preset when an older model still has a reference request mode', async () => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, gateway: {
        name: '图片网关', apiKey: 'fixture-key', baseUrl: 'https://gateway.example/v1',
        catalogId: 'custom-openai',
      } },
      generalModels: [{ id: 'gateway-image', name: 'GPT Image 中转', modelId: 'gpt-image-2',
        category: 'image', providerConfigId: 'gateway',
        imageReferenceRequestMode: 'edits-multipart',
        executionProfile: { preset: 'gpt-image-gateway-json' },
      }],
    } }));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImagesBatch({ provider: 'general', model: 'general/gateway-image',
      prompt: '按参考图创作', image_urls: ['https://cdn.example/reference.png'],
    }, 1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/v1/images/generations');
    expect(JSON.parse(String(init.body)).images).toEqual(['https://cdn.example/reference.png']);
  });
  it.each([
    { provider: 'grsai', referenceCount: 2 },
    { provider: 'saved-grsai', referenceCount: 3 },
    { provider: 'general', referenceCount: 3 },
  ])('sends GRSAI native references from local assets in order ($provider)', async ({ provider, referenceCount }) => {
    const connectionId = provider === 'general' ? 'saved-grsai' : provider;
    const legacyModel = {
      id: 'grsai-ref', name: 'Nano Banana 2', modelId: 'nano-banana-2', category: 'image' as const,
      providerConfigId: connectionId, imageReferenceRequestMode: 'edits-multipart' as const,
      executionProfile: { preset: 'openai-image' as const },
    };
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, [connectionId]: {
        name: 'GRSAI', catalogId: 'grsai', apiKey: 'secret', baseUrl: 'https://grsai.dakka.com.cn/v1',
        selectedModels: [{ id: 'nano-banana-2', name: 'Nano Banana 2', provider: 'grsai', category: 'image', imageReferenceRequestMode: 'edits-multipart' }],
      } },
      generalModels: [legacyModel],
    }, nodes: Array.from({ length: referenceCount }, (_, index) => ({
      id: `grs-ref-${index}`, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: `参考${index}`, imageUrl: `asset://localhost/grs-${index}.png`, sourceUrl: `https://expired.example/grs-${index}.png` },
    })) }));
    const savedConfig = structuredClone(useAppStore.getState().config);
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (
      new Response(String(url), { headers: { 'Content-Type': 'image/png' } })
    ));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/grs-result.png' }] }));
    const result = await generateImagesBatch({
      provider, model: provider === 'general' ? 'general/grsai-ref' : `${provider}/nano-banana-2`,
      prompt: `${Array.from({ length: referenceCount }, (_, index) => `@{grs-ref-${index}:参考${index}}`).join('')} 合影`,
      imageSize: '2K', aspectRatio: '16:9',
    }, 1);
    expect(result.results[0].url).toBe('https://cdn.example/grs-result.png');
    expect(localFetch).toHaveBeenCalledTimes(referenceCount);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/api/generate');
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(['aspectRatio', 'imageSize', 'images', 'model', 'prompt', 'replyType']);
    expect(body).toMatchObject({ model: 'nano-banana-2', aspectRatio: '16:9', imageSize: '2K', replyType: 'json' });
    expect(body.images.map((dataUrl: string) => atob(dataUrl.split(',')[1]))).toEqual(
      Array.from({ length: referenceCount }, (_, index) => `asset://localhost/grs-${index}.png`),
    );
    expect(body.prompt).not.toContain('@{');
    expect(useAppStore.getState().config).toEqual(savedConfig);
  });

  it('uses the GRSAI default base URL and native GPT size fields for text-only requests', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { grsai: { name: 'GRSAI', apiKey: 'secret' } },
    } }));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/gpt.png' }] }));
    const result = await generateImagesBatch({ provider: 'grsai', model: 'grsai/gpt-image-2-vip', prompt: '海报', imageSize: '4K', aspectRatio: '16:9' }, 1);
    expect(result.results[0]).toEqual({ url: 'https://cdn.example/gpt.png', width: 3840, height: 2160 });
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0];
    expect(url).toBe('https://grsai.dakka.com.cn/v1/api/generate');
    expect(JSON.parse(init.body)).toEqual({ model: 'gpt-image-2-vip', prompt: '海报', images: [], aspectRatio: '3840x2160', quality: 'medium', replyType: 'json' });
  });

  it.each([
    { status: 400, payload: { error: 'reference image rejected' }, message: 'reference image rejected' },
    { status: 504, payload: { error: 'gateway timeout' }, message: '504' },
    { status: 200, payload: { status: 'failed', error: 'generation failed' }, message: 'generation failed' },
    { status: 200, payload: { status: 'violation', error: 'request rejected' }, message: 'request rejected' },
    { status: 200, payload: { status: 'running', id: 'unfinished-task' }, message: '不要重复提交' },
    { status: 200, payload: { status: 'succeeded', results: [] }, message: '未找到配置的结果' },
  ])('does not resubmit GRSAI on failed/unknown responses ($message)', async ({ status, payload, message }) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'secret' } } } }));
    transportMocks.corsSafeFetch.mockResolvedValue(new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }));
    await expect(generateImagesBatch({ provider: 'grsai', model: 'grsai/nano-banana-2', prompt: '合影' }, 3)).rejects.toThrow(message);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps GRSAI batch successes and stops submitting when a later item fails', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'secret' } } } }));
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/first.png' }] }))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', error: 'failed' }));
    const result = await generateImagesBatch({ provider: 'grsai', model: 'grsai/nano-banana-2', prompt: '合影' }, 3);
    expect(result.results.map((item) => item.url)).toEqual(['https://cdn.example/first.png']);
    expect(result.failedCount).toBe(2);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('cancels GRSAI without starting a second batch request', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { grsai: { name: 'GRSAI', apiKey: 'secret' } } } }));
    const controller = new AbortController();
    transportMocks.corsSafeFetch.mockImplementation(async (_url, init) => {
      expect(init.signal).toBe(controller.signal);
      controller.abort();
      return jsonResponse({ status: 'succeeded', results: [{ url: 'https://cdn.example/late.png' }] });
    });
    await expect(generateImagesBatch({ provider: 'grsai', model: 'grsai/nano-banana-2', prompt: '合影' }, 2, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated node references: A B B uploads two images, A B C uploads three', async () => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, cccapi: { name: 'CCC', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1' } },
    }, nodes: ['a', 'b', 'c'].map((id) => ({
      id, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: id, imageUrl: `asset://localhost/${id}.png` },
    })) }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('png', { headers: { 'Content-Type': 'image/png' } }));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    for (const [prompt, count] of [['@{a:a}@{b:b}@{b:b}', 2], ['@{a:a}@{b:b}@{c:c}', 3]] as const) {
      await generateImagesBatch({ provider: 'cccapi', model: 'cccapi/gpt-image-2', prompt: `${prompt} 合影` }, 1);
      const body = transportMocks.corsSafeFetch.mock.calls.at(-1)![1].body as FormData;
      expect(body.getAll('image[]')).toHaveLength(count);
    }
  });

  it('includes actual model, reference count, transfer size and elapsed time on transport failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('image', { headers: { 'Content-Type': 'image/png' } }));
    transportMocks.corsSafeFetch.mockRejectedValue(new Error('connection reset'));
    const error = await generateImageStandard({
      apiKey: 'secret', baseUrl: 'https://gateway.example/v1', modelName: 'gpt-image-2', prompt: 'private prompt',
      dimensions: { width: 1024, height: 1024 }, imageReferenceRequestMode: 'edits-multipart',
      imageUrls: ['asset://localhost/private.png'],
    }).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('connection reset');
    expect(message).toContain('模型 gpt-image-2；参考图 1 张，共 0.00 MiB；输出 1024x1024；等待');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('private');
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('submits four CCC prompt references once in order and does not retry a gateway 504', async () => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, cccapi: { name: 'CCC', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1' } },
      generalModels: [{ id: 'ccc-four', name: 'GPT Image 2', modelId: 'gpt-image-2', category: 'image', providerConfigId: 'cccapi' }],
    }, nodes: Array.from({ length: 4 }, (_, index) => ({
      id: `ref-${index}`, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: `参考${index}`, imageUrl: `asset://localhost/reference-${index}.png`, sourceUrl: `https://expired.example/${index}.png` },
    })) }));
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (
      new Response(String(url), { headers: { 'Content-Type': 'image/png' } })
    ));
    transportMocks.corsSafeFetch.mockResolvedValue(new Response('<html><body>504 Gateway Time-out nginx</body></html>', {
      status: 504, headers: { 'Content-Type': 'text/html' },
    }));
    await expect(generateImagesBatch({
      provider: 'general', model: 'general/ccc-four',
      prompt: '@{ref-0:参考0}@{ref-1:参考1}@{ref-2:参考2}@{ref-3:参考3} 他们两个人一起合影',
    }, 1)).rejects.toThrow('网关等待上游响应超时');
    expect(localFetch).toHaveBeenCalledTimes(4);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1/images/edits');
    const body = init.body as FormData;
    const files = body.getAll('image[]') as File[];
    expect(files).toHaveLength(4);
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(
      Array.from({ length: 4 }, (_, index) => `asset://localhost/reference-${index}.png`),
    );
    expect(body.get('n')).toBe('1');
  });

  it.each(['cccapi', 'legacy-ccc', 'general'])('uses CCC catalog multipart before uploading references (%s)', async (provider) => {
    const connectionId = provider === 'general' ? 'legacy-ccc' : provider;
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, [connectionId]: {
        name: 'CCC', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1',
        ...(provider === 'cccapi' ? {} : { catalogId: 'cccapi' }),
      } },
      generalModels: [{ id: 'old-image', name: 'GPT Image 2', modelId: 'gpt-image-2',
        category: 'image', providerConfigId: connectionId }],
    } }));
    const localUrl = 'asset://localhost/D%3A%2Fproject%2Freference.png';
    useAppStore.setState({ nodes: [{ id: 'ref', type: 'ai-image', position: { x: 0, y: 0 }, data: {
      label: 'reference', type: 'ai-image', imageUrl: localUrl, sourceUrl: 'https://expired.example/old.png',
    } }] });
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url !== localUrl) throw new Error('Unexpected upload');
      return new Response(Uint8Array.from([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
    });
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    const params = { provider, model: provider === 'general' ? 'general/old-image' : `${provider}/gpt-image-2`, prompt: 'edit' };
    for (let attempt = 0; attempt < 2; attempt++) {
      await generateImagesBatch(attempt === 0 ? { ...params, image_urls: [localUrl] }
        : { ...params, prompt: '@{ref:reference} edit' }, 1);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)! as [string, RequestInit];
      expect(url).toBe('https://cccapi.cn/v1/images/edits');
      expect((init.body as FormData).getAll('image[]')).toHaveLength(1);
    }
    expect(localFetch).toHaveBeenCalledTimes(2);
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    await generateImagesBatch(params, 1);
    expect(transportMocks.corsSafeFetch.mock.calls.at(-1)![0]).toBe('https://cccapi.cn/v1/images/generations');
  });

  it.each([true, false])('respects a custom gateway JSON reference mode (explicit mode: %s)', async (explicitMode) => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: {
      ...state.config.providers, gateway: { name: 'gateway', apiKey: 'secret', baseUrl: 'https://gateway.example/v1', catalogId: 'custom-openai',
        selectedModels: explicitMode ? [{ id: 'gpt-image-2', name: 'image', provider: 'gateway', category: 'image', imageReferenceRequestMode: 'generation-json-image-urls' }] : [],
      },
    } } }));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ data: [{ url: 'https://cdn.example/result.png' }] }));
    await generateImagesBatch({ provider: 'gateway', model: 'gateway/gpt-image-2', prompt: 'edit', image_urls: ['https://cdn.example/ref.png'] }, 1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/v1/images/generations');
    expect(JSON.parse(init.body as string).image_urls).toEqual(['https://cdn.example/ref.png']);
  });

  it.each([
    { referenceCount: 2, legacyMode: 'generation-json-image-urls' as const, legacyPreset: 'custom' as const },
    { referenceCount: 3, legacyMode: 'generation-json-image-data-urls' as const, legacyPreset: 'openai-image' as const },
  ])('uses the CCC Sunburst standard contract despite legacy settings ($referenceCount references)', async ({ referenceCount, legacyMode, legacyPreset }) => {
    const modelId = 'gpt-image-2.5-sunburst';
    const legacyProfile = {
      preset: legacyPreset,
      protocol: {
        version: 2 as const,
        mode: 'sync' as const,
        submit: { method: 'POST' as const, path: '/images/generations', body: {
          model: '{{model}}', prompt: '{{prompt}}', image_urls: '{{imageUrls}}', resolution: '{{imageSize}}',
        } },
        response: { type: 'json' as const, result: { urlPath: 'data.*.url' } },
      },
    };
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, ccc: {
        name: 'CCC API', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi',
        selectedModels: [{ id: modelId, name: modelId, category: 'image', provider: 'cccapi',
          imageReferenceRequestMode: legacyMode, executionProfile: legacyProfile }],
      } },
      generalModels: [{ id: modelId, name: modelId, modelId, category: 'image', providerConfigId: 'ccc',
        imageReferenceRequestMode: legacyMode, executionProfile: legacyProfile }],
    }, nodes: Array.from({ length: referenceCount }, (_, index) => ({
      id: `person-${index}`, type: 'ai-image', position: { x: 0, y: 0 },
      data: { type: 'ai-image', label: `人物${index + 1}`, imageUrl: `asset://localhost/person-${index}.png`,
        sourceUrl: `https://expired.example/person-${index}.png` },
    })) }));
    const savedConfig = useAppStore.getState().config;
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (!String(url).startsWith('asset://localhost/person-')) throw new Error('Unexpected upload');
      return new Response(String(url), { headers: { 'Content-Type': 'image/png' } });
    });
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({ data: [{ b64_json: 'aW1hZ2U=' }] }));

    const params = { provider: 'general', model: `general/${modelId}`, imageSize: '2K', aspectRatio: '16:9',
      prompt: Array.from({ length: referenceCount }, (_, index) => `@{person-${index}:人物${index + 1}}`).join('') + '一起合影' };
    await expect(generateImagesBatch(params, 1)).resolves.toMatchObject({
      results: [{ url: 'data:image/png;base64,aW1hZ2U=' }],
    });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cccapi.cn/v1/images/edits');
    const body = init.body as FormData;
    expect([...new Set(body.keys())].sort()).toEqual(['image[]', 'model', 'n', 'prompt', 'quality', 'size']);
    expect(body.get('quality')).toBe('auto');
    expect(body.get('model')).toBe(modelId);
    expect(body.get('n')).toBe('1');
    expect(body.get('size')).toBe('3648x2048');
    expect(body.get('prompt')).toContain(`本次请求附带 ${referenceCount} 张参考图`);
    const files = body.getAll('image[]') as File[];
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(
      Array.from({ length: referenceCount }, (_, index) => `asset://localhost/person-${index}.png`),
    );
    expect(localFetch).toHaveBeenCalledTimes(referenceCount);

    await expect(generateImagesBatch({ ...params, prompt: '风景' }, 1)).resolves.toMatchObject({
      results: [{ url: 'data:image/png;base64,aW1hZ2U=' }],
    });
    const [generationUrl, generationInit] = transportMocks.corsSafeFetch.mock.calls[1] as [string, RequestInit];
    expect(generationUrl).toBe('https://cccapi.cn/v1/images/generations');
    expect(JSON.parse(generationInit.body as string)).toEqual({ model: modelId, prompt: '风景', n: 1, size: '3648x2048', quality: 'auto' });
    expect(useAppStore.getState().config).toBe(savedConfig);
    expect(savedConfig.generalModels?.[0].executionProfile).toEqual(legacyProfile);
  });

  it.each([
    { catalogId: 'custom-openai', modelId: 'gpt-image-2.5-sunburst' },
    { catalogId: 'cccapi', modelId: 'vendor-image' },
    { catalogId: 'custom-openai', modelId: 'nano-banana-2' },
    { catalogId: 'grsai', modelId: 'vendor-image' },
  ])('preserves the explicit protocol outside documented built-in image contracts ($catalogId/$modelId)', async ({ catalogId, modelId }) => {
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, custom: {
        name: '自定义接口', apiKey: 'secret', baseUrl: 'https://gateway.example/v1', catalogId,
      } },
      generalModels: [{ id: 'custom-image', name: modelId, modelId, category: 'image', providerConfigId: 'custom',
        executionProfile: { preset: 'custom', protocol: {
          version: 2, mode: 'sync',
          submit: { method: 'POST', path: '/vendor/image-render', body: {
            model: '{{model}}', prompt: '{{prompt}}', images: '{{imageUrls}}',
          } },
          response: { type: 'json', result: { urlPath: 'output.image' } },
        } },
      }],
    } }));
    transportMocks.corsSafeFetch.mockResolvedValue(jsonResponse({ output: { image: 'https://cdn.example/result.png' } }));
    await expect(generateImagesBatch({
      provider: 'general', model: 'general/custom-image', prompt: 'edit', image_urls: ['https://cdn.example/reference.png'],
    }, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/result.png' }] });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/v1/vendor/image-render');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: modelId, images: ['https://cdn.example/reference.png'] });
  });

  it.each([false, true])('submits the current ratio after editing an image node (drag duplicate: %s)', async (duplicate) => {
    const reference = 'data:image/png;base64,iVBORw==';
    useAppStore.setState((state) => ({
      config: { ...state.config,
        providers: { ...state.config.providers, ccc: {
          name: 'CCC', apiKey: 'secret', baseUrl: 'https://cccapi.cn/v1', catalogId: 'cccapi',
        } },
        generalModels: [{ id: 'ccc-image', name: 'GPT Image 2', modelId: 'gpt-image-2',
          category: 'image', providerConfigId: 'ccc', imageReferenceRequestMode: 'edits-multipart',
        }],
      },
      nodes: [
        { id: 'reference', type: 'ai-image', position: { x: 0, y: 0 },
          data: { type: 'ai-image', label: '参考图', imageUrl: reference } },
        { id: 'image', type: 'ai-image', position: { x: 300, y: 0 },
          data: { type: 'ai-image', label: '生成图', model: 'general/ccc-image', provider: 'general',
            prompt: '@{reference:参考图} 新场景', imageSize: '2K', aspectRatio: '16:9',
            imageUrl: reference, imageWidth: 1024, imageHeight: 1024, nodeWidth: 280, nodeHeight: 280,
          } },
      ],
    }));
    if (duplicate) useAppStore.getState().duplicateNode('image');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      Uint8Array.from([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } },
    ));
    transportMocks.corsSafeFetch.mockImplementation(async () => jsonResponse({
      data: [{ url: 'https://cdn.example/result.png' }],
    }));
    for (const [ratio, size, orientation] of [['16:9', '3648x2048', '横屏'], ['9:16', '2048x3648', '竖屏'], ['3:4', '2048x2736', '竖屏'], ['1:1', '2048x2048', '正方形']]) {
      useAppStore.getState().updateNodeData('image', { aspectRatio: ratio, prompt: '@{reference:参考图} 修改后的场景' });
      const data = useAppStore.getState().nodes.find((node) => node.id === 'image')!.data;
      await generateImagesBatch({ prompt: data.prompt!, model: data.model!, provider: data.provider!,
        imageSize: data.imageSize, aspectRatio: data.aspectRatio, nodeId: 'image',
      }, 1);
      const [url, init] = transportMocks.corsSafeFetch.mock.calls.at(-1)! as [string, RequestInit];
      expect(url).toBe('https://cccapi.cn/v1/images/edits');
      const body = init.body as FormData;
      expect(body.get('size')).toBe(size);
      expect(body.getAll('image[]')).toHaveLength(1);
      expect(body.get('prompt')).toContain(`${ratio}（${orientation}，宽:高）`);
      expect(body.get('prompt')).toContain('不继承参考图或旧图的宽高比');
      expect(body.get('prompt')).not.toContain('复制版式、构图与设计语言时以对应参考图为准');
    }
    await generateImagesBatch({ prompt: '@{reference:参考图} 修改后的场景',
      model: 'general/ccc-image', provider: 'general', aspectRatio: '自适应', nodeId: 'image',
    }, 1);
    const adaptive = transportMocks.corsSafeFetch.mock.calls.at(-1)![1].body as FormData;
    expect(adaptive.get('prompt')).not.toContain('【输出画幅】');
  });

  it.each([true, false])('preserves a custom multipart endpoint and response mapping (explicit mode: %s)', async (explicitMode) => {
    const imported = analyzeModelProtocolExamples({
      submitRequest: `curl https://gateway.example/v1/custom/images/edit
        -H 'Authorization: Bearer sk-placeholder'
        -F 'model=custom-image' -F 'prompt=edit'
        -F 'images=@/private/reference.png'`,
      submitResponse: '{"output":{"url":"https://cdn.example/custom-result.png"}}',
    });
    useAppStore.setState((state) => ({ config: {
      ...state.config,
      providers: { ...state.config.providers, custom: {
        name: '自定义接口', apiKey: 'secret', baseUrl: imported.baseUrl!, catalogId: 'custom-openai',
      } },
      generalModels: [{ id: 'custom-image', name: '自定义图片', modelId: 'custom-image',
        category: 'image', providerConfigId: 'custom',
        imageReferenceRequestMode: explicitMode ? 'edits-multipart' : undefined,
        executionProfile: { preset: 'custom', protocol: imported.protocol! },
      }],
    } }));
    const nativeFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected upload'));
    transportMocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url === 'https://cdn.example/reference.png') return new Response(
        Uint8Array.from([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } },
      );
      if (url === 'https://gateway.example/v1/custom/images/edit') return jsonResponse({
        output: { url: 'https://cdn.example/custom-result.png' },
      });
      throw new Error('Unexpected endpoint');
    });
    const controller = new AbortController();
    const params = { provider: 'general', model: 'general/custom-image', prompt: 'edit',
      image_urls: ['data:image/jpeg;base64,aGVsbG8=', 'https://cdn.example/reference.png'] };
    await expect(generateImagesBatch(params, 1, controller.signal)).resolves.toMatchObject({
      results: [{ url: 'https://cdn.example/custom-result.png' }],
    });
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    const init = transportMocks.corsSafeFetch.mock.calls[1][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
    const body = new TextDecoder().decode(init.body as ArrayBuffer);
    expect(body.split('name="images"; filename=')).toHaveLength(3);
    expect(body).toContain('Content-Type: image/jpeg');
    expect(body).toContain('Content-Type: image/png');
    controller.abort();
    await expect(generateImagesBatch(params, 1, controller.signal)).rejects.toThrow();
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
  });

  it('reproduces the reference-field warning for a text-only custom protocol despite an edits mode setting', async () => {
    const imported = analyzeModelProtocolExamples({
      submitRequest: `curl https://gateway.example/v1/images/generations
        -H 'Content-Type: application/json'
        -d '{"model":"gpt-image-2","prompt":"draw"}'`,
      submitResponse: '{"data":[{"url":"https://cdn.example/result.png"}]}',
    });
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, wm: { name: 'WM', apiKey: 'secret', baseUrl: imported.baseUrl! } },
      generalModels: [{ id: 'wm-image', name: 'gpt-image-2', modelId: 'gpt-image-2', category: 'image',
        providerConfigId: 'wm', imageReferenceRequestMode: 'edits-multipart',
        executionProfile: { preset: 'custom', protocol: imported.protocol! },
      }],
    } }));
    await expect(generateImagesBatch({ provider: 'general', model: 'general/wm-image', prompt: 'edit',
      image_urls: ['https://cdn.example/ref.png'],
    }, 1)).rejects.toThrow('没有完整接收参考图');
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalled();
  });

  it('adds actionable guidance to ambiguous API Key errors', async () => {
    const response = new Response(JSON.stringify({
      error: { message: 'apikey error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    await expect(parseResponseError(response, '图片生成失败 (400)')).rejects.toThrow(
      'apikey error（请确认使用模型 API Key，而非账户令牌；若密钥正确，请检查账户权限和积分余额）',
    );
  });

  it('reads the top-level error string used by the new GRSAI generation API', async () => {
    const response = new Response(JSON.stringify({
      id: '',
      status: 'failed',
      error: 'insufficient credits',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    await expect(parseResponseError(response, '图片生成失败 (400)')).rejects.toThrow(
      'insufficient credits',
    );
  });

  it('routes ordinary text generation through the shared transport', async () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          apimart: { name: 'APIMart', apiKey: 'secret', baseUrl: 'https://gateway.example/v1' },
        },
      },
    }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: '文本结果' } }],
    }));

    await expect(generateText({
      provider: 'apimart',
      model: 'apimart/vendor-chat',
      prompt: '你好',
    })).resolves.toBe('文本结果');

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('routes standard image generation through the shared transport', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ url: 'https://cdn.example/image.png' }],
    }));

    await expect(generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelName: 'gpt-image-1',
      prompt: '一张图片',
      dimensions: { width: 1024, height: 1024 },
      imageReferenceRequestMode: 'edits-multipart',
    })).resolves.toMatchObject({ url: 'https://cdn.example/image.png' });

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps JSON image_urls generation for compatible reference-image providers', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ url: 'https://cdn.example/generated.png' }],
    }));

    await generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelName: 'gpt-image-2',
      prompt: '参考角色生成场景',
      dimensions: { width: 1536, height: 1024 },
      imageUrls: ['https://cdn.example/reference.png'],
      imageReferenceRequestMode: 'generation-json-image-urls',
    });

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(1);
    const [, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-image-2',
      image_urls: ['https://cdn.example/reference.png'],
    });
  });

  it('sends base64 reference arrays through the JSON image field', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      data: [{ url: 'https://cdn.example/generated.png' }],
    }));
    const image = 'data:image/png;base64,iVBORw0KGgo=';

    await generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      modelName: 'custom-image-model',
      prompt: '参考角色生成场景',
      dimensions: { width: 1024, height: 1024 },
      imageUrls: [image],
      imageReferenceRequestMode: 'generation-json-image-data-urls',
    });

    const [, init] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'custom-image-model',
      image: [image],
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty('image_urls');
  });

  it('converts remote reference images into base64 data URLs', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(
      Uint8Array.from([137, 80, 78, 71]),
      { status: 200, headers: { 'Content-Type': 'image/png' } },
    ));

    await expect(resolveImageDataUrlArray([
      'https://cdn.example/reference.png',
    ])).resolves.toEqual([
      'data:image/png;base64,iVBORw==',
    ]);
  });

  it('keeps data URL references in a configured async image protocol', async () => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          rightapi: {
            name: 'RightAPI',
            apiKey: 'secret',
            baseUrl: 'https://www.right.codes/draw/v1',
          },
        },
        generalModels: [{
          id: 'rightapi-image',
          name: 'RightAPI 图片',
          modelId: 'nano-banana-fast',
          category: 'image',
          providerConfigId: 'rightapi',
          imageReferenceRequestMode: 'generation-json-image-data-urls',
          executionProfile: {
            preset: 'custom',
            protocol: {
              version: 2,
              mode: 'async',
              submit: {
                method: 'POST',
                path: '/images/generations',
                body: {
                  model: '{{model}}',
                  prompt: '{{prompt}}',
                  n: '{{n}}',
                  size: '{{aspectRatio}}',
                  imageSize: '{{imageSize}}',
                  async: true,
                  image: '{{imageUrls}}',
                },
              },
              response: { type: 'json', taskIdPath: 'task_id' },
              poll: {
                method: 'GET',
                path: '/v1/tasks/{{submit.task_id}}',
                pathMode: 'origin',
                response: {
                  statusPath: 'status',
                  successValues: ['completed'],
                  failureValues: ['failed'],
                  result: { urlPath: 'data.*.url' },
                  errorPath: 'error.message',
                  progressPath: 'progress',
                },
                intervalMs: 1000,
              },
            },
          },
        }],
      },
    }));
    transportMocks.corsSafeFetch
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task-123', status: 'processing' }))
      .mockResolvedValueOnce(jsonResponse({
        task_id: 'task-123',
        status: 'completed',
        progress: 100,
        data: [{ url: 'https://cdn.example/result.png' }],
      }));

    await expect(generateImagesBatch({
      provider: 'general',
      model: 'general/rightapi-image',
      prompt: '改成赛博朋克风格',
      imageSize: '1K',
      aspectRatio: '16:9',
      image_urls: [image],
    }, 1)).resolves.toMatchObject({
      results: [{ url: 'https://cdn.example/result.png' }],
    });

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledTimes(2);
    const [submitUrl, submitInit] = transportMocks.corsSafeFetch.mock.calls[0] as [string, RequestInit];
    expect(submitUrl).toBe('https://www.right.codes/draw/v1/images/generations');
    expect(JSON.parse(String(submitInit.body))).toMatchObject({
      model: 'nano-banana-fast',
      async: true,
      image: [image],
    });
    expect(transportMocks.corsSafeFetch.mock.calls[1]?.[0]).toBe(
      'https://www.right.codes/v1/tasks/task-123',
    );
  });

  it('explains when an image endpoint returns an HTML page instead of JSON', async () => {
    transportMocks.corsSafeFetch.mockResolvedValueOnce(new Response(
      '<!doctype html><html><body>gateway homepage</body></html>',
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      },
    ));

    await expect(generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://realmrouter.cn',
      modelName: 'gpt-image-1',
      prompt: '一张图片',
      dimensions: { width: 1024, height: 1024 },
    })).rejects.toThrow('图片接口返回了 HTML 页面，请检查连接地址是否指向 API 根路径（常见需要追加 /v1）');
  });

  it('uploads configured reference images as multipart files to image edits', async () => {
    transportMocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://cdn.example/reference-')) {
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      return jsonResponse({ data: [{ url: 'https://cdn.example/edited.png' }] });
    });

    await expect(generateImageStandard({
      apiKey: 'secret',
      baseUrl: 'https://realmrouter.cn/v1',
      modelName: 'gpt-image-2',
      prompt: '保持两个人物设定生成新场景',
      dimensions: { width: 1536, height: 1024 },
      imageUrls: [
        'https://cdn.example/reference-1.png',
        'https://cdn.example/reference-2.png',
      ],
      imageReferenceRequestMode: 'edits-multipart',
    })).resolves.toMatchObject({ url: 'https://cdn.example/edited.png' });

    const editsCall = transportMocks.corsSafeFetch.mock.calls.find(
      ([url]) => url === 'https://realmrouter.cn/v1/images/edits',
    ) as [string, RequestInit] | undefined;
    expect(editsCall).toBeDefined();
    const editsInit = editsCall?.[1];
    expect(editsInit?.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(editsInit?.body).toBeInstanceOf(FormData);
    const body = editsInit?.body as FormData;
    expect(body.get('model')).toBe('gpt-image-2');
    expect(body.get('prompt')).toBe('保持两个人物设定生成新场景');
    expect(body.get('size')).toBe('1536x1024');
    expect(body.getAll('image[]')).toHaveLength(2);
    expect(body.getAll('image')).toHaveLength(0);
    expect(transportMocks.corsSafeFetch).not.toHaveBeenCalledWith(
      'https://realmrouter.cn/v1/images/generations',
      expect.anything(),
    );
  });

  it.each([
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5',
    'gpt-image-2',
  ])('routes CCC API %s references through image edits while keeping text-only generations', async (modelId) => {
    const cccModel = (getProviderDefinition('cccapi')?.models ?? [])
      .find((item) => item.id === modelId);
    expect(cccModel?.imageReferenceRequestMode).toBe('edits-multipart');
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          'cccapi-image': {
            name: 'CCC API 图片',
            apiKey: 'secret',
            baseUrl: 'https://cccapi.cn/v1',
            catalogId: 'cccapi',
          },
        },
        generalModels: [{
          id: `cccapi-${modelId}`,
          name: cccModel?.name ?? modelId,
          modelId: cccModel?.id ?? modelId,
          category: 'image',
          providerConfigId: 'cccapi-image',
          imageReferenceRequestMode: cccModel?.imageReferenceRequestMode,
        }],
      },
    }));
    transportMocks.corsSafeFetch.mockImplementation(async (url: string) => {
      if (url === 'https://cdn.example/reference.png') {
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      if (url === 'https://cccapi.cn/v1/images/edits') {
        return jsonResponse({ data: [{ url: 'https://cdn.example/edited.png' }] });
      }
      return jsonResponse({ data: [{ url: 'https://cdn.example/generated.png' }] });
    });

    await expect(generateImagesBatch({
      provider: 'general',
      model: `general/cccapi-${modelId}`,
      prompt: '保持人物设定生成新场景',
      imageSize: '1K',
      aspectRatio: '1:1',
      image_urls: ['https://cdn.example/reference.png'],
    }, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/edited.png' }] });

    const editsCall = transportMocks.corsSafeFetch.mock.calls.find(
      ([url]) => url === 'https://cccapi.cn/v1/images/edits',
    ) as [string, RequestInit] | undefined;
    expect(editsCall?.[1].body).toBeInstanceOf(FormData);
    expect((editsCall?.[1].body as FormData).getAll('image[]')).toHaveLength(1);

    // 本地图片应直接读取后随 multipart 提交，不上传第三方图床。
    const localReference = 'data:image/png;base64,iVBORw==';
    const localFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (input !== localReference) throw new Error('Unexpected external upload');
      return new Response(Uint8Array.from([137, 80, 78, 71]), {
        headers: { 'Content-Type': 'image/png' },
      });
    });
    transportMocks.corsSafeFetch.mockClear();
    await expect(generateImagesBatch({
      provider: 'general',
      model: `general/cccapi-${modelId}`,
      prompt: '结合本地和远程参考图生成场景',
      imageSize: '1K',
      aspectRatio: '1:1',
      image_urls: [localReference, 'https://cdn.example/reference.png'],
    }, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/edited.png' }] });
    expect(localFetch).toHaveBeenCalledTimes(1);
    expect(localFetch).toHaveBeenCalledWith(localReference, expect.any(Object));
    expect(transportMocks.corsSafeFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://cdn.example/reference.png',
      'https://cccapi.cn/v1/images/edits',
    ]);
    const mixedBody = transportMocks.corsSafeFetch.mock.calls[1][1].body as FormData;
    const files = mixedBody.getAll('image[]') as File[];
    expect(files).toHaveLength(2);
    expect(files.map((file) => [file.type, file.size])).toEqual([
      ['image/png', 4], ['image/png', 4],
    ]);

    await expect(generateImagesBatch({
      provider: 'general',
      model: `general/cccapi-${modelId}`,
      prompt: '纯文本生成一张图',
      imageSize: '1K',
      aspectRatio: '1:1',
    }, 1)).resolves.toMatchObject({ results: [{ url: 'https://cdn.example/generated.png' }] });
    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://cccapi.cn/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('routes assistant streaming requests through the shared transport', async () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        assistantModelId: 'assistant-model',
        providers: {
          ...state.config.providers,
          'custom-assistant': {
            name: '自定义助手连接',
            apiKey: 'secret',
            baseUrl: 'https://gateway.example/v1',
            catalogId: 'custom-openai',
          },
        },
        generalModels: [{
          id: 'assistant-model',
          name: '自定义助手',
          modelId: 'vendor-chat',
          category: 'text',
          providerConfigId: 'custom-assistant',
          executionProfile: { preset: 'openai-chat' },
        }],
      },
    }));
    transportMocks.corsSafeFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { content: '助手结果' }, finish_reason: 'stop' }],
    }));

    await expect(streamAssistantReply({
      systemPrompt: '系统',
      userMessage: '你好',
      nonStream: true,
      onEvent: vi.fn(),
    })).resolves.toBe('助手结果');

    expect(transportMocks.corsSafeFetch).toHaveBeenCalledWith(
      'https://gateway.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
  });
});
