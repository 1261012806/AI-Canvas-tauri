/**
 * 把角色的多张参考图拼成一张，作为单张参考图喂给模型。
 * 排版复用角色库画廊那套 justified rows：格子宽高比等于图片宽高比，不裁切不变形。
 */
import { justifiedRows } from '../components/character/justifiedRows';
import { loadImage as loadReferenceImage } from './ai/imageUtils';

const TARGET_WIDTH = 1536;
const GAP = 12;
const BACKGROUND = '#ffffff';

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  try { return await loadReferenceImage(url); }
  catch { return null; }
}

/**
 * @param urls 已经可直接加载的图片地址（data URL / blob / asset URL）
 * @returns 拼好的 PNG data URL；不足两张或全部加载失败时返回 null
 */
export async function mergeReferenceImages(urls: string[]): Promise<string | null> {
  if (urls.length < 2) return null;
  const images = (await Promise.all(urls.map(loadImage))).filter(
    (image): image is HTMLImageElement => !!image && image.naturalWidth > 0 && image.naturalHeight > 0,
  );
  if (images.length < 2) return null;

  const ratios = images.map((image) => image.naturalWidth / image.naturalHeight);
  // 目标高度也传 TARGET_WIDTH，排版会挑出最接近正方形的分行方案
  const layout = justifiedRows(ratios, TARGET_WIDTH, TARGET_WIDTH, GAP);
  if (!layout) return null;

  const height = layout.rows.reduce((sum, row) => sum + row.height, 0)
    + GAP * (layout.rows.length - 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(layout.width);
  canvas.height = Math.round(height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let y = 0;
  for (const row of layout.rows) {
    const inner = layout.width - GAP * (row.items.length - 1);
    const sum = row.items.reduce((total, index) => total + ratios[index], 0);
    let x = 0;
    for (const index of row.items) {
      const width = (inner * ratios[index]) / sum;
      ctx.drawImage(images[index], x, y, width, row.height);
      x += width + GAP;
    }
    y += row.height + GAP;
  }
  return canvas.toDataURL('image/png');
}
