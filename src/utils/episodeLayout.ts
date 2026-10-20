import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import { indexCanvasChildren } from './canvasHierarchy';

type CanvasNode = Node<BaseNodeData>;
const shotNumber = (label: string) => /(?:^|[^a-z])SH0*(\d+)/i.exec(label)?.[1];
const imageTypes = new Set(['source-image', 'ai-image', 'ai-storyboard']);
const textTypes = new Set(['ai-markdown', 'source-text', 'ai-text']);

interface EpisodeIndex {
  groups: Set<string>;
  children: Map<string, string[]>;
  parents: Map<string, string | undefined>;
  videos: string[];
}

let latestIndex: { nodes: readonly CanvasNode[]; value: EpisodeIndex } | undefined;
interface EpisodeSummary { groupCount: number; videoCount: number; hasVideoNodes: boolean }
let latestSummary: { index: EpisodeIndex; selected?: readonly string[]; value: EpisodeSummary } | undefined;

function sameMembership(current: CanvasNode, previous: CanvasNode): boolean {
  if (current === previous) return true;
  return current.id === previous.id && current.parentId === previous.parentId
    && current.type === previous.type
    && (current.data.type === 'ai-video') === (previous.data.type === 'ai-video')
    && (current.data.shotlistProductionSource?.kind === 'video') === (previous.data.shotlistProductionSource?.kind === 'video')
    && (current.type !== 'group' || (shotNumber(current.data.label || '') !== undefined)
      === (shotNumber(previous.data.label || '') !== undefined));
}

/** Geometry, selection and unrelated model output do not invalidate shot membership. */
function episodeIndex(nodes: readonly CanvasNode[]): EpisodeIndex {
  const cached = latestIndex;
  if (cached?.nodes === nodes) return cached.value;
  if (cached && cached.nodes.length === nodes.length
    && nodes.every((node, index) => sameMembership(node, cached.nodes[index]))) {
    latestIndex = { nodes, value: cached.value };
    return latestIndex.value;
  }
  const children = indexCanvasChildren(nodes);
  const parents = new Map(nodes.map((node) => [node.id, node.parentId]));
  const productionGroups = new Set(nodes.filter((node) => node.data.shotlistProductionSource?.kind === 'video')
    .map((node) => node.parentId));
  const groups = new Set(nodes.filter((node) => node.type === 'group' && !node.parentId
    && (shotNumber(node.data.label || '') !== undefined || productionGroups.has(node.id))).map((node) => node.id));
  const value = { groups, children, parents, videos: nodes.filter((node) => node.data.type === 'ai-video').map((node) => node.id) };
  latestIndex = { nodes, value };
  return value;
}

function selectedShotGroups(index: EpisodeIndex, selected?: readonly string[]): ReadonlySet<string> {
  if (!selected) return index.groups;
  const groups = new Set<string>();
  for (const id of selected) {
    if (index.groups.has(id)) groups.add(id);
    const parent = index.parents.get(id);
    if (parent && index.groups.has(parent)) groups.add(parent);
  }
  return groups;
}

function scopedVideoIds(index: EpisodeIndex, selected?: readonly string[]): string[] {
  const groups = selectedShotGroups(index, selected);
  const ids = selected ? new Set(selected) : undefined;
  return index.videos.filter((id) => {
    const parent = index.parents.get(id);
    return !!(parent && groups.has(parent)) || ids?.has(id) === true;
  });
}

/** Counts are independent of ordering and payloads; the workbench never subscribes to full nodes. */
export function episodeWorkbenchSummary(nodes: readonly CanvasNode[], selected?: readonly string[]) {
  const index = episodeIndex(nodes);
  if (latestSummary?.index === index && latestSummary.selected === selected) return latestSummary.value;
  const value = { groupCount: index.groups.size, videoCount: scopedVideoIds(index, selected).length, hasVideoNodes: index.videos.length > 0 };
  latestSummary = { index, selected, value };
  return value;
}

/** Shot groups must be explicit: do not mistake shared assets or tests for shots. */
export function episodeShotGroups(nodes: readonly CanvasNode[]): CanvasNode[] {
  const index = episodeIndex(nodes);
  return nodes.filter((node) => index.groups.has(node.id))
    .sort((a, b) => Number(shotNumber(a.data.label || '') ?? Infinity)
      - Number(shotNumber(b.data.label || '') ?? Infinity)
      || a.position.y - b.position.y || a.position.x - b.position.x);
}

