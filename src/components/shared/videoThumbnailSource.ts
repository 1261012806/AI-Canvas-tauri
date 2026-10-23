import { localMediaUrlToPath } from '../../utils/mediaUrl';

const IMAGE_SUFFIX = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;
const VIDEO_SUFFIX = /\.(?:3g[2p]|avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|ogv|ts|webm|m3u8)$/i;

function mediaPath(value: string): string {
  const path = value.split(/[?#]/, 1)[0];
  try { return decodeURIComponent(path); } catch { return path; }
}

function localPathKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

/** 只认可图片封面；兼容旧画面快照，拒绝误存的视频地址和同一本地视频的 URL 别名。 */
export function resolveVideoThumbnailPoster(poster?: string, src?: string, filePath?: string): string | undefined {
  const candidate = poster?.trim();
  if (!candidate || /^data:(?:video|audio)\//i.test(candidate) || VIDEO_SUFFIX.test(mediaPath(candidate))) return undefined;
  const knownImage = /^data:image\//i.test(candidate) || IMAGE_SUFFIX.test(mediaPath(candidate));
  if (knownImage) return candidate;
  if (candidate === src?.trim() || candidate === filePath?.trim()) return undefined;
  const posterPath = localPathKey(localMediaUrlToPath(candidate));
  if (posterPath && (posterPath === localPathKey(localMediaUrlToPath(src)) || posterPath === localPathKey(filePath))) return undefined;
  return candidate;
}
