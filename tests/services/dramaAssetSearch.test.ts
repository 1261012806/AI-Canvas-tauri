import { describe, expect, it } from 'vitest';
import type { DramaAsset, DramaCharacter, DramaScene } from '../../src/types/dramaAssets';
import { dramaAssetIdentityKey, matchesDramaAssetQuery, sortDramaAssets } from '../../src/services/dramaAssetSearch';

const base = { id: 'shared', name: '角色2', key: 'role2', summary: '', visualNotes: '', importance: 'main' as const,
  source: 'manual' as const, confirmed: true, createdAt: 1, updatedAt: 2 };

describe('创作资产搜索与排序', () => {
  it('全角和多个词跨人物别名、声音、动作匹配，不检索本地路径', () => {
    const character: DramaCharacter = { ...base, kind: 'character', identity: '作家', aliases: ['ＡＬＩＣＥ'],
      voiceClips: [{ id: 'voice', kind: 'timbre', transcript: '低沉', createdAt: 1, updatedAt: 2 }],
      actions: [{ id: 'action', category: 'standing', name: '站立', prompt: '挥手', createdAt: 1, updatedAt: 2 }],
      referenceImages: [{ id: 'ref', kind: 'primary', prompt: '', filePath: 'private-location.png', createdAt: 1, updatedAt: 2 }] };
    expect(matchesDramaAssetQuery(character, 'alice 低沉 挥手')).toBe(true);
    expect(matchesDramaAssetQuery(character, 'alice 未知')).toBe(false);
    expect(matchesDramaAssetQuery(character, 'private-location')).toBe(false);
  });

  it('匹配场景和道具专属字段及参考图标题', () => {
    const scene: DramaScene = { ...base, kind: 'scene', placeType: '室内', timeOfDay: '夜晚', atmosphere: '安静',
      referenceImages: [{ id: 'ref', label: '窗边', prompt: '侧面', createdAt: 1, updatedAt: 2 }] };
    expect(matchesDramaAssetQuery(scene, '夜晚 窗边 侧面')).toBe(true);
    expect(matchesDramaAssetQuery({ ...base, kind: 'prop', ownerName: '小绘', category: '电子设备' }, '小绘 电子')).toBe(true);
  });

  it('按数字名称、时间和方向排序，不改源数组，同ID跨分类仍独立', () => {
    const assets: DramaAsset[] = [{ ...base, kind: 'scene', name: '角色10', createdAt: 8 },
      { ...base, kind: 'character', identity: '' }];
    expect(sortDramaAssets(assets, 'name', 'asc').map((asset) => asset.name)).toEqual(['角色2', '角色10']);
    expect(sortDramaAssets(assets, 'createdAt', 'desc')[0].createdAt).toBe(8);
    expect(assets[0].name).toBe('角色10');
    expect(new Set(assets.map(dramaAssetIdentityKey)).size).toBe(2);
  });
});
