import { t } from '../../../i18n';
import type { DramaAsset, DramaAssetLibrary } from '../../../types/dramaAssets';
import { DRAMA_ASSET_KIND_LABEL, parseDramaMentionId } from '../../../types/dramaAssets';
import {
  collectCharacterReferenceUrls,
  findDramaAsset,
  formatDramaAssetTextBrief,
  resolveDramaActionMediaRef,
  resolveDramaAssetImageRef,
  resolveDramaVoiceRef,
} from '../../../services/dramaAssetPrompt';
import type { MentionChipPreview } from '../../../types/referencePreview';

export type { MentionChipPreview } from '../../../types/referencePreview';

export interface MentionPreviewSource {
  kind: 'node' | 'drama' | 'asset' | 'refmod';
  id: string;
  label: string;
}

/** 读取胶囊自己的引用身份，库资产不冒充画布节点。 */
export function readMentionPreviewSource(element: Pick<HTMLElement, 'getAttribute'>): MentionPreviewSource | null {
  const refmod = element.getAttribute('data-refmod-raw');
  if (refmod) return { kind: 'refmod', id: refmod, label: element.getAttribute('data-refmod-label') || 'ComfyUI 角色' };
  const nodeId = element.getAttribute('data-ref-id');
  if (nodeId) return { kind: 'node', id: nodeId, label: element.getAttribute('data-ref-label') || '节点' };
  const dramaId = element.getAttribute('data-drama-id');
  if (dramaId) return { kind: 'drama', id: dramaId, label: element.getAttribute('data-drama-label') || '资产' };
  const path = element.getAttribute('data-asset-path');
  if (path) return { kind: 'asset', id: path, label: path.split(/[\\/]/).filter(Boolean).pop() || '素材' };
  return null;
}

/** 预览只读取当前库，不修改引用或生成输入。 */
export function resolveDramaMentionPreview(
  library: DramaAssetLibrary,
  globalAssets: readonly DramaAsset[],
  nodes: Array<{ id: string; data?: Record<string, unknown> }>,
  id: string,
  fallbackLabel: string,
): MentionChipPreview {
  const { assetId, referenceImageId, actionId, actionMediaId, voiceClipId, mergeAll } = parseDramaMentionId(id);
  const asset = findDramaAsset(library, assetId, globalAssets);
  const source = t(assetId.startsWith('global/') ? '全局创作资产库' : '创作资产库');
  const preview: MentionChipPreview = {
    label: asset?.name || fallbackLabel,
    displayId: undefined,
    outputType: voiceClipId !== undefined ? 'audio' : 'image',
    thumbnailUrl: undefined,
    sprite: undefined,
    text: '',
    missing: !asset,
    description: `${source} · ${t('引用资产已不存在')}`,
  };
  if (!asset) return preview;

  if (voiceClipId !== undefined) {
    const voice = resolveDramaVoiceRef(asset, voiceClipId);
    return {
      ...preview,
      label: voice?.label || fallbackLabel,
      text: voice?.transcript?.slice(0, 240) || '',
      missing: !voice,
      description: `${source} · ${t(voice ? '角色声音' : '声音引用已失效')}`,
    };
  }
  if (actionId !== undefined) {
    const media = resolveDramaActionMediaRef(asset, actionId, actionMediaId);
    return {
      ...preview,
      label: media?.label || fallbackLabel,
      outputType: media?.kind === 'video' ? 'video' : 'image',
      thumbnailUrl: media && media.kind !== 'video' ? media.url : undefined,
      videoUrl: media?.kind === 'video' ? media.url : undefined,
      filePath: media?.kind === 'video' ? media.filePath : undefined,
      missing: !media,
      description: `${source} · ${t(media ? media.kind === 'video' ? '动作视频' : media.kind === 'gif' ? '动作 GIF' : '动作图片' : '动作素材引用已失效')}`,
    };
  }

  // 全局角色不读取恰好同 ID 的本项目节点，即使旧数据仍残留 sourceNodeId。
  const sourceNodes = assetId.startsWith('global/') ? [] : nodes;
  const brief = formatDramaAssetTextBrief(asset).slice(0, 240);
  if (mergeAll) {
    const thumbnailUrls = collectCharacterReferenceUrls(asset, sourceNodes);
    return {
      ...preview,
      thumbnailUrl: thumbnailUrls[0],
      thumbnailUrls,
      text: thumbnailUrls.length ? '' : brief,
      missing: thumbnailUrls.length === 0,
      description: `${source} · ${thumbnailUrls.length ? t('全部参考图（{count} 张）', { count: thumbnailUrls.length }) : t('全部参考图暂无可用图片')}`,
    };
  }

  if (referenceImageId !== undefined) {
    const reference = asset.referenceImages?.find((item) => item.id === referenceImageId);
    // 指定图身份失效时不回落主视觉，与实际生成的精确引用一致。
    const image = reference
      ? resolveDramaAssetImageRef(asset, sourceNodes, referenceImageId)
      : null;
    return {
      ...preview,
      thumbnailUrl: image?.imageUrl,
      missing: !image,
      description: `${source} · ${t(image ? '指定参考图' : '参考图引用已失效')}`,
    };
  }

  const image = resolveDramaAssetImageRef(asset, sourceNodes);
  return {
    ...preview,
    thumbnailUrl: image?.imageUrl,
    text: image ? '' : brief,
    missing: false,
    description: `${source} · ${t(image ? '{kind}参考图' : '{kind}简介（暂无图片）', { kind: t(DRAMA_ASSET_KIND_LABEL[asset.kind]) })}`,
  };
}
