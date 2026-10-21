import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import type { AppState } from '../store/useAppStore';
import type { VideoPreflightItem } from '../types/videoBatch';
import { resolveVideoSubmissionControls } from './ai/videoRequestResolver';
import { parseProjectModelRef } from './projectSettingsService';
import { comfyBaseUrlFor, probeComfyServer } from './comfyServers';
import { expandShotlistRowMentions } from './shotlistPromptService';
import { isShotRowBlank } from '../types/shotlist';
import { parseDramaMentionId } from '../types/dramaAssets';
import { collectCharacterReferenceUrls, findDramaAsset, resolveDramaAssetImageRef } from './dramaAssetPrompt';

type Workspace = Pick<AppState, 'nodes' | 'edges' | 'workflows' | 'projects' | 'currentProjectId' | 'config'>
  & Partial<Pick<AppState, 'dramaAssets' | 'globalCharacters'>>;

export function videoInputData(node: Node<BaseNodeData>, state: Workspace): BaseNodeData {
  const fallback = parseProjectModelRef(state.projects.find((p) => p.id === state.currentProjectId)?.settings?.defaultModels?.video);
  const parsed = parseProjectModelRef(node.data.model);
  return { ...node.data,
    model: node.data.model || fallback?.model,
    provider: node.data.model ? node.data.provider || parsed?.provider : fallback?.provider || node.data.provider,
    workflowId: node.data.workflowId || (!node.data.model ? fallback?.workflowId : undefined) };
}

function referencedInput(data: BaseNodeData, state: Workspace, nodeId: string) {
  const raw = `${data.prompt || ''}\n${JSON.stringify(data.workflowInputs || {})}`;
  let text = raw;
  let error: string | undefined;
  try {
    const controls = resolveVideoSubmissionControls({ ...data, provider: data.provider || '', workflowId: data.workflowId });
    const options = { durationSeconds: controls.seedanceDuration };
    const prompt = expandShotlistRowMentions(data.prompt || '', state.nodes, options);
    // 与提交入口逐字段展开一致，IO 的精确镜头不能消除主提示词的整表输入。
    const inputs = Object.fromEntries(Object.entries(data.workflowInputs || {}).map(([key, value]) => [key,
      typeof value === 'string' ? expandShotlistRowMentions(value, state.nodes, options) : value,
    ]));
    text = `${prompt}\n${JSON.stringify(inputs)}`;
  }
  catch (cause) { error = cause instanceof Error ? cause.message : '镜头引用无效'; }
  const mentionedIds = error ? [] : [...text.matchAll(/@\{([^:}]+):[^}]*\}/g)].map((match) => match[1]);
  const ids = [...new Set(mentionedIds.concat(state.edges.filter((e) => e.target === nodeId).map((e) => e.source)))];
  return { text, error, mentionedIds, ids };
}

