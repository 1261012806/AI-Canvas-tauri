/** 全局创作资产元数据；人物沿用原表，场景与道具不依赖项目节点。 */
import type { DramaAsset, DramaAssetWriteOptions, DramaProp, DramaScene } from '../types/dramaAssets';
import { assertDramaAssetWriteCurrent, normalizeDramaVisualAsset, syncDramaVisualAssetPrimary } from '../types/dramaAssets';
import {
  deleteGlobalDramaAsset,
  getAllGlobalDramaAssets,
  getAssetIndexById,
  putGlobalDramaAsset,
} from './indexedDbService';
import {
  deleteGlobalCharacterCard,
  loadGlobalCharacterCards,
  persistGlobalMedia,
  saveGlobalCharacterCard,
} from './characterLibraryService';
import { getAssetUrlFromPath, isTauriEnv } from './fileService';

export { addImportedGlobalDramaAssets } from './indexedDbService';

export interface GlobalDramaAssetSaveOptions extends DramaAssetWriteOptions {
  /** 仅本次复制的来源路径，绝不写入资产元数据。 */
  imageFilePath?: string;
}

function prepareGlobalAsset(asset: DramaScene | DramaProp): DramaScene | DramaProp {
  const normalized = normalizeDramaVisualAsset(asset);
  const detached = { ...normalized, referenceImages: normalized.referenceImages?.map((reference) => ({
    ...reference, filePath: undefined, sourceNodeId: undefined,
  })) } as (DramaScene | DramaProp) & {
    filePath?: string; path?: string; sourceNodeId?: string;
  };
  delete detached.imageNodeId;
  delete detached.assetId;
  delete detached.relativePath;
  delete detached.filePath;
  delete detached.path;
  delete detached.sourceNodeId;
  return detached;
}

export async function loadGlobalDramaAssetCards(): Promise<DramaAsset[]> {
  const [characters, storedAssets] = await Promise.all([loadGlobalCharacterCards(), getAllGlobalDramaAssets()]);
  const assets = await Promise.all(storedAssets.map(async (asset) => {
    if (asset.kind !== 'scene' && asset.kind !== 'prop') throw new Error('全局创作资产记录无效');
    const detached = prepareGlobalAsset(asset);
    const referenceImages = await Promise.all((detached.referenceImages ?? []).map(async (reference) => {
      if (!reference.assetId) return reference;
      const indexed = await getAssetIndexById(reference.assetId);
      return !indexed || indexed.status !== 'online' || indexed.source !== 'global'
        ? { ...reference, imageUrl: undefined }
        : { ...reference, relativePath: indexed.relativePath, imageUrl: await getAssetUrlFromPath(indexed.path) };
    }));
    return syncDramaVisualAssetPrimary({ ...detached, referenceImages }, true);
  }));
  return [...characters, ...assets.sort((a, b) => b.updatedAt - a.updatedAt)];
}

export async function saveGlobalDramaAssetCard(
  asset: DramaAsset,
  options: GlobalDramaAssetSaveOptions = {},
): Promise<DramaAsset> {
  assertDramaAssetWriteCurrent(options);
  if (asset.kind === 'character') return saveGlobalCharacterCard(asset, options);
  if ((asset.kind !== 'scene' && asset.kind !== 'prop') || !asset.id.trim() || !asset.name.trim()) {
    throw new Error('全局创作资产记录无效');
  }
  const normalized = normalizeDramaVisualAsset(asset);
  const referenceImages = [];
  for (const reference of normalized.referenceImages ?? []) {
    assertDramaAssetWriteCurrent(options);
    if (!isTauriEnv()) {
      referenceImages.push({ ...reference, filePath: undefined, sourceNodeId: undefined });
      continue;
    }
    const filePath = reference.filePath || (reference.id === normalized.primaryReferenceImageId ? options.imageFilePath : undefined);
    const subtype = reference.imageUrl?.match(/^data:image\/([a-zA-Z0-9.+-]+);/i)?.[1];
    const extension = subtype === 'jpeg' ? 'jpg' : subtype
      ?? filePath?.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]
      ?? 'png';
    const image = await persistGlobalMedia(asset.name, {
      id: reference.id, kind: asset.kind, assetId: reference.assetId,
      filePath, url: reference.imageUrl, extension, category: 'image',
    }, options);
    assertDramaAssetWriteCurrent(options);
    if (!image?.assetId) throw new Error('创作资产参考图保存失败');
    referenceImages.push({ ...reference, filePath: undefined, sourceNodeId: undefined,
      assetId: image.assetId, relativePath: image.relativePath, imageUrl: image.url });
  }
  const persisted = syncDramaVisualAssetPrimary(prepareGlobalAsset({ ...normalized, referenceImages }), true);
  assertDramaAssetWriteCurrent(options);
  await putGlobalDramaAsset(persisted, options);
  assertDramaAssetWriteCurrent(options);
  return persisted;
}

/** 删除卡片只移除元数据，共用媒体仍由资源库文件菜单管理。 */
export async function deleteGlobalDramaAssetCard(kind: DramaAsset['kind'], id: string, options?: DramaAssetWriteOptions): Promise<void> {
  assertDramaAssetWriteCurrent(options);
  if (kind === 'character') return deleteGlobalCharacterCard(id, options);
  await deleteGlobalDramaAsset(id, options);
}
