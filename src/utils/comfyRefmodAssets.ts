import type { ComfyRefmodAsset } from '../types/comfyRefmod';
import { comfyRefmodKey } from './comfyRefmod';

/** 目录只确认文件存在；用户编辑的名称和标签始终以保存的元数据为准。 */
export function mergeRefmodCatalogEntries(
  saved: ComfyRefmodAsset[],
  found: ComfyRefmodAsset[],
): ComfyRefmodAsset[] {
  const byKey = new Map(saved.map((entry) => [comfyRefmodKey(entry), entry]));
  found.forEach((entry) => {
    const previous = byKey.get(comfyRefmodKey(entry));
    byKey.set(comfyRefmodKey(entry), previous ? {
      ...entry,
      ...previous,
      kind: entry.kind ?? previous.kind,
      tokens: entry.tokens ?? previous.tokens,
    } : entry);
  });
  return [...byKey.values()];
}

export function refmodMatchesQuery(entry: ComfyRefmodAsset, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return !normalized || [entry.name, entry.fileName, ...entry.tags].some((value) => value.toLocaleLowerCase().includes(normalized));
}
