/**
 * 角色声音片段的浏览器侧读取工具：本地音频转 data URL、读取时长。
 * 落盘与全局资产归档在 services/characterLibraryService.ts。
 */
import { acquireComfyMediaSource } from '../../services/comfyMediaSource';

export function readAudioFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('音频读取失败'));
    reader.onerror = () => reject(reader.error ?? new Error('音频读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 读取音频时长；解码失败时返回 undefined，不阻断绑定流程。 */
export async function readAudioDuration(url: string): Promise<number | undefined> {
  const controller = new AbortController();
  let lease: Awaited<ReturnType<typeof acquireComfyMediaSource>> | undefined;
  try {
    lease = await acquireComfyMediaSource(url, controller.signal);
    return await new Promise<number | undefined>((resolve) => {
      const audio = new Audio();
      let settled = false;
      const timeout = setTimeout(() => finish(), 15_000);
      const finish = (duration?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        audio.onloadedmetadata = null;
        audio.onerror = null;
        audio.pause(); audio.removeAttribute('src'); audio.load();
        resolve(duration);
      };
      audio.onloadedmetadata = () => finish(
        Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined,
      );
      audio.onerror = () => finish(undefined);
      audio.preload = 'metadata';
      audio.src = lease!.src;
    });
  } catch { return undefined; }
  finally { controller.abort(); lease?.release(); }
}
