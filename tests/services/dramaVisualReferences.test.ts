import { describe, expect, it } from 'vitest';
import type { DramaScene } from '../../src/types/dramaAssets';
import { normalizeDramaVisualAsset, syncDramaVisualAssetPrimary } from '../../src/types/dramaAssets';
import { resolveDramaAssetImageRef } from '../../src/services/dramaAssetPrompt';

const scene = (patch: Partial<DramaScene> = {}): DramaScene => ({
  id: 'room', kind: 'scene', name: '工作室', key: '工作室', summary: '', visualNotes: '',
  importance: 'main', confirmed: true, createdAt: 1, updatedAt: 2, source: 'manual', ...patch,
});
const references = [
  { id: 'day', label: '白天正面', prompt: '', imageUrl: 'day.png', assetId: 'day-file', relativePath: 'day.png', createdAt: 1, updatedAt: 2 },
  { id: 'night', label: '夜晚侧面', prompt: '', imageUrl: 'night.png', assetId: 'night-file', relativePath: 'night.png', createdAt: 1, updatedAt: 2 },
];

describe('场景道具独立参考图', () => {
  it('旧单图只迁移一次，清空数组不会复活旧主图', () => {
    const legacy = normalizeDramaVisualAsset(scene({ imageUrl: 'old.png', imageNodeId: 'source', assetId: 'file', relativePath: 'old.png' }));
    expect(legacy.referenceImages).toEqual([expect.objectContaining({ id: 'legacy-room', sourceNodeId: 'source', assetId: 'file' })]);
    expect(syncDramaVisualAssetPrimary({ ...legacy, referenceImages: [], primaryReferenceImageId: undefined }))
      .toMatchObject({ imageUrl: undefined, imageNodeId: undefined, assetId: undefined, relativePath: undefined, referenceImages: [] });
  });

  it('换主图只修改兼容投影，不改变已选单图引用', () => {
    const asset = syncDramaVisualAssetPrimary(scene({ referenceImages: references, primaryReferenceImageId: 'night' }));
    expect(asset).toMatchObject({ imageUrl: 'night.png', assetId: 'night-file', relativePath: 'night.png' });
    expect(resolveDramaAssetImageRef(asset, [], 'day')?.imageUrl).toBe('day.png');
    expect(resolveDramaAssetImageRef(asset, [], 'deleted')).toBeNull();
  });

  it('指定图没有产物时不回落到另一张主图', () => {
    const asset = scene({ imageUrl: 'main.png', referenceImages: [{ ...references[0], imageUrl: undefined }] });
    expect(resolveDramaAssetImageRef(asset, [], 'day')).toBeNull();
  });

  it('全局精确引用不会读取本项目恰好同 ID 的节点', () => {
    const asset = scene({ id: 'global/room', referenceImages: [{ ...references[1], sourceNodeId: 'same-node' }] });
    expect(resolveDramaAssetImageRef(asset, [{ id: 'same-node', data: { imageUrl: 'unrelated.png' } }], 'night'))
      .toEqual({ imageNodeId: undefined, imageUrl: 'night.png' });
    expect(syncDramaVisualAssetPrimary(asset, true)).toMatchObject({ imageNodeId: undefined,
      assetId: undefined, imageAssetId: 'night-file', imageRelativePath: 'night.png' });
  });
});
