import { useEffect, useMemo, useRef, useState } from 'react';
import { acquireComfyImageSource, shouldLoadNativeComfyImage } from '../services/comfyImageSource';

/** 只转换实际显示的 ComfyUI 取件地址；blob 租约不离开组件运行期。 */
export function useComfyImageSource(source?: string, onError?: () => void): string | undefined {
  // 同一来源一旦需要原生读取，配置变化不能令下一次 render 回落为浏览器直连。
  const needsNative = useMemo(() => shouldLoadNativeComfyImage(source), [source]);
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
    let lease: Awaited<ReturnType<typeof acquireComfyImageSource>> | undefined;
    void acquireComfyImageSource(source, request.signal).then((result) => {
      if (request.signal.aborted) { result.release(); return; }
      // render 与 effect 之间删掉服务器时，读取器也不能把原 HTTP 来源交回 img。
      if (!result.src.startsWith('blob:')) { result.release(); errorCallback.current?.(); return; }
      lease = result;
      setResolved({ source, request, src: result.src });
    }, () => {
      if (!request.signal.aborted) errorCallback.current?.();
    });
    // render 按来源隐藏旧 blob；passive cleanup 在 DOM 切换来源或卸载之后归还租约。
    return () => { request.abort(); lease?.release(); lease = undefined; };
  }, [source, needsNative]);

  if (!needsNative) return source;
  return resolved && resolved.source === source && !resolved.request.signal.aborted ? resolved.src : undefined;
}
