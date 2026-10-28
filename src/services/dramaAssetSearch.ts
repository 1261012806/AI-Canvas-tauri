import type { DramaAsset, DramaAssetCategory } from '../types/dramaAssets';

/** 武器保留 prop 领域身份，展示分类使用固定子类型。 */
export function getDramaAssetCategory(asset: DramaAsset): DramaAssetCategory {
  return asset.kind === 'prop' && asset.propType === 'weapon' ? 'weapon' : asset.kind;
}

/** 普通道具分类不包含武器；全部视图由调用方直接使用完整列表。 */
export function matchesDramaAssetCategory(asset: DramaAsset, category: DramaAssetCategory): boolean {
  return getDramaAssetCategory(asset) === category;
}

/** 素材库与 @ 共用领域字段；不把路径或远端绑定加入可检索文本。 */
export function matchesDramaAssetQuery(asset: DramaAsset, query: string): boolean {
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const details = asset.kind === 'character'
    ? [...(asset.aliases ?? []), asset.identity, asset.ageBand, asset.gender, asset.personality,
      asset.wardrobeDefault, asset.voiceNotes,
      ...(asset.voiceClips ?? []).flatMap((clip) => [clip.label, clip.transcript]),
      ...(asset.actions ?? []).flatMap((action) => [action.name, action.prompt])]
    : asset.kind === 'scene'
      ? [asset.placeType, asset.timeOfDay, asset.atmosphere, asset.spatialNotes]
      : [asset.ownerName, asset.category, asset.significance, asset.propType === 'weapon' ? '武器 weapon' : undefined];
  const values = [asset.name, asset.id, asset.key, asset.summary, asset.visualNotes, asset.storyRole, ...details,
    ...(asset.referenceImages ?? []).flatMap((reference) => ['label' in reference ? reference.label : '', reference.prompt])]
    .filter((value): value is string => typeof value === 'string').map(normalize);
  return terms.every((term) => values.some((value) => value.includes(term)));
}

export type DramaAssetSortBy = 'name' | 'createdAt' | 'updatedAt';
export function sortDramaAssets(assets: readonly DramaAsset[], by: DramaAssetSortBy, order: 'asc' | 'desc'): DramaAsset[] {
  const direction = order === 'asc' ? 1 : -1;
  return [...assets].sort((a, b) => direction * (by === 'name'
    ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    : a[by] - b[by]) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

export const dramaAssetIdentityKey = (asset: Pick<DramaAsset, 'kind' | 'id'>): string => `${asset.kind}:${asset.id}`;