/** Non-security change detector. Persist only the digest, never the input payload. */
export function videoInputFingerprint(node: Node<BaseNodeData>, state: Workspace): string {
  const d = videoInputData(node, state);
  const input = referencedInput(d, state, node.id);
  const refs = input.ids.map((id) => {
    const cell = /^(.*)\/cell\/(\d+)$/.exec(id);
    const r = state.nodes.find((n) => n.id === (cell?.[1] ?? id))?.data;
    // 精确镜头的来源边不等于整表输入，其他行的编辑不使该镜头失效。
    if (r?.type === 'ai-shotlist') return [id, input.mentionedIds.includes(id) ? r.shotlistRows : undefined];
    return [id, r?.imageUrl || r?.thumbnailUrl, r?.videoUrl, r?.audioUrl, r?.output, r?.mediaVersion,
      cell ? [r?.storyboardRows, r?.storyboardCols, r?.storyboardRowPositions, r?.storyboardColPositions,
        r?.storyboardOverrides?.[Number(cell[2])]] : undefined];
  });
  const library = state.dramaAssets;
  const dramaRefs = library ? [...new Set([...input.text.matchAll(/@drama\{([^:}]+):[^}]*\}/g)].map((match) => match[1]))]
    .map((id) => {
      const parsed = parseDramaMentionId(id);
      const asset = findDramaAsset(library, parsed.assetId, state.globalCharacters);
      return [id, asset, asset ? resolveDramaAssetImageRef(asset, state.nodes, parsed.referenceImageId) : undefined,
        asset && parsed.mergeAll ? collectCharacterReferenceUrls(asset, state.nodes) : undefined];
    }) : [];
  const payload = JSON.stringify([d.prompt, input.text, input.error, d.model, d.provider, d.workflowId, d.workflowInputs,
    d.videoResolution, d.videoFrames, d.videoFps, d.seedanceDuration, d.seedanceRatio, d.seedanceResolution,
    d.generateAudio, d.videoReferences, d.runninghubModelParameters, d.cameraSettings, refs, dramaRefs,
    state.projects.find((p) => p.id === state.currentProjectId)?.settings]);
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i++) hash = Math.imul(hash ^ payload.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function inspectVideoNode(node: Node<BaseNodeData>, state: Workspace): VideoPreflightItem {
  const d = videoInputData(node, state);
  const issues: string[] = [];
  if (d.type !== 'ai-video') issues.push('不是视频生成节点');
  if (!d.prompt?.trim()) issues.push('缺少提示词');
  if (!d.model || !d.provider) issues.push('未选择视频模型');
  if (d.status === 'loading') issues.push('节点正在生成，请等待完成');
  if (d.workflowId && !state.workflows.some((w) => w.id === d.workflowId)) issues.push('工作流已删除或未载入');
  if (d.provider === 'comfyui' && !d.workflowId) issues.push('未选择 ComfyUI 工作流');
  const controls = resolveVideoSubmissionControls({ ...d, provider: d.provider || '' });
  const duration = controls.seedanceDuration;
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) issues.push('视频时长无效');
  const input = referencedInput(d, state, node.id);
  if (input.error) issues.push(input.error);
  for (const id of input.ids) {
    const sourceId = id.replace(/\/cell\/\d+$/, '');
    const ref = state.nodes.find((n) => n.id === sourceId);
    if (!ref) { issues.push('引用节点已删除'); continue; }
    if (ref.data.type === 'ai-shotlist' && ref.data.shotlistRows?.some((row) => !isShotRowBlank(row))) continue;
    if (![ref.data.imageUrl, ref.data.videoUrl, ref.data.audioUrl, ref.data.output].some((v) => typeof v === 'string' && v.trim())) {
      issues.push(`参考缺少内容：${ref.data.label || '未命名节点'}`);
    }
  }
  const fingerprint = videoInputFingerprint(node, state);
  return { nodeId: node.id, label: d.label || `视频 #${d.displayId ?? ''}`, fingerprint, duration,
    issues: [...new Set(issues)], existing: Boolean(d.videoUrl),
    stale: Boolean(d.videoUrl && (d.status === 'error' || (d.videoBatchFingerprint && d.videoBatchFingerprint !== fingerprint))) };
}

/** Read-only service probing. API transports without a health endpoint are checked at submission. */
export async function checkVideoServices(items: VideoPreflightItem[], state: Workspace): Promise<VideoPreflightItem[]> {
  const probes = new Map<string, Promise<boolean>>();
  return Promise.all(items.map(async (item) => {
    const node = state.nodes.find((n) => n.id === item.nodeId);
    if (!node || videoInputData(node, state).provider !== 'comfyui') return item;
    const url = comfyBaseUrlFor(videoInputData(node, state).workflowId);
    if (!probes.has(url)) probes.set(url, probeComfyServer(url));
    return await probes.get(url) ? item : { ...item, issues: [...item.issues, 'ComfyUI 服务不可用'] };
  }));
}
