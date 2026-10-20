import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { corsSafeFetch } from '../../src/services/ai/httpTransport';
import { comfyFetch, normalizeComfyUrl } from '../../src/services/comfyPolling';

vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: vi.fn() }));

beforeEach(() => {
  vi.stubEnv('DEV', true);
  vi.stubGlobal('window', { location: new URL('http://localhost:1420') });
  vi.mocked(corsSafeFetch).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('ComfyUI HTTP 连接选路', () => {
  it.each(['127.0.0.1', 'localhost'])('Web 开发代理覆盖 %s 并保留完整端点与查询', (host) => {
    expect(normalizeComfyUrl(`http://${host}:8188/history/prompt-1?max_items=3`))
      .toBe('/api/comfyui/history/prompt-1?max_items=3');
    expect(normalizeComfyUrl(`http://${host}:8188/view?filename=model%20preview.png&type=output`))
      .toBe('/api/comfyui/view?filename=model%20preview.png&type=output');
    expect(normalizeComfyUrl(`http://${host}:8188/prefix/queue?source=progress`))
      .toBe('/api/comfyui/prefix/queue?source=progress');
  });

  it.each([
    'http://127.0.0.1:8288/history/prompt-1',
    'http://localhost:8288/queue',
    'https://127.0.0.1:8188/history/prompt-1',
    'https://localhost:8188/queue',
    'http://192.168.1.2:8188/queue',
    'https://comfy.example.test/prefix/history/prompt-1',
    'http://localhost.evil.test:8188/queue',
    'http://127.0.0.1:8188@other.example.test/queue',
    'http://user:password@localhost:8188/queue',
    '/api/comfyui/queue',
    'invalid url',
  ])('不将其他目标或带凭据地址 %s 转发到固定本机服务', (url) => {
    expect(normalizeComfyUrl(url)).toBe(url);
  });

  it.each(['__TAURI_INTERNALS__', '__TAURI__'])('Tauri 的 %s 标记保留原地址并交给已有传输层', async (marker) => {
    vi.stubGlobal('window', { location: new URL('http://localhost:1420'), [marker]: {} });
    const url = 'http://localhost:8188/history/prompt-1?max_items=1';
    const options = { signal: new AbortController().signal };
    const response = new Response('{}');
    vi.mocked(corsSafeFetch).mockResolvedValue(response);

    expect(normalizeComfyUrl(url)).toBe(url);
    await expect(comfyFetch(url, options)).resolves.toBe(response);
    expect(corsSafeFetch).toHaveBeenCalledWith(url, options);
  });

  it('生产 Web 不依赖只存在于 Vite 开发服务器的代理', () => {
    vi.stubEnv('DEV', false);
    const url = 'http://127.0.0.1:8188/history/prompt-1';
    expect(normalizeComfyUrl(url)).toBe(url);
  });

  it('没有浏览器窗口时保留原始请求目标', () => {
    vi.stubGlobal('window', undefined);
    const url = 'http://127.0.0.1:8188/queue';
    expect(normalizeComfyUrl(url)).toBe(url);
  });

  it('运行时识别原生环境，不依赖模块导入前注入标记', () => {
    const url = 'http://127.0.0.1:8188/queue';
    expect(normalizeComfyUrl(url)).toBe('/api/comfyui/queue');
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    expect(normalizeComfyUrl(url)).toBe(url);
  });

  it('Web 开发请求使用同源代理并保留取消信号', async () => {
    const options = { signal: new AbortController().signal };
    const response = new Response('{}');
    vi.mocked(corsSafeFetch).mockResolvedValue(response);

    await expect(comfyFetch('http://localhost:8188/queue', options)).resolves.toBe(response);
    expect(corsSafeFetch).toHaveBeenCalledWith('/api/comfyui/queue', options);
  });
});
