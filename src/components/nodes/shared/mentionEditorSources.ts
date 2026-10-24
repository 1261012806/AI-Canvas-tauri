/**
 * nodes/shared/mentionEditorSources — @ 提及候选来源解析。
 * 收集画布上可被引用的生成节点（含上游连线输出）与工作流 IO 节点，
 * 解析出带缩略图、输出类型与自引用标记的提及条目，供提示词编辑器联想补全。
 */
import { t } from '../../../i18n';
import type { AppState } from '../../../store/useAppStore';
import type { BaseNodeData, NodeType, StoryboardCellOverride, WorkflowIONodeType } from '../../../types';
import { bestNodeThumb } from './mentionEditorDom';
import { resolveDramaVoiceRef } from '../../../services/dramaAssetPrompt';
import type { DramaAsset, DramaAssetKind } from '../../../types/dramaAssets';
import { emptyDramaAssetLibrary } from '../../../types/dramaAssets';
import { buildShotlistRowMentionId } from '../../../types/shotlist';

export interface CanvasMentionItem {
  id: string;
  label: string;
  type: NodeType;
  displayId: number | undefined;
  hasOutput: boolean;
  outputType: 'image' | 'video' | 'audio' | 'text';
  thumbnailUrl: string | undefined;
  videoUrl?: string;
  filePath?: string;
  isSelf: boolean;
  /** 仅用于候选匹配；文件只保留名称，不暴露完整路径。 */
  searchValues?: Array<string | number | undefined | null>;
}

export interface WorkflowMentionItem {
  id: string;
  label: string;
  _ioNodeId: string;
  _ioType: WorkflowIONodeType;
}

export type WorkflowMentionFilter = 'all' | WorkflowIONodeType;
const WORKFLOW_FILTER_LABELS: Array<{ id: WorkflowMentionFilter; label: string }> = [
  { id: 'all', label: '全部' }, { id: 'image', label: '图片' }, { id: 'video', label: '视频' },
  { id: 'audio', label: '音乐' }, { id: 'prompt', label: '文本' },
];

export function filterWorkflowMentions(items: WorkflowMentionItem[], filter: WorkflowMentionFilter): WorkflowMentionItem[] {
  return filter === 'all' ? items : items.filter((item) => item._ioType === filter);
}

export function workflowMentionFilterChips(items: WorkflowMentionItem[]): Array<{ id: WorkflowMentionFilter; label: string; count: number }> {
  return WORKFLOW_FILTER_LABELS.map((filter) => ({ ...filter, label: t(filter.label), count: filterWorkflowMentions(items, filter.id).length }));
}

/** 每个查询词可匹配不同字段，兼容全角字符与节点编号。 */
export function matchesMentionQuery(
  query: string,
  values: Array<string | number | undefined | null>,
): boolean {
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystacks = values.filter((value) => value != null).map((value) => normalize(String(value)));
  return terms.every((term) => haystacks.some((value) => value.includes(term)));
}

function nodeSearchValues(id: string, data: BaseNodeData): CanvasMentionItem['searchValues'] {
  return [
    id,
    data.label,
    data.displayId,
    data.displayId == null ? undefined : `#${data.displayId}`,
    data.fileName,
    data.filePath?.split(/[\\/]/).pop(),
  ];
}

function nodeMentionMedia(data: BaseNodeData): Pick<CanvasMentionItem, 'outputType' | 'thumbnailUrl' | 'videoUrl' | 'filePath'> {
  const outputType = data.type === 'ai-video' || data.type === 'source-video' ? 'video'
    : data.imageUrl ? 'image' : data.videoUrl ? 'video' : data.audioUrl ? 'audio' : 'text';
  return {
    outputType, thumbnailUrl: bestNodeThumb(data),
    videoUrl: outputType === 'video' ? data.videoUrl : undefined,
    filePath: outputType === 'video' ? data.filePath : undefined,
  };
}

