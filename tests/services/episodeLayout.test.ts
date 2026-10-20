import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';
import { episodeShotGroups, episodeWorkbenchSummary, layoutEpisodeShots, shotVideoNodes } from '../../src/utils/episodeLayout';

function shot(n: number): Node<BaseNodeData>[] {
  const group = `g${n}`;
  return [{ id: group, type: 'group', position: { x: 1000, y: 500 }, data: { type: 'comment', label: `SH${n} 镜头`, groupId: group } },
    ...(['source-image', 'ai-video', 'ai-markdown'] as const).map((type, i) => ({
      id: `${group}-${i}`, parentId: group, type, position: { x: 10, y: 10 },
      data: { type, label: type, output: '原文', seedanceDuration: 6 },
    }))];
}

describe('episode layout', () => {
  it('uses numeric shot order and a full width note without changing data or membership', () => {
    const original = [shot(10), shot(2), shot(1), shot(3)].flat();
    const result = layoutEpisodeShots(original);
    expect(result.groupIds).toEqual(['g1', 'g2', 'g3', 'g10']);
    expect(result.nodes.find((n) => n.id === 'g1-0')?.position).toEqual({ x: 36, y: 72 });
    expect(result.nodes.find((n) => n.id === 'g1-1')?.position).toEqual({ x: 356, y: 72 });
    expect(result.nodes.find((n) => n.id === 'g1-2')).toMatchObject({ position: { x: 36, y: 547 }, width: 560 });
    for (const n of result.nodes) {
      const old = original.find((v) => v.id === n.id)!;
      expect(n.parentId).toBe(old.parentId);
      expect(n.data.output).toBe(old.data.output);
      expect(n.data.seedanceDuration).toBe(old.data.seedanceDuration);
    }
    expect(original[1].position.x).toBe(10);
    const again = layoutEpisodeShots(result.nodes);
    expect(again.nodes).toEqual(result.nodes);
  });
  it('expands rows for long text and clears unrelated obstacles without moving them', () => {
    const nodes = [...shot(1), ...shot(2), ...shot(3), ...shot(4)];
    nodes.find((n) => n.id === 'g1-2')!.data.output = '很长的台词\n'.repeat(45);
    const unrelated: Node<BaseNodeData> = { id: 'assets', position: { x: 1500, y: 500 }, data: { type: 'comment', label: '资料' }, style: { width: 600, height: 800 } };
    const result = layoutEpisodeShots([...nodes, unrelated]);
    expect(result.nodes.find((n) => n.id === 'assets')).toBe(unrelated);
    const first = result.nodes.find((n) => n.id === 'g1')!;
    const next = result.nodes.find((n) => n.id === 'g4')!;
    expect(first.position.x).toBeGreaterThan(2100);
    expect(next.position.y).toBeGreaterThanOrEqual(first.position.y + first.height! + 48);
  });
  it('only arranges selected expanded groups, leaving shared and folded nodes intact', () => {
    const nodes = [...shot(1), ...shot(2)];
    const result = layoutEpisodeShots(nodes, ['g1-1']);
    expect(result.groupIds).toEqual(['g1']);
    expect(result.nodes.find((n) => n.id === 'g2')).toBe(nodes[4]);
    nodes[0].data.groupCollapsed = true;
    expect(layoutEpisodeShots(nodes, ['g1']).groupIds).toEqual([]);
  });
  it('batch selection contains only videos from shot groups, never shared assets or tests', () => {
    const nodes = [...shot(2), ...shot(1), { ...shot(9)[1], id: 'independent', parentId: undefined, type: 'ai-video', data: { type: 'ai-video' as const, label: '独立测试' } }];
    expect(episodeShotGroups(nodes)).toHaveLength(2);
    expect(shotVideoNodes(nodes).map((n) => n.id)).toEqual(['g1-1', 'g2-1']);
    expect(shotVideoNodes(nodes, ['g2']).map((n) => n.id)).toEqual(['g2-1']);
    expect(shotVideoNodes(nodes, ['independent']).map((n) => n.id)).toEqual(['independent']);
    expect(shotVideoNodes(nodes, [])).toEqual([]);
  });

  it('keeps workbench counts stable through selection, geometry and unrelated output updates', () => {
    const nodes = [...shot(1), ...shot(2)];
    const summary = episodeWorkbenchSummary(nodes);
    const changed = nodes.map((node) => ({
      ...node, selected: true, position: { x: node.position.x + 120, y: node.position.y + 40 },
      data: { ...node.data, output: '新的生成结果' },
    }));
    expect(episodeWorkbenchSummary(changed)).toBe(summary);
    expect(summary).toEqual({ groupCount: 2, videoCount: 2, hasVideoNodes: true });
    expect(shotVideoNodes(changed)[0]).toBe(changed.find((node) => node.id === 'g1-1'));
    expect(episodeWorkbenchSummary(changed, ['g2-0']).videoCount).toBe(1);
    expect(episodeWorkbenchSummary(changed, []).videoCount).toBe(0);
  });

  it('updates unnumbered production groups by current position while reusing count membership', () => {
    const nodes = [...shot(1), ...shot(2)].map((node) => node.type === 'group'
      ? { ...node, position: { x: node.id === 'g1' ? 0 : 500, y: 0 }, data: { ...node.data, label: '镜头组' } }
      : node.data.type === 'ai-video' ? { ...node, data: { ...node.data,
        shotlistProductionSource: { nodeId: 'table', rowId: node.id, kind: 'video' as const },
      } } : node);
    const summary = episodeWorkbenchSummary(nodes);
    expect(episodeShotGroups(nodes).map((node) => node.id)).toEqual(['g1', 'g2']);
    const moved = nodes.map((node) => node.id === 'g1' ? { ...node, position: { x: 1_000, y: 0 } } : node);
    expect(episodeWorkbenchSummary(moved)).toBe(summary);
    expect(episodeShotGroups(moved).map((node) => node.id)).toEqual(['g2', 'g1']);
  });

  it('invalidates counts on membership and production identity changes without using stale node data', () => {
    const nodes = shot(1);
    expect(episodeWorkbenchSummary(nodes).videoCount).toBe(1);
    const movedOut = nodes.map((node) => node.id === 'g1-1' ? { ...node, parentId: undefined } : node);
    expect(episodeWorkbenchSummary(movedOut).videoCount).toBe(0);
    expect(episodeWorkbenchSummary(movedOut, ['g1-1']).videoCount).toBe(1);
    const unnamed = movedOut.map((node) => node.id === 'g1' ? { ...node, data: { ...node.data, label: '普通分组' } } : node);
    expect(episodeWorkbenchSummary(unnamed).groupCount).toBe(0);
    const numbered = unnamed.map((node) => node.id === 'g1' ? { ...node, data: { ...node.data, label: 'SH10' } } : node);
    expect(episodeWorkbenchSummary(numbered).groupCount).toBe(1);
  });

  it('recognizes and removes unnumbered shot groups when production provenance changes', () => {
    const nodes = shot(1).map((node) => node.type === 'group'
      ? { ...node, data: { ...node.data, label: '未编号组' } } : node);
    expect(episodeWorkbenchSummary(nodes).groupCount).toBe(0);
    const linked = nodes.map((node) => node.id === 'g1-1' ? { ...node, data: { ...node.data,
      shotlistProductionSource: { nodeId: 'table', rowId: 'row', kind: 'video' as const },
    } } : node);
    expect(episodeWorkbenchSummary(linked)).toMatchObject({ groupCount: 1, videoCount: 1 });
    const detached = linked.map((node) => node.id === 'g1-1' ? { ...node, data: { ...node.data, shotlistProductionSource: undefined } } : node);
    expect(episodeWorkbenchSummary(detached)).toMatchObject({ groupCount: 0, videoCount: 0 });
  });
});
