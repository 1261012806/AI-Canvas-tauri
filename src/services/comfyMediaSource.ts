import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/useAppStore';
import { DEFAULT_COMFY_URL } from './comfyServers';
import { isTauriEnv } from './fs/core';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface ComfyMediaSourceLease {
  src: string;
  release: () => void;
}

function parseEndpoint(value: string | undefined): URL | undefined {
  try {
    const url = new URL(value ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return undefined;
    return url;
  } catch { return undefined; }
}

/** 仅接管默认本机或已配置服务的取件端点，不根据扩展名猜测或改投其他连接。 */
export function shouldLoadNativeComfyMedia(source: string | undefined): boolean {
  if (!isTauriEnv()) return false;
  const url = parseEndpoint(source);
  if (!url?.searchParams.get('filename')?.trim() || !url.pathname.endsWith('/view')) return false;
  const { config } = useAppStore.getState();
  return [DEFAULT_COMFY_URL, config.comfyUIUrl, ...(config.comfyServers ?? []).map((server) => server.url)].some((value) => {
    const base = parseEndpoint(value);
    if (!base || base.search || base.protocol !== url.protocol || base.port !== url.port) return false;
    const sameHost = base.hostname === url.hostname
      || (LOOPBACK_HOSTS.has(base.hostname) && LOOPBACK_HOSTS.has(url.hostname));
    return sameHost && url.pathname === `${base.pathname.replace(/\/+$/, '')}/view`;
  });
}

/** 仅接受宿主生成的不透明媒体地址；它不能包含原始服务 URL 或请求凭据。 */
export function isNativeComfyMediaSource(source: string): boolean {
  try {
    const url = new URL(source);
    return ((url.protocol === 'comfy-media:' && url.hostname === 'localhost')
      || (['http:', 'https:'].includes(url.protocol) && url.hostname === 'comfy-media.localhost'))
      && /^\/[a-f\d]{64}$/.test(url.pathname) && !url.search && !url.hash && !url.username && !url.password && !url.port;
  } catch { return false; }
}

/** 视频/音频按 Range 原生读取，不将完整媒体放入 JS Blob，也不持久化临时地址。 */
export async function acquireComfyMediaSource(source: string, signal: AbortSignal): Promise<ComfyMediaSourceLease> {
  signal.throwIfAborted();
  if (!shouldLoadNativeComfyMedia(source)) return { src: source, release: () => {} };
  const { id } = await invoke<{ id: string }>('open_comfy_media_source', { url: source });
  if (!/^[a-f\d]{64}$/.test(id)) throw new Error('ComfyUI 原生媒体通道返回了无效标识');
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', release);
    void invoke('close_comfy_media_source', { id }).catch(() => undefined);
  };
  signal.addEventListener('abort', release, { once: true });
  try {
    signal.throwIfAborted();
    const src = convertFileSrc(id, 'comfy-media');
    if (!isNativeComfyMediaSource(src)) throw new Error('ComfyUI 原生媒体展示地址无效');
    return { src, release };
  } catch (error) { release(); throw error; }
}
