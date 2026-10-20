import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import {
  captureCurrentCanvasSnapshot,
  encodeProjectSnapshot,
  getProjectSnapshotBitmapSize,
  isProjectSnapshotDataUrl,
  PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH,
  shouldIncludeProjectSnapshotNode,
  toProjectSnapshotRect,
} from '../../src/services/projectSnapshotService';
import { createProjectSnapshotGeometry, projectSnapshotGeometry } from '../../src/services/projectSnapshotGeometry';
import { registerCanvasViewportController } from '../../src/services/canvasViewportService';

function geometryNode(id: string, x: number, y: number, extra: Partial<Node<BaseNodeData>> = {}): Node<BaseNodeData> {
  return { id, type: 'ai-image', position: { x, y }, data: { type: 'ai-image', label: id, nodeWidth: 100, nodeHeight: 80 }, ...extra };
}

function fakeElement(classes: string[] = [], tagName = 'DIV'): HTMLElement {
  return {
    tagName,
    classList: {
      contains: (value: string) => classes.includes(value),
    },
  } as unknown as HTMLElement;
}

describe('projectSnapshotService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accepts bounded image data URLs only', () => {
    expect(isProjectSnapshotDataUrl('data:image/webp;base64,AAAA')).toBe(true);
    expect(isProjectSnapshotDataUrl('https://example.com/preview.webp')).toBe(false);
    expect(isProjectSnapshotDataUrl(`data:image/webp;base64,${'A'.repeat(PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH)}`)).toBe(false);
  });

  it('filters React Flow chrome while keeping canvas content', () => {
    expect(shouldIncludeProjectSnapshotNode(fakeElement(['react-flow__node']))).toBe(true);
    expect(shouldIncludeProjectSnapshotNode(fakeElement(['react-flow__controls']))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement(['react-flow__minimap']))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement(['react-flow__panel']))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement(['gooey-btn-wrapper']))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement(['node-resize-handles']))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement(['canvas-note-point-handles']))).toBe(false);
  });

  it('skips media surfaces that can taint the snapshot canvas', () => {
    expect(shouldIncludeProjectSnapshotNode(fakeElement([], 'VIDEO'))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement([], 'canvas'))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement([], 'IFRAME'))).toBe(false);
    expect(shouldIncludeProjectSnapshotNode(fakeElement([], 'IMG'))).toBe(true);
  });

  it('reduces WebP quality until the snapshot fits the persistence limit', () => {
    const oversized = `data:image/webp;base64,${'A'.repeat(PROJECT_SNAPSHOT_MAX_DATA_URL_LENGTH)}`;
    const compact = 'data:image/webp;base64,COMPACT';
    const canvas = {
      toDataURL: vi.fn((_type: string, quality?: number) => (
        quality === 0.7 ? oversized : compact
      )),
    };

    expect(encodeProjectSnapshot(canvas)).toBe(compact);
    expect(canvas.toDataURL).toHaveBeenNthCalledWith(1, 'image/webp', 0.7);
    expect(canvas.toDataURL).toHaveBeenNthCalledWith(2, 'image/webp', 0.5);
  });

  it('maps visible DOM bounds into canvas-relative worker coordinates', () => {
    const root = { left: 100, top: 50, right: 900, bottom: 500, width: 800, height: 450 };
    expect(toProjectSnapshotRect({
      left: 220,
      top: 140,
      right: 420,
      bottom: 300,
      width: 200,
      height: 160,
    }, root)).toEqual({ x: 120, y: 90, width: 200, height: 160 });
    expect(toProjectSnapshotRect({
      left: 920,
      top: 140,
      right: 1020,
      bottom: 300,
      width: 100,
      height: 160,
    }, root)).toBeNull();
  });

  it('downsamples media to its thumbnail footprint while preserving its aspect ratio', () => {
    expect(getProjectSnapshotBitmapSize({
      displayHeight: 300,
      displayWidth: 400,
      fit: 'contain',
      scaleX: 0.6,
      scaleY: 0.6,
      sourceHeight: 2_000,
      sourceWidth: 4_000,
    })).toEqual({ width: 240, height: 120 });
  });

  it('keeps enough pixels for cover media without retaining the full source image', () => {
    expect(getProjectSnapshotBitmapSize({
      displayHeight: 300,
      displayWidth: 400,
      fit: 'cover',
      scaleX: 0.6,
      scaleY: 0.6,
      sourceHeight: 2_000,
      sourceWidth: 4_000,
    })).toEqual({ width: 360, height: 180 });
    expect(getProjectSnapshotBitmapSize({
      displayHeight: 450,
      displayWidth: 800,
      fit: 'cover',
      scaleX: 0.6,
      scaleY: 0.6,
      sourceHeight: 8_000,
      sourceWidth: 4_000,
    })).toEqual({ width: 240, height: 480 });
  });

  it('passes only bounded geometry to the worker, excluding business data and references', () => {
    const node = geometryNode('image', 20, 30);
    node.data = { ...node.data, label: '图'.repeat(80), prompt: 'private prompt', filePath: 'private-path', imageUrl: 'private-url' };
    const geometry = createProjectSnapshotGeometry({ nodes: [node], edges: [] });
    expect(geometry.nodes[0].label).toHaveLength(48);
    expect(JSON.stringify(geometry)).not.toMatch(/private|prompt|filePath|imageUrl|"data"/);
    expect(geometry.nodes[0]).toMatchObject({ x: 20, y: 30, width: 100, height: 80 });
  });

  it('resolves parent coordinates and node origins before viewport clipping', () => {
    const geometry = createProjectSnapshotGeometry({ nodes: [
      geometryNode('group', 100, 50, { type: 'group' }),
      geometryNode('child', 40, 30, { parentId: 'group', origin: [0.5, 0.5] }),
      geometryNode('outside', -1_000, 0),
    ], edges: [] });
    const result = projectSnapshotGeometry(geometry, { x: -100, y: 10, zoom: 2 }, 800, 450);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.find((node) => node.label === 'child')).toMatchObject({ x: 80, y: 90, width: 200, height: 160 });
  });

  it('uses persisted numeric group style dimensions when measurements are unavailable', () => {
    const geometry = createProjectSnapshotGeometry({ nodes: [
      geometryNode('group', 0, 0, { type: 'group', style: { width: 900, height: 600 }, data: { type: 'comment', label: 'group' } }),
      geometryNode('invalid-style', 0, 0, { type: 'group', style: { width: '100%', height: 0 }, data: { type: 'comment', label: 'invalid-style' } }),
    ], edges: [] });
    expect(geometry.nodes[0]).toMatchObject({ width: 900, height: 600 });
    expect(geometry.nodes[1]).toMatchObject({ width: 280, height: 160 });
  });

  it('omits cyclic parent chains, collapsed descendants and hidden-node edges', () => {
    const geometry = createProjectSnapshotGeometry({ nodes: [
      geometryNode('cycle-a', 0, 0, { parentId: 'cycle-b' }),
      geometryNode('cycle-b', 0, 0, { parentId: 'cycle-a' }),
      geometryNode('collapsed', 0, 0, { type: 'group', data: { type: 'comment', label: 'collapsed', groupCollapsed: true } }),
      geometryNode('child', 10, 10, { parentId: 'collapsed' }),
      geometryNode('hidden', 10, 10, { hidden: true }),
    ], edges: [{ id: 'hidden-edge', source: 'hidden', target: 'collapsed' }] });
    const result = projectSnapshotGeometry(geometry, { x: 0, y: 0, zoom: 1 }, 800, 450);
    expect(result.nodes.map((node) => node.label)).toEqual(['collapsed']);
    expect(result.edges).toEqual([]);
  });

  it('uses simple handle endpoints and keeps edges crossing the visible viewport', () => {
    const geometry = createProjectSnapshotGeometry({ nodes: [
      geometryNode('left', -150, 30),
      geometryNode('right', 900, 30),
    ], edges: [{ id: 'crossing', source: 'left', target: 'right', sourceHandle: 'right', targetHandle: 'left' }] });
    const result = projectSnapshotGeometry(geometry, { x: 0, y: 0, zoom: 1 }, 800, 450);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([{ points: [{ x: -50, y: 70 }, { x: 900, y: 70 }] }]);
    expect(projectSnapshotGeometry(geometry, { x: 0, y: 0, zoom: Number.NaN }, 800, 450)).toEqual({ nodes: [], edges: [] });
  });

  it('preserves the old thumbnail when worker support or geometry is missing', async () => {
    const querySelector = vi.fn();
    vi.stubGlobal('document', { querySelector });
    vi.stubGlobal('Worker', undefined);
    expect(await captureCurrentCanvasSnapshot('missing-geometry')).toBeNull();
    expect(await captureCurrentCanvasSnapshot('missing-worker', { nodes: [], edges: [] })).toBeNull();
    expect(querySelector).not.toHaveBeenCalled();
  });

  it('fails without DOM cloning when the worker fails', async () => {
    const querySelectorAll = vi.fn();
    const postMessage = vi.fn();
    const canvasRoot = {
      getBoundingClientRect: () => ({ width: 800, height: 450 }),
      querySelectorAll,
    };
    vi.stubGlobal('document', { documentElement: {}, querySelector: vi.fn(() => canvasRoot) });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'black' }));
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', undefined);
    vi.stubGlobal('Worker', class {
      onmessage: unknown;
      onerror?: () => void;
      postMessage() { postMessage(); this.onerror?.(); }
      terminate() {}
    });
    const unregister = registerCanvasViewportController({
      getSnapshot: () => ({ x: 0, y: 0, zoom: 1, visibleBounds: { x: 0, y: 0, width: 800, height: 450 } }),
      setViewport: async () => {},
      fitView: async () => {},
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const geometry = { nodes: [geometryNode('node', 0, 0)], edges: [] };
      const first = captureCurrentCanvasSnapshot('worker-failed', geometry);
      expect(captureCurrentCanvasSnapshot('worker-failed', { ...geometry })).toBe(first);
      const changed = captureCurrentCanvasSnapshot('worker-failed', { ...geometry, nodes: [...geometry.nodes] });
      expect(changed).not.toBe(first);
      expect(await Promise.all([first, changed])).toEqual([null, null]);
      expect(postMessage).toHaveBeenCalledTimes(2);
      expect(querySelectorAll).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('releases extracted bitmaps when worker construction is blocked', async () => {
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450 };
    const bitmap = { close: vi.fn() };
    class SnapshotImage {
      complete = true;
      naturalWidth = 800;
      naturalHeight = 450;
      getBoundingClientRect() { return rect; }
    }
    vi.stubGlobal('HTMLImageElement', SnapshotImage);
    vi.stubGlobal('document', { documentElement: {}, querySelector: () => ({
      getBoundingClientRect: () => rect,
      querySelectorAll: () => [new SnapshotImage()],
    }) });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => 'black', objectFit: 'contain' }));
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked'); } });
    const unregister = registerCanvasViewportController({
      getSnapshot: () => ({ x: 0, y: 0, zoom: 1, visibleBounds: rect }),
      setViewport: async () => {},
      fitView: async () => {},
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await captureCurrentCanvasSnapshot('worker-blocked', { nodes: [], edges: [] })).toBeNull();
      expect(bitmap.close).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });
});
