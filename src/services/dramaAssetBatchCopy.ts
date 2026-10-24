import { t } from '../i18n';
import { useAppStore } from '../store/useAppStore';
import { seriesOwnerId } from '../store/store.utils';
import type { DramaAsset, DramaAssetWriteOptions } from '../types/dramaAssets';
import { assertDramaAssetWriteCurrent, normalizeDramaCharacter, normalizeDramaVisualAsset } from '../types/dramaAssets';
import { dramaAssetIdentityKey } from './dramaAssetSearch';
import { copyGlobalDramaAssetsToProject, copyProjectDramaAssetsToGlobal } from './dramaAssetTransferService';
import { isTauriEnv } from './fileService';

function materializeSourceNodes(source: DramaAsset): DramaAsset {
  const nodes = useAppStore.getState().nodes;
  const image = (nodeId?: string) => {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node || !['ai-image', 'source-image', 'ai-panorama', 'ai-storyboard', 'ai-animation'].includes(node.type ?? '')) return {};
    return { imageUrl: node.data.imageUrl || node.data.thumbnailUrl, filePath: node.data.filePath,
      assetId: node.data.assetId, relativePath: node.data.relativePath };
  };
  const asset = source.kind === 'character' ? normalizeDramaCharacter(source) : normalizeDramaVisualAsset(source);
  const referenceImages = asset.referenceImages?.map((reference) => reference.sourceNodeId
    ? { ...reference, ...image(reference.sourceNodeId) } : reference);
  if (asset.kind !== 'character') return { ...asset, referenceImages } as DramaAsset;
  return { ...asset, referenceImages, voiceClips: asset.voiceClips?.map((clip) => {
    const node = clip.sourceNodeId ? nodes.find((item) => item.id === clip.sourceNodeId
      && ['ai-audio', 'source-audio'].includes(item.type ?? '')) : undefined;
    return node?.data.audioUrl ? { ...clip, audioUrl: node.data.audioUrl, assetId: node.data.assetId,
      relativePath: node.data.relativePath, filePath: node.data.filePath } : clip;
  }) } as DramaAsset;
}

/** 新卡片及嵌套条目使用新身份，媒体文件仍由既有目标作用域保存入口处理。 */
function copyAsset(source: DramaAsset): DramaAsset {
  const asset = source.kind === 'character' ? normalizeDramaCharacter(source) : normalizeDramaVisualAsset(source);
  const now = Date.now();
  const referenceIds = new Map((asset.referenceImages ?? []).map((reference) => [reference.id, crypto.randomUUID()]));
  const base = { ...asset, id: `${asset.kind}-${crypto.randomUUID()}`, imageNodeId: undefined,
    createdAt: now, updatedAt: now, source: 'manual' as const,
    referenceImages: asset.referenceImages?.map((reference) => ({ ...reference,
      id: referenceIds.get(reference.id)!, sourceNodeId: undefined, createdAt: now, updatedAt: now })),
    primaryReferenceImageId: referenceIds.get(asset.primaryReferenceImageId ?? ''),
  };
  if (asset.kind !== 'character') return { ...base, kind: asset.kind } as DramaAsset;
  const voiceIds = new Map((asset.voiceClips ?? []).map((clip) => [clip.id, crypto.randomUUID()]));
  return { ...base, kind: 'character', identity: asset.identity, libraryOrder: undefined,
    avatarReferenceImageId: referenceIds.get(asset.avatarReferenceImageId ?? ''),
    voiceClips: asset.voiceClips?.map((clip) => ({ ...clip, id: voiceIds.get(clip.id)!, sourceNodeId: undefined, createdAt: now, updatedAt: now })),
    primaryVoiceClipId: voiceIds.get(asset.primaryVoiceClipId ?? ''),
    actions: asset.actions?.map((action) => ({ ...action, id: crypto.randomUUID(), createdAt: now, updatedAt: now,
      media: action.media?.map((media) => ({ ...media, id: crypto.randomUUID(), createdAt: now, updatedAt: now })) })),
  } as DramaAsset;
}

export async function copyDramaAssetSelection(from: 'project' | 'global', selected: readonly Pick<DramaAsset, 'id' | 'kind'>[],
  options: DramaAssetWriteOptions & { onProgress?: (text: string) => void } = {}): Promise<number> {
  const initial = useAppStore.getState();
  const projectId = initial.currentProjectId;
  if (!projectId || projectId === 'default') throw new Error(t('请先保存项目，再管理创作资产'));
  const ownerId = seriesOwnerId(initial.projects, projectId);
  const assertCurrent = () => {
    assertDramaAssetWriteCurrent(options);
    const state = useAppStore.getState();
    if (state.currentProjectId !== projectId || seriesOwnerId(state.projects, projectId) !== ownerId) throw new Error(t('项目已切换'));
  };
  assertCurrent();
  const source = from === 'project' ? [...initial.dramaAssets.characters, ...initial.dramaAssets.scenes, ...initial.dramaAssets.props]
    : [...initial.globalCharacters, ...initial.globalScenes, ...initial.globalProps];
  const keys = new Set(selected.map(dramaAssetIdentityKey));
  const assets = source.filter((asset) => keys.has(dramaAssetIdentityKey(asset)));
  if (assets.length !== keys.size || !assets.length) throw new Error(t('资产已删除，请重新选择'));
  const copies = assets.map((asset) => copyAsset(from === 'project' ? materializeSourceNodes(asset) : asset));
  if (from === 'global') {
    if (isTauriEnv()) {
      const result = await copyGlobalDramaAssetsToProject({ ownerId, assets: copies,
        commit: async (assets) => { await initial.importDramaAssets(assets, { ...options, assertCurrent }); },
      }, { ...options, assertCurrent });
      return result.assetCount;
    }
    await initial.importDramaAssets(copies, { ...options, assertCurrent });
    return copies.length;
  }
  if (isTauriEnv()) {
    const result = await copyProjectDramaAssetsToGlobal({ ownerId, assets: copies, nodes: initial.nodes,
      commit: async (assets) => { await useAppStore.getState().importGlobalDramaAssets(assets, { ...options, assertCurrent }); },
    }, { ...options, assertCurrent });
    return result.assetCount;
  }
  let copied = 0;
  try {
    for (const asset of copies) {
      assertCurrent();
      const latest = useAppStore.getState().dramaAssets;
      const current = [...latest.characters, ...latest.scenes, ...latest.props].find((item) => dramaAssetIdentityKey(item) === dramaAssetIdentityKey(assets[copied]));
      if (current !== assets[copied]) throw new Error(t('资产已变化，请重新选择'));
      const saved = await useAppStore.getState().saveGlobalDramaAsset(asset, { ...options, assertCurrent });
      if (!saved) throw new Error(t('复制失败，请重试'));
      copied += 1;
      options.onProgress?.(t('正在复制资产 {current}/{total}', { current: copied, total: copies.length }));
    }
    return copied;
  } catch (error) {
    // 单项保存已被接受的结果保留，取消或失败不能将其描述为整批回滚。
    if (copied) useAppStore.getState().showToast(t('已保留成功复制的 {count} 项资产', { count: copied }), 'info');
    throw error;
  }
}
