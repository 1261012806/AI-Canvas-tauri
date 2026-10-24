import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramaAsset, DramaCharacter, DramaScene } from '../../src/types/dramaAssets';

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.resetModules(); });

const imageUrl = 'asset://localhost/D%3A%2Fglobal%2Fimport%2Fimage.png';
const audioUrl = 'asset://localhost/D%3A%2Fglobal%2Fimport%2Fvoice.wav';
const videoUrl = 'asset://localhost/D%3A%2Fglobal%2Fimport%2Faction.mp4';

function scene(id = 'scene'): DramaScene {
  return { kind: 'scene', id, name: '场景', key: '场景', summary: '', visualNotes: '', importance: 'main',
    source: 'manual', confirmed: true, createdAt: 1, updatedAt: 1,
    imageUrl, imageAssetId: 'image-index', imageRelativePath: 'import/image.png' };
}

function character(): DramaCharacter {
  return { ...scene('character'), kind: 'character', identity: '', imageAssetId: undefined, imageRelativePath: undefined,
    libraryOrder: 100, primaryReferenceImageId: 'reference', avatarReferenceImageId: 'reference', primaryVoiceClipId: 'voice',
    referenceImages: [{ id: 'reference', kind: 'primary', imageUrl, assetId: 'image-index', relativePath: 'import/image.png', prompt: '', createdAt: 1, updatedAt: 1 }],
    voiceClips: [{ id: 'voice', kind: 'line', audioUrl, assetId: 'voice-index', relativePath: 'import/voice.wav', transcript: '', createdAt: 1, updatedAt: 1 }],
    actions: [{ id: 'action', category: 'walking', name: '动作', prompt: '', createdAt: 1, updatedAt: 1,
      media: [{ id: 'video', kind: 'video', name: '视频', url: videoUrl, assetId: 'video-index', relativePath: 'import/action.mp4', createdAt: 1, updatedAt: 1 }] }],
  };
}

async function seeded() {
  const db = await import('../../src/services/indexedDbService');
  for (const [assetId, name] of [['image-index', 'image.png'], ['voice-index', 'voice.wav'], ['video-index', 'action.mp4']]) {
    await db.putAssetIndex({ assetId, path: `D:/global/import/${name}`, relativePath: `import/${name}`, source: 'global',
      fingerprint: '1:1', size: 1, mtimeMs: 1, status: 'online', updatedAt: 1 });
  }
  return db;
}

describe('全局资产包原子追加', () => {
  it('两表同一批追加全部媒体元数据，原人物和场景道具保留且源顺序清空', async () => {
    const db = await seeded();
    await db.putGlobalDramaAsset({ ...scene('existing'), name: '原场景' });
    const assets: DramaAsset[] = [character(), scene(), { ...scene('prop'), kind: 'prop' }];
    const saved = await db.addImportedGlobalDramaAssets(assets);
    expect(saved).toHaveLength(3);
    const characters = await db.getAllGlobalCharacters();
    expect(characters[0].libraryOrder).toBeUndefined();
    expect(characters[0].voiceClips![0].assetId).toBe('voice-index');
    expect(characters[0].actions![0].media![0].assetId).toBe('video-index');
    expect((await db.getAllGlobalDramaAssets()).map((asset) => asset.id).sort()).toEqual(['existing', 'prop', 'scene']);
    expect(await db.getAssetIndexById('image-index')).toMatchObject({ source: 'global', path: 'D:/global/import/image.png' });
  });

  it('跨表身份冲突整批失败，不覆盖原卡片或保存其他新条目', async () => {
    const db = await seeded();
    await db.putGlobalDramaAsset({ ...scene('character'), name: '不可覆盖' });
    await expect(db.addImportedGlobalDramaAssets([character(), scene('new-scene')])).rejects.toThrow('身份已存在');
    expect(await db.getAllGlobalCharacters()).toEqual([]);
    expect(await db.getAllGlobalDramaAssets()).toEqual([expect.objectContaining({ id: 'character', name: '不可覆盖' })]);
  });

  it('项目身份、源节点、缺失或不匹配媒体索引均拒绝且不产生部分记录', async () => {
    const db = await seeded();
    await expect(db.addImportedGlobalDramaAssets([character(), { ...scene(), id: 'character' }])).rejects.toThrow('无效');
    const invalid: DramaAsset[] = [
      { ...scene(), assetId: 'project-index' }, { ...scene(), imageNodeId: 'source-node' },
      { ...scene(), imageAssetId: 'missing' }, { ...scene(), imageRelativePath: 'wrong.png' },
      { ...scene(), imageUrl: 'https://example.com/image.png' },
    ];
    for (const asset of invalid) await expect(db.addImportedGlobalDramaAssets([character(), asset])).rejects.toThrow('无效');
    const voiceWithNode = character(); voiceWithNode.voiceClips![0].sourceNodeId = 'audio-node';
    await expect(db.addImportedGlobalDramaAssets([voiceWithNode])).rejects.toThrow('无效');
    const actionWithPath = character(); actionWithPath.actions![0].media![0].filePath = 'D:/project/private.mp4';
    await expect(db.addImportedGlobalDramaAssets([actionWithPath])).rejects.toThrow('无效');
    await db.putAssetIndex({ assetId: 'image-index', path: 'D:/global/import/image.png', relativePath: 'import/image.png',
      projectId: 'project', source: 'project', fingerprint: '1:1', size: 1, mtimeMs: 1, status: 'online', updatedAt: 1 });
    await expect(db.addImportedGlobalDramaAssets([scene()])).rejects.toThrow('无效');
    expect(await db.getAllGlobalCharacters()).toEqual([]);
    expect(await db.getAllGlobalDramaAssets()).toEqual([]);
  });

  it('提交前取消或事务校验期间过期整批回滚', async () => {
    const db = await seeded(); const controller = new AbortController(); controller.abort();
    await expect(db.addImportedGlobalDramaAssets([character(), scene()], { signal: controller.signal })).rejects.toThrow('取消');
    let checks = 0;
    await expect(db.addImportedGlobalDramaAssets([character(), scene()], {
      assertCurrent: () => { if (++checks === 4) throw new Error('事务过期'); },
    })).rejects.toThrow('事务过期');
    expect(await db.getAllGlobalCharacters()).toEqual([]);
    expect(await db.getAllGlobalDramaAssets()).toEqual([]);
  });

  it('事务已经开始时取消仍原子中止两张表', async () => {
    const db = await seeded(); const controller = new AbortController(); let checks = 0;
    await expect(db.addImportedGlobalDramaAssets([character(), scene()], {
      signal: controller.signal,
      assertCurrent: () => { if (++checks === 4) controller.abort(); },
    })).rejects.toThrow('取消');
    expect(await db.getAllGlobalCharacters()).toEqual([]);
    expect(await db.getAllGlobalDramaAssets()).toEqual([]);
  });
});
