import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateOutpaintImage } from '../../src/services/apimartService';

const apiKey = 'fixture~! private/key=';
const echoed = () => [apiKey, encodeURIComponent(apiKey), new URLSearchParams({ key: apiKey }).toString().slice(4)].join(' | ');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const remoteParams = { apiKey, model: 'gpt-image-2', imageUrl: 'https://images.example/source.png', size: '1:1' };
const localParams = { ...remoteParams, imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vYkAAAAASUVORK5CYII=' };

describe('APIMart 扩图错误边界', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each(['upload', 'submit', 'query'] as const)('%s 的 HTTP 错误进入调用方前移除原始和编码 Key', async (stage) => {
    const fetchMock = vi.fn();
    if (stage === 'query') fetchMock.mockResolvedValueOnce(json({ data: [{ task_id: 'original-task' }] }));
    fetchMock.mockResolvedValueOnce(json({ error: { message: echoed() } }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const error = await generateOutpaintImage(stage === 'upload' ? localParams : remoteParams).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[REDACTED]');
    for (const secret of echoed().split(' | ')) expect((error as Error).message).not.toContain(secret);
    expect(fetchMock.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).includes('/images/generations')))
      .toHaveLength(stage === 'upload' ? 0 : 1);
    expect(fetchMock).toHaveBeenCalledTimes(stage === 'query' ? 2 : 1);
  });

  it.each(['submit', 'query'] as const)('%s 的网络错误保持分类且不重提生成', async (stage) => {
    const fetchMock = vi.fn();
    if (stage === 'query') fetchMock.mockResolvedValueOnce(json({ data: [{ task_id: 'original-task' }] }));
    fetchMock.mockRejectedValueOnce(new TypeError(echoed()));
    vi.stubGlobal('fetch', fetchMock);
    const error = await generateOutpaintImage(remoteParams).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('[REDACTED] | [REDACTED] | [REDACTED]');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('终态失败不会重提，取消错误也保留 AbortError 身份', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ data: [{ task_id: 'original-task' }] }))
      .mockResolvedValueOnce(json({ data: { status: 'failed', error: { message: echoed() } } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateOutpaintImage(remoteParams)).rejects.toMatchObject({ name: 'PollTaskFailedError' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRejectedValueOnce(new DOMException(echoed(), 'AbortError'));
    await expect(generateOutpaintImage(remoteParams)).rejects.toMatchObject({
      name: 'AbortError', message: '[REDACTED] | [REDACTED] | [REDACTED]',
    });
  });
});
