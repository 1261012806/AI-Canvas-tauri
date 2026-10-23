/**
 * 解析工作流输入中的画布节点、剧本资产和本地资产引用，并替换为可提交的实际内容。
 */
import { useAppStore } from '../store/useAppStore';
import { findDramaAsset, listGlobalDramaAssets, loadGlobalDramaAssetsForPrompt, resolveDramaActionMediaRef, resolveDramaAssetImageRef, resolveDramaVoiceRef } from './dramaAssetPrompt';
import type { DramaAsset } from '../types/dramaAssets';
import { parseDramaMentionId } from '../types/dramaAssets';
import { expandShotlistRowMentions } from './shotlistPromptService';
import { assertNoComfyRefmodMentions } from '../utils/comfyRefmodMention';

/** 解析 workflowInputs 值中的 @{nodeId:label} / @drama{id:name} 引用，替换为对应输出内容 */
function resolveNodeReferenceValue(
  value: string,
  store: ReturnType<typeof useAppStore.getState>,
  globalAssets?: readonly DramaAsset[],
): string {
  const { nodes } = store;
  // 文件资产引用在工作流文本输入中不适用，直接移除标记
  let cleaned = expandShotlistRowMentions(value, nodes).replace(/@asset\{[^}]+\}/g, '');
  assertNoComfyRefmodMentions(cleaned);

  cleaned = cleaned.replace(/@drama\{([^:]+):([^}]+)\}/g, (_match, dramaId: string, dramaName: string) => {
    // 延迟 require 形状的 import 在顶部已有 store；简介格式与 promptResolver 一致
    const lib = store.dramaAssets;
    // 工作流文本输入只能塞一个地址，#all 在这里退化成主视觉那一张
    const { assetId, referenceImageId, actionId, actionMediaId, voiceClipId } = parseDramaMentionId(dramaId);
    const asset = findDramaAsset(lib, assetId, globalAssets ?? listGlobalDramaAssets(store));
    if (voiceClipId !== undefined) {
      const voice = resolveDramaVoiceRef(asset, voiceClipId);
      if (!voice) throw new Error(`角色音频引用已失效：${dramaName || '未命名角色'}`);
      return voice.url;
    }
    if (actionId !== undefined) {
      const media = resolveDramaActionMediaRef(asset, actionId, actionMediaId);
      if (!media) throw new Error(`动作素材引用已失效：${dramaName || '未命名动作'}`);
      return media.url;
    }
    if (!asset) return dramaName || _match;
    const imageReference = resolveDramaAssetImageRef(
      asset,
      nodes as Array<{ id: string; data?: Record<string, unknown> }>,
      referenceImageId,
    );
    if (imageReference) return imageReference.imageUrl;
    // 无图：展开单条简介字段（与 formatDramaAssetTextBrief 同信息，避免循环依赖用内联）
    const parts = [
      asset.name,
      asset.summary,
      asset.visualNotes,
      asset.kind === 'character' ? (asset as { identity?: string }).identity : undefined,
      asset.kind === 'character' ? (asset as { wardrobeDefault?: string }).wardrobeDefault : undefined,
    ].filter(Boolean);
    return parts.join('，') || dramaName;
  });

  const chipRegex = /@\{([^:]+):([^}]+)\}/g;
  const resolved = cleaned.replace(chipRegex, (_match, nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return _match;
    // 文本节点的输出在 data.output 中
    const output = node.data.output as string | undefined;
    if (typeof output === 'string' && output.trim()) return output;
    // 图片 / 导演台节点的输出在 data.imageUrl 或 directorCaptureUrls 中
    const imageUrl = node.data.imageUrl as string | undefined;
    if (typeof imageUrl === 'string' && imageUrl.trim()) return imageUrl;
    if (Array.isArray(node.data.directorCaptureUrls)) {
      const first = (node.data.directorCaptureUrls as string[]).find((u) => typeof u === 'string' && u.trim());
      if (first) return first;
    }
    // 视频 / 音频同理
    const videoUrl = node.data.videoUrl as string | undefined;
    if (typeof videoUrl === 'string' && videoUrl.trim()) return videoUrl;
    const audioUrl = node.data.audioUrl as string | undefined;
    if (typeof audioUrl === 'string' && audioUrl.trim()) return audioUrl;
    // 无法解析，保留原文
    return _match;
  });
  assertNoComfyRefmodMentions(resolved);
  return resolved;
}

export function resolveNodeReferences(value: string, globalAssets?: readonly DramaAsset[]): string {
  return resolveNodeReferenceValue(value, useAppStore.getState(), globalAssets);
}

/** 工作流可直接消费历史提示词，不依赖用户先打开全局创作资产库。 */
export async function resolveNodeReferencesAsync(value: string): Promise<string> {
  const state = useAppStore.getState();
  const expanded = expandShotlistRowMentions(value, state.nodes);
  const globalAssets = await loadGlobalDramaAssetsForPrompt(expanded, state);
  if (useAppStore.getState().currentProjectId !== state.currentProjectId) throw new Error('项目已切换，请重新读取工作流引用');
  return resolveNodeReferenceValue(expanded, state, globalAssets);
}