export function resolveCanvasMentionNodes(
  nodeId: string | undefined,
  nodes: AppState['nodes'],
  edges: AppState['edges'],
  scope: 'connected' | 'project' = 'connected',
): CanvasMentionItem[] {
  if (!nodeId && scope === 'connected') return [];
  const currentNode = nodes.find((node) => node.id === nodeId);
  const rawSourceIds = new Set(edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source));
  if (currentNode?.parentId) {
    edges.filter((edge) => edge.target === currentNode.parentId)
      .forEach((edge) => rawSourceIds.add(edge.source));
  }

  const sourceNodeIds = new Set<string>();
  for (const sourceId of rawSourceIds) {
    const sourceNode = nodes.find((node) => node.id === sourceId);
    if (sourceNode?.type === 'group') {
      nodes.filter((node) => node.parentId === sourceId)
        .forEach((node) => sourceNodeIds.add(node.id));
    } else {
      sourceNodeIds.add(sourceId);
    }
  }

  const list: CanvasMentionItem[] = nodes
    .filter((node) => node.id !== nodeId && node.type !== 'group'
      && (scope === 'project'
        ? !!node.data.type && node.data.type !== 'canvas-note' && !node.data.hiddenByCharacterLibrary
        : sourceNodeIds.has(node.id)))
    .map((node) => ({
      id: node.id,
      label: (node.data.label as string) || '节点',
      type: node.data.type,
      displayId: node.data.displayId as number | undefined,
      hasOutput: !!node.data.output,
      ...nodeMentionMedia(node.data),
      isSelf: false,
      searchValues: nodeSearchValues(node.id, node.data),
    }));

  const expanded: CanvasMentionItem[] = [];
  for (const item of list) {
    expanded.push(item);
    if (item.type === 'ai-shotlist') {
      const sheet = nodes.find((node) => node.id === item.id);
      sheet?.data.shotlistRows?.forEach((row, index) => {
        const id = buildShotlistRowMentionId(item.id, row.id);
        const shotLabel = `镜${row.shotNo || index + 1}`;
        expanded.push({
          id, label: `${shotLabel} · ${item.label}`, type: 'ai-shotlist',
          displayId: undefined, hasOutput: true, outputType: 'text', thumbnailUrl: undefined, isSelf: false,
          searchValues: [...(item.searchValues ?? []), id, row.id, row.shotNo, shotLabel, `第${index + 1}镜`, row.content, row.dialogue],
        });
      });
      continue;
    }
    if (item.type !== 'ai-storyboard') continue;
    const storyboard = nodes.find((node) => node.id === item.id);
    if (!storyboard) continue;
    const data = storyboard.data as BaseNodeData;
    const cols = Math.max(1, data.storyboardCols || 3);
    const rows = Math.max(1, data.storyboardRows || 3);
    const extracted = data.storyboardExtracted ?? [];
    const overrides = data.storyboardOverrides ?? [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < cols; column += 1) {
        const index = row * cols + column;
        if (extracted[index] && !overrides[index]) continue;
        expanded.push({
          id: `${item.id}/cell/${index}`,
          label: `${item.label} · 第${row + 1}行${column + 1}列`,
          type: 'ai-image',
          displayId: undefined,
          hasOutput: true,
          outputType: 'image',
          thumbnailUrl: (overrides[index] as StoryboardCellOverride | null)?.url || data.imageUrl,
          isSelf: false,
          searchValues: [...(item.searchValues ?? []), `${item.id}/cell/${index}`, `第${row + 1}行${column + 1}列`],
        });
      }
    }
  }

  if (currentNode && currentNode.type !== 'group'
    && (scope !== 'project'
      || (!!currentNode.data.type && currentNode.data.type !== 'canvas-note' && !currentNode.data.hiddenByCharacterLibrary))) {
    const { output, imageUrl, videoUrl, audioUrl } = currentNode.data;
    if ((typeof output === 'string' && output.trim()) || imageUrl || videoUrl || audioUrl) {
      expanded.unshift({
        id: currentNode.id,
        label: currentNode.data.label || '节点',
        type: currentNode.data.type,
        displayId: currentNode.data.displayId,
        hasOutput: true,
        ...nodeMentionMedia(currentNode.data),
        isSelf: true,
        searchValues: nodeSearchValues(currentNode.id, currentNode.data),
      });
    }
  }
  return expanded;
}

export function resolveWorkflowMentionNodes(
  selectedWorkflowId: string | undefined,
  ioNodes: Array<{ nodeId: string; title: string; type: WorkflowIONodeType }>,
): WorkflowMentionItem[] {
  if (!selectedWorkflowId) return [];
  return ioNodes.map((io) => ({
    id: `wf:${io.nodeId}`,
    label: io.title,
    _ioNodeId: io.nodeId,
    _ioType: io.type,
  }));
}

export function resolveDramaMentionItems(
  dramaAssets: AppState['dramaAssets'],
  query: string,
  nodeType?: NodeType,
  globalAssets: readonly DramaAsset[] = [],
) {
  const projectAssets: DramaAsset[] = [...dramaAssets.characters, ...dramaAssets.scenes, ...dramaAssets.props];
  const items = [
    ...projectAssets,
    ...globalAssets.map((asset) => ({ ...asset, id: `global/${asset.id}` })),
  ].map((asset) => ({
    id: asset.id,
    name: asset.name,
    aliases: asset.kind === 'character' ? asset.aliases : undefined,
    kind: asset.kind as string,
    imageNodeId: asset.id.startsWith('global/') ? undefined : asset.imageNodeId,
    imageUrl: asset.imageUrl,
    referenceImages: asset.kind === 'character' ? asset.referenceImages : undefined,
    voice: nodeType === 'ai-audio' ? resolveDramaVoiceRef(asset) : null,
  }));
  const candidates = nodeType === 'ai-audio' ? items.filter((item) => item.voice) : items;
  // 分类数量和筛选共用完整候选，不能提前截断而丢失排在后面的场景或道具。
  if (!query) return candidates;
  return candidates.filter((asset) => matchesMentionQuery(query, [asset.name, asset.id, ...(asset.aliases ?? [])]));
}

/** 全局弹框独立于 @ 菜单开关，只从原始全局资产生成带作用域的候选。 */
export function resolveGlobalAssetPickerItems(
  globalAssets: readonly DramaAsset[],
  kind: DramaAssetKind | null,
  query: string,
  nodeType?: NodeType,
) {
  const filtered = globalAssets.filter((asset) => {
    if (kind !== null && asset.kind !== kind) return false;
    const details = asset.kind === 'character'
      ? [...(asset.aliases ?? []), asset.identity, asset.ageBand, asset.gender, asset.personality, asset.wardrobeDefault, asset.voiceNotes]
      : asset.kind === 'scene'
        ? [asset.placeType, asset.timeOfDay, asset.atmosphere, asset.spatialNotes]
        : [asset.ownerName, asset.category, asset.significance];
    return matchesMentionQuery(query, [asset.name, asset.id, asset.key, asset.summary, asset.visualNotes, asset.storyRole, ...details]);
  });
  return resolveDramaMentionItems(emptyDramaAssetLibrary(), '', nodeType, filtered);
}
