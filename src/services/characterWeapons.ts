import { t } from '../i18n';
import type { DramaAsset } from '../types/dramaAssets';
import { MAX_CHARACTER_WEAPONS, normalizeCharacterWeaponIds } from '../types/dramaAssets';

/** 调用方只传一个作用域；依赖按卡片身份解析，不按名字或媒体猜测。 */
export function expandCharacterWeaponDependencies(selected: readonly DramaAsset[], all: readonly DramaAsset[]): DramaAsset[] {
  const result = new Map(selected.map((asset) => [`${asset.kind}:${asset.id}`, asset]));
  for (const asset of selected) {
    if (asset.kind !== 'character' || !asset.weaponIds?.length) continue;
    const weaponIds = normalizeCharacterWeaponIds(asset.weaponIds);
    if (asset.weaponIds.length > MAX_CHARACTER_WEAPONS || weaponIds.length !== asset.weaponIds.length) {
      throw new Error(t('角色武器绑定无效，请重新绑定后重试'));
    }
    for (const weaponId of weaponIds) {
      const candidates = all.filter((item) => item.kind === 'prop' && item.id === weaponId);
      if (candidates.length !== 1 || candidates[0].kind !== 'prop' || candidates[0].propType !== 'weapon') {
        throw new Error(t('角色绑定的武器不存在，请重新绑定后重试'));
      }
      result.set(`prop:${weaponId}`, candidates[0]);
    }
  }
  return [...result.values()];
}

/** rootIds 以 kind:id 为键；必须先分配整批卡片的新身份，再恢复关系。 */
export function remapCharacterWeaponIds(asset: DramaAsset, rootIds: ReadonlyMap<string, string>): DramaAsset {
  if (asset.kind !== 'character' || asset.weaponIds === undefined) return asset;
  return { ...asset, weaponIds: asset.weaponIds.map((weaponId) => {
    const mapped = rootIds.get(`prop:${weaponId}`);
    if (!mapped) throw new Error(t('角色绑定的武器不存在，请重新绑定后重试'));
    return mapped;
  }) };
}
