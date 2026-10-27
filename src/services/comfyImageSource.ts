import { useAppStore } from '../store/useAppStore';
import { corsSafeFetch } from './ai/httpTransport';
import { DEFAULT_COMFY_URL } from './comfyServers';
import { isTauriEnv } from './fs/core';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const READ_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface ComfyImageSourceLease {
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

/** 只接管默认本机或已配置服务器的取件地址，保持完整查询和原目标，不借用其他连接。 */
export function shouldLoadNativeComfyImage(source: string | undefined): boolean {
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

/** 原生流读取覆盖响应体的取消、超时和字节预算；失败不再交回 WebView 请求。 */
export async function readNativeComfyImageBlob(source: string, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  if (!shouldLoadNativeComfyImage(source)) throw new Error('ComfyUI 图片地址不属于可用的原生读取目标');
  const activeSignal = AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
  const response = await corsSafeFetch(source, { signal: activeSignal });
  const discard = () => response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    await discard();
    throw new Error(`ComfyUI 图片读取失败（HTTP ${response.status}）`);
  }
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await discard();
    throw new RangeError('ComfyUI 图片超过 32 MiB 读取限制');
  }
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (mime && !mime.startsWith('image/') && mime !== 'application/octet-stream') {
    await discard();
    throw new Error('ComfyUI 返回的内容不是图片');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    activeSignal.throwIfAborted();
    if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new RangeError('ComfyUI 图片为空或超过 32 MiB 读取限制');
    return blob;
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      activeSignal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new RangeError('ComfyUI 图片超过 32 MiB 读取限制');
      chunks.push(Uint8Array.from(value));
    }
    activeSignal.throwIfAborted();
    if (!total) throw new Error('ComfyUI 返回了空图片');
    return new Blob(chunks, { type: mime });
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

/** Blob URL 只供本窗口展示；所有权由消费者持有，不写节点、历史或项目数据。 */
export async function acquireComfyImageSource(source: string, signal: AbortSignal): Promise<ComfyImageSourceLease> {
  signal.throwIfAborted();
  if (!shouldLoadNativeComfyImage(source)) return { src: source, release: () => {} };
  const blob = await readNativeComfyImageBlob(source, signal);
  signal.throwIfAborted();
  const src = URL.createObjectURL(blob);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    URL.revokeObjectURL(src);
  };
  if (signal.aborted) { release(); signal.throwIfAborted(); }
  return { src, release };
}
