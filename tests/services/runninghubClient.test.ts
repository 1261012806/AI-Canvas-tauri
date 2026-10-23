import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadRunningHubMedia } from '../../src/services/ai/providers/runninghubClient';
import type { RunningHubMediaKind } from '../../src/types/runninghub';

const mocks = vi.hoisted(() => ({ transport: vi.fn(), localFetch: vi.fn(), sizeGuard: vi.fn() }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mocks.transport }));
vi.mock('../../src/services/fileService', () => ({ assertMediaDataUrlSize: mocks.sizeGuard }));
const connection = { baseUrl: 'https://www.runninghub.cn', apiKey: 'cn-fixture' };
const source = 'https://input.test/reference.png';
const uploadPath = '/openapi/v2/media/upload/binary';
const json = (body: unknown) => new Response(JSON.stringify(body));
const media = (mime = 'image/png') => new Response(new Blob(['reference-bytes'], { type: mime }));
const uploadedFile = () => (mocks.transport.mock.calls.find(([url]) => String(url).endsWith(uploadPath))?.[1].body as FormData).get('file') as File;

beforeEach(() => {
  mocks.transport.mockReset().mockImplementation(async (url: string) => url.endsWith(uploadPath)
    ? json({ code: 0, data: { fileName: 'openapi/reference.png', download_url: 'https://rh-upload.test/reference.png' } })
    : media());
  mocks.localFetch.mockReset().mockImplementation(async () => media());
  mocks.sizeGuard.mockReset();
  vi.stubGlobal('fetch', mocks.localFetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('RunningHub 自有素材上传', () => {
  it.each([
    { baseUrl: 'https://www.runninghub.cn', apiKey: 'cn-fixture', code: 0, field: 'fileName' },
    { baseUrl: 'https://www.runninghub.ai', apiKey: 'ai-fixture', code: 200, field: 'filename' },
  ])('使用 $baseUrl 当前站点凭据，兼容 code=$code 和 $field', async ({ baseUrl, apiKey, code, field }) => {
    mocks.transport.mockResolvedValueOnce(media()).mockResolvedValueOnce(json({ code, data: { [field]: 'openapi/reference.png', download_url: 'https://rh-upload.test/reference.png' } }));
    await expect(uploadRunningHubMedia({ baseUrl, apiKey }, source, 'image')).resolves.toEqual({ filename: 'openapi/reference.png', url: 'https://rh-upload.test/reference.png' });
    const [url, init] = mocks.transport.mock.calls[1];
    expect(url).toBe(`${baseUrl}${uploadPath}`);
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: `Bearer ${apiKey}` } });
    expect(init.headers).not.toHaveProperty('Content-Type');
    expect([...(init.body as FormData).keys()]).toEqual(['file']);
    expect(uploadedFile().name).toBe('reference.png');
    expect(await uploadedFile().text()).toBe('reference-bytes');
  });
  it('相同来源切换两站仍分别上传，不复用另一个站点的文件地址', async () => {
    for (const target of [connection, { baseUrl: 'https://www.runninghub.ai', apiKey: 'ai-fixture' }]) {
      await uploadRunningHubMedia(target, source, 'image');
    }
    const requests = mocks.transport.mock.calls.filter(([url]) => String(url).endsWith(uploadPath));
    expect(requests.map(([url, init]) => [url, init.headers.Authorization])).toEqual([
      [`${connection.baseUrl}${uploadPath}`, 'Bearer cn-fixture'],
      [`https://www.runninghub.ai${uploadPath}`, 'Bearer ai-fixture'],
    ]);
    expect(mocks.transport.mock.calls.filter(([url]) => url === source)).toHaveLength(2);
  });
  it.each([
    ['image', 'image/jpeg', 'jpg'], ['video', 'video/mp4', 'mp4'], ['audio', 'audio/mpeg', 'mp3'],
    ['video', 'video/quicktime', 'mov'], ['video', 'video/x-msvideo', 'avi'], ['video', 'video/x-matroska', 'mkv'],
    ['audio', 'audio/mp4', 'm4a'], ['audio', 'audio/x-flac', 'flac'],
  ] as const)('%s 的 %s 保留实际 MIME、字节和 .%s 后缀', async (kind, mime, extension) => {
    mocks.localFetch.mockResolvedValueOnce(media(mime));
    await uploadRunningHubMedia(connection, 'blob:reference', kind);
    expect(uploadedFile().type).toBe(mime);
    expect(uploadedFile().name).toBe(`reference.${extension}`);
    expect(await uploadedFile().text()).toBe('reference-bytes');
    expect(mocks.localFetch).toHaveBeenCalledTimes(1);
    expect(mocks.transport).toHaveBeenCalledTimes(1);
  });
  it.each(['', 'application/octet-stream'])('缺少明确 MIME（%s）时保留来源已知后缀', async (mime) => {
    mocks.transport.mockResolvedValueOnce(media(mime));
    await uploadRunningHubMedia(connection, 'https://input.test/video.mov?download=1', 'video');
    expect(uploadedFile().name).toBe('reference.mov');
    expect(uploadedFile().type).toBe(mime);
  });
  it('未知二进制不冒充 PNG 文件，跨媒体类型在上传前拒绝', async () => {
    mocks.localFetch.mockResolvedValueOnce(media('application/octet-stream'));
    await uploadRunningHubMedia(connection, 'blob:unknown', 'image');
    expect(uploadedFile().name).toBe('reference.bin');
    mocks.transport.mockClear();
    mocks.localFetch.mockResolvedValueOnce(media('video/mp4'));
    await expect(uploadRunningHubMedia(connection, 'blob:wrong-kind', 'image')).rejects.toThrow('类型');
    expect(mocks.transport).not.toHaveBeenCalled();
  });
  it.each(['image', 'video', 'audio'] as RunningHubMediaKind[])('%s 保留应用 100 MiB 上限，超限不上传', async (kind) => {
    mocks.localFetch.mockResolvedValueOnce(new Response('small-body', { headers: { 'content-length': String(100 * 1024 * 1024 + 1) } }));
    await expect(uploadRunningHubMedia(connection, 'blob:too-large', kind)).rejects.toThrow('100 MB');
    expect(mocks.transport).not.toHaveBeenCalled();
  });
  it('当前站点上传失败不跨站重试，也不返回原始外链', async () => {
    mocks.transport.mockResolvedValueOnce(media()).mockResolvedValueOnce(json({ code: 901 }));
    await expect(uploadRunningHubMedia(connection, source, 'image')).rejects.toThrow('业务码 901');
    const requests = mocks.transport.mock.calls.filter(([url]) => String(url).endsWith(uploadPath));
    expect(requests).toHaveLength(1);
    expect(requests[0][0]).toBe(`${connection.baseUrl}${uploadPath}`);
  });
});
