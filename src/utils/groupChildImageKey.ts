import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../types';

let imageKeyCache = new WeakMap<readonly Node<BaseNodeData>[], Map<string, string>>();

export type GroupCoverItem =
  | { id: string; kind: 'image'; url: string }
  | { id: string; kind: 'video' };

/** 所有分组共用当前节点数组的封面索引；仅保留最新一份，避免历史快照滞留大图字符串。 */
export function getGroupChildImageKey(nodes: readonly Node<BaseNodeData>[], groupId: string): string {
  let imageKeys = imageKeyCache.get(nodes);
  if (!imageKeys) {
    const images = new Map<string, GroupCoverItem[]>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const url = node.data.thumbnailUrl || node.data.imageUrl;
      const type = node.type ?? node.data.type;
      const cover: GroupCoverItem | undefined = type === 'ai-video' || type === 'source-video'
        ? { id: node.id, kind: 'video' }
        : url ? { id: node.id, kind: 'image', url } : undefined;
      if (!cover) continue;
      const groupImages = images.get(node.parentId);
      if (groupImages) groupImages.push(cover);
      else images.set(node.parentId, [cover]);
    }
    imageKeys = new Map(Array.from(images, ([id, covers]) => [id, JSON.stringify(covers)]));
    imageKeyCache = new WeakMap([[nodes, imageKeys]]);
  }
  return imageKeys.get(groupId) ?? '';
}
