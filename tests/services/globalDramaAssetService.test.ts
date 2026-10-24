import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramaCharacter, DramaScene } from '../../src/types/dramaAssets';

const files = vi.hoisted(() => ({
  tauri: false,
  saveAssetToPermanent: vi.fn(async () => 'D:/global/scene.png'),
  getGlobalFilesDir: vi.fn(async () => 'D:/global'),
  identifyAsset: vi.fn(async () => ({ assetId: 'global-image', relativePath: 'scene.png' })),
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://localhost/${encodeURIComponent(path)}`),
  resolveIndexedAssetPath: vi.fn(async () => null),
}));

vi.mock('../../src/services/fileService', () => ({
  ...files, isTauriEnv: () => files.tauri, sanitizeFileName: (name: string) => name,
}));

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  vi.clearAllMocks();
  files.tauri = false;
  files.saveAssetToPermanent.mockImplementation(async () => 'D:/global/scene.png');
});

function scene(overrides: Partial<DramaScene> = {}): DramaScene {
  return {
    id: 'scene-1', kind: 'scene', name: '客厅', key: '客厅', summary: '', visualNotes: '',
    source: 'manual', importance: 'main', confirmed: true, createdAt: 1, updatedAt: 2, ...overrides,
  };
}

describe('全局创作资产持久化', () => {
  it('沿用旧角色表，场景道具分别加载且删除卡片保留媒体身份', async () => {
    const db = await import('../../src/services/indexedDbService');
    const service = await import('../../src/services/globalDramaAssetService');
    const character: DramaCharacter = { ...scene(), id: 'character-1', kind: 'character', identity: '', referenceImages: undefined };
    await service.saveGlobalDramaAssetCard(character);
    await service.saveGlobalDramaAssetCard(scene());
    await service.saveGlobalDramaAssetCard({ ...scene(), id: 'prop-1', kind: 'prop' });
    expect((await db.getAllGlobalCharacters()).map((asset) => asset.id)).toEqual(['character-1']);
    expect((await db.getAllGlobalDramaAssets()).map((asset) => asset.id).sort()).toEqual(['prop-1', 'scene-1']);
    expect((await service.loadGlobalDramaAssetCards()).map((asset) => asset.id).sort())
      .toEqual(['character-1', 'prop-1', 'scene-1']);
    await db.putAssetIndex({ assetId: 'keep', path: 'D:/global/a.png', source: 'global', fingerprint: '1:1', size: 1, mtimeMs: 1, status: 'online', updatedAt: 1 });
    await service.deleteGlobalDramaAssetCard('scene', 'scene-1');
    expect(await db.getAssetIndexById('keep')).toBeDefined();
    expect((await service.loadGlobalDramaAssetCards()).map((asset) => asset.id).sort()).toEqual(['character-1', 'prop-1']);
  });

  it('先复制主图后存稳定身份，并剥离节点和临时路径', async () => {
    files.tauri = true;
    const service = await import('../../src/services/globalDramaAssetService');
    const input = { ...scene(), imageNodeId: 'project-node', imageUrl: 'asset://localhost/D%3A%2Fproject%2Fscene.png', filePath: 'D:/project/scene.png' };
    const saved = await service.saveGlobalDramaAssetCard(input);
    expect(files.saveAssetToPermanent).toHaveBeenCalledWith(expect.objectContaining({ path: 'D:/project/scene.png' }));
    expect(saved).toMatchObject({ imageAssetId: 'global-image', imageRelativePath: 'scene.png' });
    expect(saved.referenceImages?.[0]).toMatchObject({ assetId: 'global-image', assetSource: 'global', relativePath: 'scene.png' });
    expect(saved).not.toHaveProperty('imageNodeId');
    expect(saved).not.toHaveProperty('filePath');
  });

  it('复制中取消不新增元数据，也不覆盖旧卡片', async () => {
    const service = await import('../../src/services/globalDramaAssetService');
    const db = await import('../../src/services/indexedDbService');
    await service.saveGlobalDramaAssetCard(scene());
    files.tauri = true;
    const controller = new AbortController();
    files.saveAssetToPermanent.mockImplementationOnce(async () => { controller.abort(); return 'D:/global/scene.png'; });
    await expect(service.saveGlobalDramaAssetCard(scene({ name: '不应保存', imageUrl: 'data:image/png;base64,AA==' }), { signal: controller.signal }))
      .rejects.toThrow('取消');
    expect((await db.getAllGlobalDramaAssets())[0].name).toBe('客厅');
    await expect(db.putGlobalDramaAsset(scene({ id: 'late' }), { assertCurrent: () => { throw new Error('过期'); } }))
      .rejects.toThrow('过期');
    expect(await db.getAllGlobalDramaAssets()).toHaveLength(1);
    let writeChecks = 0;
    await expect(db.putGlobalDramaAsset(scene({ id: 'late-transaction' }), {
      assertCurrent: () => { if (++writeChecks >= 3) throw new Error('事务等待期间过期'); },
    })).rejects.toThrow('过期');
    expect(await db.getAllGlobalDramaAssets()).toHaveLength(1);
    let deleteChecks = 0;
    await expect(service.deleteGlobalDramaAssetCard('scene', 'scene-1', {
      assertCurrent: () => { if (++deleteChecks >= 4) throw new Error('删除等待期间取消'); },
    })).rejects.toThrow('取消');
    expect(await db.getAllGlobalDramaAssets()).toHaveLength(1);
  });

  it('主图身份缺失或离线时不返回旧URL作为可用图片', async () => {
    const db = await import('../../src/services/indexedDbService');
    const service = await import('../../src/services/globalDramaAssetService');
    await db.putGlobalDramaAsset(scene({ imageAssetId: 'missing', imageUrl: 'asset://localhost/old.png' }));
    expect((await service.loadGlobalDramaAssetCards())[0]).toMatchObject({ imageAssetId: 'missing', imageUrl: undefined });
    await db.putAssetIndex({ assetId: 'missing', path: 'D:/global/old.png', source: 'global', fingerprint: '1:1', size: 1, mtimeMs: 1, status: 'offline', updatedAt: 1 });
    expect((await service.loadGlobalDramaAssetCards())[0].imageUrl).toBeUndefined();
  });

  it('升级只新增场景道具表，旧全局角色ID保持不变', async () => {
    const previous = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ai-canvas-db', 22);
      request.onupgradeneeded = () => request.result.createObjectStore('globalCharacters', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve) => {
      const tx = previous.transaction('globalCharacters', 'readwrite');
      tx.objectStore('globalCharacters').put({ ...scene(), id: 'old-character', kind: 'character', identity: '' });
      tx.oncomplete = () => resolve();
    });
    previous.close();
    const schema = await import('../../src/services/indexedDb/schema');
    const upgraded = await schema.openDB();
    expect(upgraded.version).toBe(23);
    expect(upgraded.objectStoreNames.contains('globalDramaAssets')).toBe(true);
    const db = await import('../../src/services/indexedDbService');
    expect((await db.getAllGlobalCharacters())[0].id).toBe('old-character');
    expect(await db.getAllGlobalDramaAssets()).toEqual([]);
  });
});
