import { acquireComfyImageSource, shouldLoadNativeComfyImage, type ComfyImageSourceLease } from './comfyImageSource';
import { COMFY_IMAGE_SOURCE_ATTRIBUTE } from '../utils/comfyMediaUrl';

/** 一个编辑器一个观察器；仅管理显式标记的引用缩略图，不拦截其他 DOM 图片。 */
export function bindComfyDomImageSources(root: HTMLElement): () => void {
  const active = new Map<HTMLImageElement, {
    source: string; request: AbortController; lease?: ComfyImageSourceLease;
  }>();
  let disposed = false;
  const sync = () => {
    if (disposed) return;
    const images = new Set(root.querySelectorAll<HTMLImageElement>(`img[${COMFY_IMAGE_SOURCE_ATTRIBUTE}]`));
    for (const [image, entry] of active) {
      if (!images.has(image) || image.getAttribute(COMFY_IMAGE_SOURCE_ATTRIBUTE) !== entry.source) {
        entry.request.abort(); entry.lease?.release(); active.delete(image);
      }
    }
    for (const image of images) {
      if (active.has(image)) continue;
      const source = image.getAttribute(COMFY_IMAGE_SOURCE_ATTRIBUTE);
      if (!source) continue;
      const entry: { source: string; request: AbortController; lease?: ComfyImageSourceLease }
        = { source, request: new AbortController() };
      active.set(image, entry);
      const needsNative = shouldLoadNativeComfyImage(source);
      if (!needsNative) { image.src = source; continue; }
      image.removeAttribute('src');
      void acquireComfyImageSource(source, entry.request.signal).then((lease) => {
        if (disposed || entry.request.signal.aborted || active.get(image) !== entry
          || !root.contains(image) || image.getAttribute(COMFY_IMAGE_SOURCE_ATTRIBUTE) !== source) {
          lease.release(); return;
        }
        if (!lease.src.startsWith('blob:')) { lease.release(); return; }
        entry.lease = lease;
        image.src = lease.src;
      }, () => { /* 失败保留胶囊占位，绝不把原取件 URL 写回 src。 */ });
    }
  };
  const observer = new MutationObserver(sync);
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: [COMFY_IMAGE_SOURCE_ATTRIBUTE] });
  sync();
  return () => {
    disposed = true; observer.disconnect();
    for (const entry of active.values()) { entry.request.abort(); entry.lease?.release(); }
    active.clear();
  };
}
