/** 纯 URL 判定供 DOM 构造器使用；实际原生请求仍须校验当前已配置服务。 */
export function isComfyViewUrl(source: string): boolean {
  try {
    const url = new URL(source);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
      && url.pathname.endsWith('/view') && !!url.searchParams.get('filename')?.trim();
  } catch { return false; }
}

export const COMFY_IMAGE_SOURCE_ATTRIBUTE = 'data-comfy-image-source';

/** 取件缩略图先记原始引用，等所属编辑器接管；构造时不会触发网络请求。 */
export function setReferenceThumbnailSource(image: HTMLImageElement, source: string): void {
  if (isComfyViewUrl(source)) image.setAttribute(COMFY_IMAGE_SOURCE_ATTRIBUTE, source);
  else image.src = source;
}

export function referenceThumbnailSource(image: Element | null): string | null {
  return image?.getAttribute(COMFY_IMAGE_SOURCE_ATTRIBUTE) ?? image?.getAttribute('src') ?? null;
}
