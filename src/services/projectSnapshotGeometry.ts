import type { Edge, Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';
import type { ProjectSnapshotEdge, ProjectSnapshotNode } from './projectSnapshotWorker';

export interface ProjectSnapshotGeometryInput {
  nodes: readonly Node<BaseNodeData>[];
  edges: readonly Edge[];
}

interface SnapshotGeometryNode {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
  originX: number;
  originY: number;
  hidden: boolean;
  collapsed: boolean;
  noteKind?: string;
}

type HandleSide = 'left' | 'right' | 'top' | 'bottom';

export interface ProjectSnapshotGeometry {
  nodes: SnapshotGeometryNode[];
  edges: Array<{ source: string; target: string; sourceHandle: HandleSide; targetHandle: HandleSide }>;
}

export interface ProjectSnapshotViewport {
  x: number;
  y: number;
  zoom: number;
}

function positiveSize(fallback: number, ...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

function handleSide(value: string | null | undefined, fallback: HandleSide): HandleSide {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom' ? value : fallback;
}

/** Only geometry and a bounded display label cross the worker boundary, never node data. */
export function createProjectSnapshotGeometry(input: ProjectSnapshotGeometryInput): ProjectSnapshotGeometry {
  return {
    nodes: input.nodes.map((node) => ({
      id: node.id,
      type: node.type ?? node.data.type,
      label: String(node.data.label ?? '').slice(0, 48).trim(),
      x: node.position.x,
      y: node.position.y,
      width: positiveSize(node.type === 'ai-audio' ? 260 : 280, node.measured?.width, node.width, node.data.nodeWidth, node.style?.width, node.data.note?.width),
      height: positiveSize(node.type === 'ai-audio' ? 140 : 160, node.measured?.height, node.height, node.data.nodeHeight, node.style?.height, node.data.note?.height),
      parentId: node.parentId,
      originX: node.origin?.[0] ?? 0,
      originY: node.origin?.[1] ?? 0,
      hidden: node.hidden === true || node.data.hiddenByCharacterLibrary === true,
      collapsed: node.data.groupCollapsed === true,
      noteKind: node.type === 'canvas-note' ? node.data.note?.kind : undefined,
    })),
    edges: input.edges.filter((edge) => !edge.hidden).map((edge) => ({
      source: edge.source,
      target: edge.target,
      sourceHandle: handleSide(edge.sourceHandle, 'right'),
      targetHandle: handleSide(edge.targetHandle, 'left'),
    })),
  };
}

interface ResolvedNode extends SnapshotGeometryNode {
  x: number;
  y: number;
}

/** Runs in the worker: parent resolution, visibility and viewport clipping need no DOM. */
export function projectSnapshotGeometry(
  geometry: ProjectSnapshotGeometry,
  viewport: ProjectSnapshotViewport,
  width: number,
  height: number,
): { nodes: ProjectSnapshotNode[]; edges: ProjectSnapshotEdge[] } {
  if (![viewport.x, viewport.y, viewport.zoom, width, height].every(Number.isFinite)
    || viewport.zoom <= 0 || width <= 0 || height <= 0) return { nodes: [], edges: [] };

  const byId = new Map(geometry.nodes.map((node) => [node.id, node]));
  const resolved = new Map<string, ResolvedNode | null>();
  for (const node of geometry.nodes) {
    if (resolved.has(node.id)) continue;
    const path: SnapshotGeometryNode[] = [];
    const seen = new Set<string>();
    let cursor: SnapshotGeometryNode | undefined = node;
    let parent: ResolvedNode | null | undefined;
    while (cursor) {
      if (resolved.has(cursor.id)) {
        parent = resolved.get(cursor.id);
        break;
      }
      if (seen.has(cursor.id) || path.length >= 256
        || ![cursor.x, cursor.y, cursor.width, cursor.height, cursor.originX, cursor.originY].every(Number.isFinite)
        || cursor.width <= 0 || cursor.height <= 0) {
        parent = null;
        break;
      }
      seen.add(cursor.id);
      path.push(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    for (const item of path.reverse()) {
      parent = parent === null ? null : {
        ...item,
        x: (parent?.x ?? 0) + item.x - item.originX * item.width,
        y: (parent?.y ?? 0) + item.y - item.originY * item.height,
        hidden: item.hidden || parent?.hidden === true || parent?.collapsed === true,
      };
      resolved.set(item.id, parent);
    }
  }

  const screenNodes = new Map<string, ProjectSnapshotNode>();
  const nodes: ProjectSnapshotNode[] = [];
  for (const node of resolved.values()) {
    if (!node || node.hidden) continue;
    const rect: ProjectSnapshotNode = {
      x: node.x * viewport.zoom + viewport.x,
      y: node.y * viewport.zoom + viewport.y,
      width: node.width * viewport.zoom,
      height: node.height * viewport.zoom,
      kind: node.type,
      label: node.label,
      noteKind: node.noteKind,
    };
    screenNodes.set(node.id, rect);
    if (rect.x < width && rect.x + rect.width > 0 && rect.y < height && rect.y + rect.height > 0) nodes.push(rect);
  }
  const endpoint = (node: ProjectSnapshotNode, side: HandleSide) => ({
    x: node.x + (side === 'left' ? 0 : side === 'right' ? node.width : node.width / 2),
    y: node.y + (side === 'top' ? 0 : side === 'bottom' ? node.height : node.height / 2),
  });
  const edges: ProjectSnapshotEdge[] = [];
  for (const edge of geometry.edges) {
    const source = screenNodes.get(edge.source);
    const target = screenNodes.get(edge.target);
    if (!source || !target) continue;
    const start = endpoint(source, edge.sourceHandle);
    const end = endpoint(target, edge.targetHandle);
    if (Math.max(start.x, end.x) < 0 || Math.min(start.x, end.x) > width
      || Math.max(start.y, end.y) < 0 || Math.min(start.y, end.y) > height) continue;
    edges.push({ points: [start, end] });
  }
  return { nodes, edges };
}
