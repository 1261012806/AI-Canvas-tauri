import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelExecutionProtocolV2 } from '../../src/types/aiTypes';
import {
  executeModelProtocol,
  parseModelExecutionProtocol,
  pollResolvedModelProtocol,
  submitModelProtocol,
} from '../../src/services/ai/modelProtocol';

const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' },
});
const video = () => new Response(new Uint8Array([1, 2, 3]), {
  headers: { 'Content-Type': 'video/mp4' },
});
const fixture = (): ModelExecutionProtocolV2 => ({
  version: 2,
  mode: 'async',
  submit: { method: 'POST', path: '/videos', body: { model: '{{model}}', prompt: '{{prompt}}' } },
  response: { type: 'json', taskIdPath: 'id' },
  poll: {
    method: 'GET', path: '/videos/{{submit.id}}',
    response: {
      statusPath: 'status', successValues: ['completed'], failureValues: ['failed'],
      result: {
        mimeType: 'video/mp4',
        download: { method: 'GET', path: '/videos/{{submit.id}}/content', headers: { Accept: 'video/mp4' } },
      },
    },
  },
});
const options = () => ({
  protocol: fixture(), baseUrl: 'https://gateway.example/v1', apiKey: 'connection-secret',
  variables: { model: 'custom-video', prompt: 'private prompt' },
});

beforeEach(() => vi.unstubAllGlobals());

