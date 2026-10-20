interface HierarchyNode {
  id: string;
  parentId?: string;
}

/** A command-local index; no node data, media or runtime references are retained. */
export function indexCanvasChildren(nodes: readonly HierarchyNode[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node.id);
    else children.set(node.parentId, [node.id]);
  }
  return children;
}

/** Includes roots, handles overlapping selections and terminates on malformed parent cycles. */
export function collectCanvasDescendantIds(nodes: readonly HierarchyNode[], roots: Iterable<string>): Set<string> {
  const ids = new Set(roots);
  if (ids.size === 0) return ids;
  const children = indexCanvasChildren(nodes);
  const queue = [...ids];
  for (let head = 0; head < queue.length; head += 1) {
    for (const id of children.get(queue[head]) ?? []) {
      if (ids.has(id)) continue;
      ids.add(id);
      queue.push(id);
    }
  }
  return ids;
}