export function shotVideoNodes(nodes: CanvasNode[], selected?: string[]): CanvasNode[] {
  const index = episodeIndex(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return scopedVideoIds(index, selected).map((id) => byId.get(id)!)
    .sort((a, b) => {
      const ag = a.parentId && index.groups.has(a.parentId) ? byId.get(a.parentId) : undefined;
      const bg = b.parentId && index.groups.has(b.parentId) ? byId.get(b.parentId) : undefined;
      return Number(shotNumber(ag?.data.label || a.data.label) ?? Infinity)
        - Number(shotNumber(bg?.data.label || b.data.label) ?? Infinity)
        || (a.data.displayId ?? Infinity) - (b.data.displayId ?? Infinity);
    });
}

function size(node: CanvasNode) {
  return { width: Number(node.style?.width) || node.data.nodeWidth || node.measured?.width || 280,
    height: Number(node.style?.height) || node.data.nodeHeight || node.measured?.height || 180 };
}

function resize(node: CanvasNode, x: number, y: number, width: number, height: number): CanvasNode {
  return { ...node, position: { x, y }, width, height, measured: undefined,
    style: { ...node.style, width, height },
    data: { ...node.data, nodeWidth: width, nodeHeight: height,
      ...(shotNumber(node.data.label || '') !== undefined && node.type !== 'group' ? { displayLabel: node.data.label } : {}) } };
}

/** Pure layout; group identities, content, file references and membership are unchanged. */
export function layoutEpisodeShots(nodes: CanvasNode[], selected?: string[], columns = 3) {
  const index = episodeIndex(nodes);
  const selectedGroups = selectedShotGroups(index, selected);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const candidates = episodeShotGroups(nodes).filter((group) => selectedGroups.has(group.id));
  const groups = candidates.filter((g) => !g.data.groupCollapsed
    && !(index.children.get(g.id) ?? []).some((id) => byId.get(id)?.type === 'group'));
  if (!groups.length) return { nodes, groupIds: [], skipped: candidates.length };
  const groupIds = new Set(groups.map((g) => g.id));
  const updates = new Map<string, CanvasNode>();
  const heights = new Map<string, number>();
  for (const group of groups) {
    const children = (index.children.get(group.id) ?? []).map((id) => byId.get(id)!);
    const images = children.filter((n) => imageTypes.has(n.data.type));
    const videos = children.filter((n) => n.data.type === 'ai-video' || n.data.type === 'source-video');
    const texts = children.filter((n) => textTypes.has(n.data.type));
    const placed = new Set([...images, ...videos, ...texts].map((n) => n.id));
    let y = 72;
    for (let row = 0; row < Math.max(images.length, videos.length); row++) {
      if (images[row]) updates.set(images[row].id, resize(images[row], 36, y, 240, 427));
      if (videos[row]) updates.set(videos[row].id, resize(videos[row], 356, y, 240, 427));
      y += 475;
    }
    for (const text of texts) {
      const content = text.data.output || text.data.prompt || '';
      const lines = content.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 38)), 0);
      const height = Math.min(900, Math.max(268, 65 + lines * 21));
      updates.set(text.id, resize(text, 36, y, 560, height));
      y += height + 24;
    }
    for (const other of children.filter((n) => !placed.has(n.id))) {
      const { width, height } = size(other);
      updates.set(other.id, resize(other, 36, y, Math.min(560, width), height));
      y += height + 24;
    }
    heights.set(group.id, Math.max(200, y + 12));
  }
  const cols = Math.max(1, Math.min(4, Math.floor(columns) || 3));
  let originX = Math.min(...groups.map((g) => g.position.x));
  const originY = Math.min(...groups.map((g) => g.position.y));
  let totalHeight = 0;
  for (let i = 0; i < groups.length; i += cols) totalHeight += Math.max(...groups.slice(i, i + cols).map((g) => heights.get(g.id)!)) + 48;
  const gridWidth = Math.min(cols, groups.length) * 680 - 48;
  // Move the whole block past obstacles, never move unrelated notes/assets/groups.
  const obstacles = nodes.filter((n) => !n.parentId && !groupIds.has(n.id) && !n.hidden);
  for (let attempt = 0; attempt <= obstacles.length; attempt++) {
    const hits = obstacles.filter((n) => {
      const s = size(n);
      return originX < n.position.x + s.width && originX + gridWidth > n.position.x
        && originY < n.position.y + s.height && originY + totalHeight > n.position.y;
    });
    if (!hits.length) break;
    originX = Math.max(...hits.map((n) => n.position.x + size(n).width)) + 80;
  }
  let rowY = originY;
  for (let i = 0; i < groups.length; i += cols) {
    const row = groups.slice(i, i + cols);
    row.forEach((g, col) => updates.set(g.id, resize(g, originX + col * 680, rowY, 632, heights.get(g.id)!)));
    rowY += Math.max(...row.map((g) => heights.get(g.id)!)) + 48;
  }
  return { nodes: nodes.map((n) => updates.get(n.id) ?? n), groupIds: [...groupIds], skipped: candidates.length - groups.length };
}