describe('declarative task result download', () => {
  it.each(['download', 'fetch-url'] as const)('redacts credentials from a failed %s result without re-submitting generation', async (mode) => {
    const config = options();
    config.apiKey = 'fixture+download/private';
    if (mode === 'fetch-url') {
      config.protocol.poll!.response.result = { mimeType: 'video/mp4', urlPath: 'url', fetchUrl: true };
    }
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ id: 'original-task' }))
      .mockResolvedValueOnce(json({ status: 'completed', url: 'https://gateway.example/v1/content' }))
      .mockResolvedValueOnce(new Response(`Invalid key ${config.apiKey}; encoded=${encodeURIComponent(config.apiKey)}`, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await executeModelProtocol(config).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: 'ModelProtocolHttpError', status: 403 });
    expect((error as Error).message).toContain('模型结果下载失败');
    expect((error as Error).message).toContain('[REDACTED]');
    expect((error as Error).message).not.toContain(config.apiKey);
    expect((error as Error).message).not.toContain(encodeURIComponent(config.apiKey));
    expect((error as Error).stack).not.toContain(config.apiKey);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('downloads binary content after successful polling without requiring a result URL', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ id: 'video-1' }))
      .mockResolvedValueOnce(json({ status: 'completed' })).mockResolvedValueOnce(video());
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const result = await executeModelProtocol({ ...options(), signal: controller.signal });
    expect(result).toEqual({ urls: ['data:video/mp4;base64,AQID'], taskId: 'video-1' });
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://gateway.example/v1/videos/video-1/content',
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal),
        headers: { Accept: 'video/mp4', Authorization: 'Bearer connection-secret' } }));
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it('resumes the captured download request with the current connection key and no submit payload', async () => {
    const config = options();
    config.protocol.auth = { type: 'query', name: 'key' };
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ id: 'video-2', unrelated: 'untrusted full response' }))
      .mockResolvedValueOnce(json({ status: 'completed' })).mockResolvedValueOnce(video());
    vi.stubGlobal('fetch', fetchMock);
    const submitted = await submitModelProtocol(config);
    const snapshot = JSON.stringify(submitted.poll);
    expect(snapshot).not.toContain('connection-secret');
    expect(snapshot).not.toContain('private prompt');
    expect(snapshot).not.toContain('untrusted full response');
    const result = await pollResolvedModelProtocol(JSON.parse(snapshot), 'rotated-key', undefined, config.baseUrl);
    expect(result.urls).toEqual(['data:video/mp4;base64,AQID']);
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://gateway.example/v1/videos/video-2/content?key=rotated-key',
      expect.objectContaining({ headers: { Accept: 'video/mp4' } }));
  });

  it.each([
    ['absolute path', { path: 'https://other.example/content' }],
    ['network path', { path: '//other.example/content' }],
    ['write method', { method: 'POST' }],
    ['fixed task', { path: '/videos/fixed/content' }],
    ['auth override', { headers: { Authorization: 'Bearer injected' } }],
    ['request body', { body: { task: '{{submit.id}}' } }],
    ['unknown variable', { path: '/videos/{{apiKey}}/{{submit.id}}/content' }],
  ])('rejects unsafe download configuration: %s', async (_label, patch) => {
    const config = options();
    Object.assign(config.protocol.poll!.response.result.download!, patch);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(executeModelProtocol(config)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires download and response result mappings to be separate alternatives', () => {
    const protocol = fixture();
    protocol.poll!.response.result.urlPath = 'url';
    expect(() => parseModelExecutionProtocol(protocol)).toThrow('不能同时');
    protocol.mode = 'sync';
    protocol.response.result = protocol.poll!.response.result;
    expect(() => parseModelExecutionProtocol(protocol)).toThrow('仅支持异步');
  });

  it.each(['origin', 'headers', 'header shape', 'header value'] as const)('rechecks a restored download request: %s', async (field) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ id: 'video-3' }));
    vi.stubGlobal('fetch', fetchMock);
    const submitted = await submitModelProtocol(options());
    const poll = submitted.poll!;
    if (field === 'origin') poll.resultDownload!.url = 'https://other.example/content';
    else if (field === 'headers') poll.resultDownload!.headers = { Authorization: 'Bearer injected' };
    else if (field === 'header shape') Object.assign(poll.resultDownload!, { headers: [] });
    else Object.assign(poll.resultDownload!, { headers: { Accept: 123 } });
    fetchMock.mockClear();
    await expect(pollResolvedModelProtocol(poll, 'secret', undefined, options().baseUrl)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports download failure without retrying the paid submission', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ id: 'video-4' }))
      .mockResolvedValueOnce(json({ status: 'completed' }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(executeModelProtocol(options())).rejects.toThrow('模型结果下载失败');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not download a failed task or start a download after cancellation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ id: 'video-5' }))
      .mockResolvedValueOnce(json({ status: 'failed' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(executeModelProtocol(options())).rejects.toThrow('模型任务失败');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    fetchMock.mockReset().mockResolvedValueOnce(json({ id: 'video-6' }))
      .mockImplementationOnce(async () => { controller.abort(); return json({ status: 'completed' }); });
    await expect(executeModelProtocol({ ...options(), signal: controller.signal })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not deliver content when cancelled while reading the download', async () => {
    const controller = new AbortController();
    const response = video();
    const reader = response.body!.getReader();
    vi.spyOn(response.body!, 'getReader').mockReturnValue(reader);
    vi.spyOn(reader, 'read').mockImplementationOnce(async () => {
      controller.abort();
      return { done: false, value: new Uint8Array([1, 2, 3]) };
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ id: 'video-7' }))
      .mockResolvedValueOnce(json({ status: 'completed' })).mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(executeModelProtocol({ ...options(), signal: controller.signal })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('bounds a stalled binary result read and cancels only that download request', async () => {
    vi.useFakeTimers();
    try {
      let downloadSignal!: AbortSignal;
      const fetchMock = vi.fn().mockResolvedValueOnce(json({ id: 'stalled-binary' }))
        .mockResolvedValueOnce(json({ status: 'completed' }))
        .mockImplementationOnce(async (_url, init) => {
          downloadSignal = init.signal;
          const response = video();
          const reader = response.body!.getReader();
          vi.spyOn(response.body!, 'getReader').mockReturnValue(reader);
          vi.spyOn(reader, 'read').mockReturnValue(new Promise<ReadableStreamReadResult<Uint8Array<ArrayBuffer>>>(() => {}));
          return response;
        });
      vi.stubGlobal('fetch', fetchMock);
      const pending = executeModelProtocol(options());
      const rejected = expect(pending).rejects.toMatchObject({ name: 'PollTimeoutError' });
      await vi.advanceTimersByTimeAsync(120_000);
      await rejected;
      expect(downloadSignal.aborted).toBe(true);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});
