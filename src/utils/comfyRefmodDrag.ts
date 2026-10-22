import type { ComfyRefmodSelection } from '../types/comfyRefmod';
import { normalizeCharacterRefmods, normalizeComfyRefmodSelections } from './comfyRefmod';

/** DOM 拖放只接收有界引用，不接收路径、槽位覆盖授权或文件正文。 */
export function readComfyRefmodDragPayload(payload: string): ComfyRefmodSelection[] {
  if (!payload || payload.length > 64 * 1024) throw new Error('参考包拖放内容无效，请从资源库重新拖入');
  let value: unknown;
  try { value = JSON.parse(payload) as unknown; }
  catch { throw new Error('参考包拖放内容无效，请从资源库重新拖入'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参考包拖放内容无效');
  const { version, items } = value as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(items) || items.length === 0 || items.length > 8) throw new Error('每次最多拖入 8 个有效参考包');
  const normalized = normalizeComfyRefmodSelections(items);
  if (normalized.length !== items.length) throw new Error('参考包引用无效，请从资源库重新拖入');
  return normalizeCharacterRefmods(normalized);
}
