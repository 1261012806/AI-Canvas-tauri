import { describe, expect, it } from 'vitest';
import { collectCanvasDescendantIds } from '../../src/utils/canvasHierarchy';

describe('canvas hierarchy traversal', () => {
  it('includes nested descendants once when both parent and child are selected', () => {
    const nodes = [
      { id: 'root' }, { id: 'child', parentId: 'root' }, { id: 'leaf', parentId: 'child' },
      { id: 'sibling', parentId: 'root' }, { id: 'unrelated' },
    ];
    expect([...collectCanvasDescendantIds(nodes, ['root', 'child', 'root'])])
      .toEqual(['root', 'child', 'sibling', 'leaf']);
    expect(collectCanvasDescendantIds(nodes, [])).toEqual(new Set());
    expect(nodes[2].parentId).toBe('child');
  });

  it('terminates on parent cycles and retains explicitly requested missing roots', () => {
    const nodes = [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }, { id: 'leaf', parentId: 'b' }];
    expect(collectCanvasDescendantIds(nodes, ['a', 'missing']))
      .toEqual(new Set(['a', 'missing', 'b', 'leaf']));
  });

  it('handles deeply nested groups without recursion', () => {
    const nodes = Array.from({ length: 2_000 }, (_, index) => ({ id: String(index), parentId: index ? String(index - 1) : undefined }));
    const ids = collectCanvasDescendantIds(nodes, ['0']);
    expect(ids.size).toBe(nodes.length);
    expect(ids.has('1999')).toBe(true);
  });
});
