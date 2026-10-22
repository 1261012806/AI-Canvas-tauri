import type { ComfyRefmodAsset, ComfyRefmodCatalog, ComfyRefmodLoaderSchema } from '../types/comfyRefmod';
import type { DramaCharacter } from '../types/dramaAssets';
import { comfyRefmodKey } from './comfyRefmod';
import { mergeRefmodCatalogEntries } from './comfyRefmodAssets';

/** @ 候选只使用当前服务已验证的目录，保存的名称、标签与角色图片作为展示信息。 */
export function buildComfyRefmodMentionEntries({
  catalog,
  loaders,
  savedAssets = [],
  projectCharacters = [],
  globalCharacters = [],
}: {
  catalog: ComfyRefmodCatalog;
  loaders: Array<Pick<ComfyRefmodLoaderSchema, 'loaderType' | 'slots'>>;
  savedAssets?: ComfyRefmodAsset[];
  projectCharacters?: DramaCharacter[];
  globalCharacters?: DramaCharacter[];
}): Array<{ asset: ComfyRefmodAsset; thumbnailUrl?: string; characterName?: string }> {
  const allowed = new Map<string, Set<string>>();
  for (const loader of loaders) {
    const names = allowed.get(loader.loaderType) ?? new Set<string>();
    for (const slot of loader.slots) for (const name of slot.allowedNames) names.add(name);
    allowed.set(loader.loaderType, names);
  }
  const verifiedKeys = new Set(catalog.entries.map(comfyRefmodKey));
  const assets = mergeRefmodCatalogEntries(savedAssets, catalog.entries).filter((asset) => (
    verifiedKeys.has(comfyRefmodKey(asset))
    && asset.serverId === catalog.serverId
    && asset.endpointFingerprint === catalog.endpointFingerprint
    && allowed.get(asset.loaderType)?.has(asset.fileName)
  ));
  const characters = new Map<string, { thumbnailUrl?: string; characterName: string }>();
  for (const character of [...projectCharacters, ...globalCharacters]) {
    const primary = character.referenceImages?.find((image) => image.id === character.primaryReferenceImageId)
      ?? character.referenceImages?.[0];
    for (const reference of character.refmods ?? []) {
      const key = comfyRefmodKey(reference);
      if (!characters.has(key)) characters.set(key, {
        thumbnailUrl: primary?.imageUrl ?? character.imageUrl,
        characterName: character.name,
      });
    }
  }
  return assets.map((asset) => ({ asset, ...characters.get(comfyRefmodKey(asset)) }));
}
