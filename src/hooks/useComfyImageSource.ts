import { useEffect, useMemo, useRef, useState } from 'react';
import { acquireComfyImageSource, shouldLoadNativeComfyImage } from '../services/comfyImageSource';
import type { ComfyMediaSourceLease } from '../services/comfyMediaSource';

const isBlobSource = (source: string) => source.startsWith('blob:');

/** 只转换实际显示的 ComfyUI 取件地址；blob 租约不离开组件运行期。 */
export function useComfyImageSource(source?: string, onError?: () => void): string | undefined {
  return useComfySourceLease(source, onError, acquireComfyImageSource, shouldLoadNativeComfyImage, isBlobSource);
}

/** 共用按来源锁定、异步交接与卸载释放；具体字节/分段通道仍由各自读取器决定。 */
export function useComfySourceLease(
  source: string | undefined,
  onError: (() => void) | undefined,
  acquire: (source: string, signal: AbortSignal) => Promise<ComfyMediaSourceLease>,
  matches: (source: string | undefined) => boolean,
  accepts: (source: string) => boolean,
): string | undefined {
  // 同一来源一旦需要原生读取，配置变化不能令下一次 render 回落为浏览器直连。
  const needsNative = useMemo(() => matches(source), [source, matches]);
  const [resolved, setResolved] = useState<{
    source: string;
    request: AbortController;
    src: string;
  }>();
  const errorCallback = useRef(onError);

  useEffect(() => { errorCallback.current = onError; }, [onError]);

  useEffect(() => {
    if (!source || !needsNative) return;
    const request = new AbortController();
    let lease: ComfyMediaSourceLease | undefined;
    void acquire(source, request.signal).then((result) => {
      if (request.signal.aborted) { result.release(); return; }
      // render 与 effect 之间删掉服务器时，读取器也不能把原 HTTP 来源交回 img。
      if (!accepts(result.src)) { result.release(); errorCallback.current?.(); return; }
      lease = result;
      setResolved({ source, request, src: result.src });
    }, () => {
      if (!request.signal.aborted) errorCallback.current?.();
    });
    // render 按来源隐藏旧 blob；passive cleanup 在 DOM 切换来源或卸载之后归还租约。
    return () => { request.abort(); lease?.release(); lease = undefined; };
  }, [source, needsNative, acquire, accepts]);

  if (!needsNative) return source;
  return resolved && resolved.source === source && !resolved.request.signal.aborted ? resolved.src : undefined;
}
