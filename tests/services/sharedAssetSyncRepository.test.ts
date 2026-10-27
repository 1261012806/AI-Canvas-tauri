import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedAssetMapping, SharedAssetOutboxEntry } from '../../src/types/assetSync';
import type { AssetImageRecord } from '../../src/types/assetImage';
import type { AssetIndexRecord, AssetMetaRecord } from '../../src/services/indexedDbService';
import type { SharedAssetSyncCommitInput } from '../../src/services/indexedDb/sharedAssetSyncRepository';

const scope = { ownerId: 'owner', connectionId: 'connection', connectionRevision: 'c1', libraryId: 'library', sharedProjectId: 'shared' };
const emptyLibrary = { version: 2 as const, characters: [], scenes: [], props: [] };
const oldIndex: AssetIndexRecord = { assetId: 'old-file', path: 'C:/project/old.png', relativePath: 'old.png', rootPath: 'C:/project',
  projectId: 'owner', source: 'project', fingerprint: '8:1', size: 8, mtimeMs: 1, status: 'online', updatedAt: 1 };
const newIndex: AssetIndexRecord = { ...oldIndex, assetId: 'new-file', path: 'C:/project/new.png', relativePath: 'new.png', fingerprint: '9:2', size: 9, mtimeMs: 2 };
const mapping = (): SharedAssetMapping => ({ ...scope, id: 'mapping', kind: 'file', localEntityId: 'logical-file', sharedAssetId: 'shared-file',
  members: [], media: [], acceptedRevisionId: 'r1', acceptedETag: 'e1', baselineDigest: 'before', currentFileAssetId: oldIndex.assetId, updatedAt: 1 });
const operation = (): SharedAssetOutboxEntry => ({ ...scope, id: 'pending', operationId: 'operation', sharedAssetId: 'shared-file', kind: 'file',
  direction: 'download', revisionId: 'r2', baseRevisionId: 'r1', baseETag: 'e1', mappingId: 'mapping', phase: 'applying', createdAt: 1, updatedAt: 1 });
const nextMapping = (): SharedAssetMapping => ({ ...mapping(), acceptedRevisionId: 'r2', acceptedETag: 'e2', baselineDigest: 'after',
  currentFileAssetId: newIndex.assetId, previousFileAssetIds: [oldIndex.assetId] });
const imageRecord = (): AssetImageRecord => ({ id: 'asset-image:old-file:digest', assetId: 'old-file', contentDigest: 'a'.repeat(64),
  fileName: 'old.png', prompt: '下载前保存的提示词', revision: 1, updatedAt: 1,
  references: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'].map((id) => ({
    id, name: id, relativePath: `asset-image-references/${id}.png`, digest: 'c'.repeat(64), bytes: 4,
  })) });

async function putRows(rows: Array<[string, unknown]>) {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([...new Set(rows.map(([store]) => store))], 'readwrite');
    for (const [store, value] of rows) tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  vi.resetModules();
});

async function read(store: string, key: string): Promise<unknown> {
  const { openDB } = await import('../../src/services/indexedDb/schema');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function seed() {
  await putRows([
    ['projects', { id: 'owner', name: '项目', createdAt: 1, updatedAt: 1, nodes: [], edges: [], dramaAssets: emptyLibrary }],
    ['projectSummaries', { id: 'owner', name: '项目', createdAt: 1, updatedAt: 1 }],
    ['assetIndex', oldIndex], ['sharedAssetMappings', mapping()], ['sharedAssetOutbox', operation()],
  ]);
}
function commit(): SharedAssetSyncCommitInput {
  return { ownerId: 'owner', operationId: 'operation', operation: operation(), mappings: [nextMapping()],
    indexes: [newIndex], expectedIndexes: [oldIndex], expectedProjectLibrary: emptyLibrary,
    project: { id: 'owner', name: '项目', createdAt: 1, updatedAt: 2, nodes: [], edges: [], dramaAssets: { ...emptyLibrary, lastViewedAt: 2 } } };
}

describe('共享资产下载原子提交', () => {
  it('v25 同步数据迁移为 legacy，不同代次可以保留同一素材映射', async () => {
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ai-canvas-db', 25);
      request.onupgradeneeded = () => {
        const mappings = request.result.createObjectStore('sharedAssetMappings', { keyPath: 'id' });
        const scopeKeys = ['ownerId', 'connectionId', 'connectionRevision', 'libraryId', 'sharedProjectId'];
        mappings.createIndex('localIdentity', [...scopeKeys, 'kind', 'localEntityId'], { unique: true });
        mappings.createIndex('sharedIdentity', [...scopeKeys, 'sharedAssetId'], { unique: true });
        request.result.createObjectStore('sharedAssetOutbox', { keyPath: 'id' });
        request.result.createObjectStore('sharedAssetConflicts', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = oldDb.transaction(['sharedAssetMappings', 'sharedAssetOutbox', 'sharedAssetConflicts'], 'readwrite');
      tx.objectStore('sharedAssetMappings').put(mapping());
      tx.objectStore('sharedAssetOutbox').put(operation());
      tx.objectStore('sharedAssetConflicts').put({ ...scope, id: 'conflict', sharedAssetId: 'shared-file', kind: 'file', reason: 'headChanged', createdAt: 1 });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    oldDb.close();
    const { loadSharedAssetSyncState, putSharedAssetSyncPlan } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    const migrated = await loadSharedAssetSyncState('owner');
    expect(migrated.mappings[0]).toMatchObject({ id: 'mapping', generation: 'legacy', acceptedRevisionId: 'r1' });
    expect(migrated.outbox[0]).toMatchObject({ operationId: 'operation', generation: 'legacy', phase: 'applying' });
    expect(migrated.conflicts[0]).toMatchObject({ id: 'conflict', generation: 'legacy' });
    await putSharedAssetSyncPlan({ ownerId: 'owner', mappings: [{ ...mapping(), id: 'new-mapping', generation: 'new-generation' }], outbox: [] });
    expect((await loadSharedAssetSyncState('owner')).mappings).toHaveLength(2);
    await expect(putSharedAssetSyncPlan({ ownerId: 'owner', mappings: [{ ...mapping(), id: 'duplicate', generation: 'new-generation' }], outbox: [] })).rejects.toBeDefined();
    expect((await loadSharedAssetSyncState('owner')).mappings).toHaveLength(2);
  });

  it('旧库同代身份冲突时升级回滚，保留原记录', async () => {
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ai-canvas-db', 25);
      request.onupgradeneeded = () => {
        for (const name of ['sharedAssetMappings', 'sharedAssetOutbox', 'sharedAssetConflicts']) request.result.createObjectStore(name, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = oldDb.transaction('sharedAssetMappings', 'readwrite');
      tx.objectStore('sharedAssetMappings').put(mapping());
      tx.objectStore('sharedAssetMappings').put({ ...mapping(), id: 'duplicate' });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    oldDb.close();
    const { openDB } = await import('../../src/services/indexedDb/schema');
    await expect(openDB()).rejects.toBeDefined();
    const retained = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ai-canvas-db');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(retained.version).toBe(25);
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const request = retained.transaction('sharedAssetMappings').objectStore('sharedAssetMappings').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(records).toHaveLength(2);
    expect(records).toEqual(expect.arrayContaining([mapping(), { ...mapping(), id: 'duplicate' }]));
    retained.close();
  });

  it('v23 数据库原地增加三张同步表，保留已有项目', async () => {
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ai-canvas-db', 23);
      request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = oldDb.transaction('projects', 'readwrite');
      tx.objectStore('projects').put({ id: 'legacy', name: '旧项目', nodes: [], edges: [] });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    oldDb.close();
    const { openDB, DB_VERSION } = await import('../../src/services/indexedDb/schema');
    const db = await openDB();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(['sharedAssetMappings', 'sharedAssetOutbox', 'sharedAssetConflicts']));
    expect(await read('projects', 'legacy')).toMatchObject({ name: '旧项目' });
  });

  it('同事务提交项目、索引、标签、图片信息和基线，保留旧文件身份', async () => {
    await seed();
    const { applySharedAssetSyncCommit, loadSharedAssetSyncState } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    const projected = vi.fn();
    await applySharedAssetSyncCommit({ ...commit(), onCommitted: projected,
      tags: [{ assetId: 'new-file', expected: null, next: { assetId: 'new-file', tags: ['人物'], updatedAt: 2 } }],
      images: [{ expected: null, next: { id: 'asset-image:new-file:digest', assetId: 'new-file', contentDigest: 'a'.repeat(64),
        fileName: 'new.png', prompt: '明确保存的提示词', references: [], revision: 1, updatedAt: 2 } }],
    });
    expect(projected).toHaveBeenCalledExactlyOnceWith({ alreadyApplied: false });
    expect(await read('assetIndex', 'old-file')).toEqual(oldIndex);
    expect(await read('assetIndex', 'new-file')).toEqual(newIndex);
    expect(await read('assetMetaV2', 'new-file')).toMatchObject({ tags: ['人物'] });
    expect(await read('metadata', 'asset-image:new-file:digest')).toMatchObject({ prompt: '明确保存的提示词' });
    expect(await read('projects', 'owner')).toMatchObject({ dramaAssets: { lastViewedAt: 2 } });
    expect(await read('projectSummaries', 'owner')).toMatchObject({ updatedAt: 2 });
    expect((await loadSharedAssetSyncState('owner')).outbox[0].phase).toBe('applied');
  });

  it('同步期间本地标签变化会撤销整批，不提前更新项目或基线', async () => {
    await seed();
    const tags: AssetMetaRecord = { assetId: 'new-file', tags: ['本地新标签'], updatedAt: 3 };
    await putRows([['assetMetaV2', tags]]);
    const { applySharedAssetSyncCommit } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    await expect(applySharedAssetSyncCommit({ ...commit(), tags: [{ assetId: 'new-file', expected: null,
      next: { assetId: 'new-file', tags: ['云端标签'], updatedAt: 2 } }] })).rejects.toThrow('已变化');
    expect(await read('assetIndex', 'new-file')).toBeUndefined();
    expect(await read('projects', 'owner')).toMatchObject({ updatedAt: 1 });
    expect(await read('sharedAssetMappings', 'mapping')).toEqual(mapping());
    expect(await read('assetMetaV2', 'new-file')).toEqual(tags);
  });

  it('IDB 已成功但原生确认丢失时，同一操作重放不造新身份或重复覆盖', async () => {
    await seed();
    const { applySharedAssetSyncCommit } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    await applySharedAssetSyncCommit(commit());
    const projected = vi.fn();
    await expect(applySharedAssetSyncCommit({ ...commit(), onCommitted: projected,
      indexes: [{ ...newIndex, assetId: 'unwanted-third-file', path: 'C:/project/third.png' }] })).resolves.toEqual({ alreadyApplied: true });
    expect(await read('assetIndex', 'unwanted-third-file')).toBeUndefined();
    expect(await read('assetIndex', 'new-file')).toEqual(newIndex);
  });

  it.each(['提示词', '参考图顺序'] as const)('旧文件的%s在下载期间改变时撤销新版应用', async (field) => {
    await seed();
    const before = imageRecord();
    const edited = field === '提示词' ? { ...before, prompt: '用户刚改的提示词' }
      : { ...before, references: [...before.references].reverse() };
    await putRows([['metadata', edited]]);
    const { applySharedAssetSyncCommit } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    await expect(applySharedAssetSyncCommit({ ...commit(), expectedImages: [before], images: [{ expected: null,
      next: { ...before, id: 'asset-image:new-file:digest', assetId: 'new-file', contentDigest: 'b'.repeat(64) } }] })).rejects.toThrow('已变化');
    expect(await read('metadata', before.id)).toEqual(edited);
    expect(await read('metadata', 'asset-image:new-file:digest')).toBeUndefined();
    expect(await read('assetIndex', 'new-file')).toBeUndefined();
    expect(await read('sharedAssetMappings', 'mapping')).toEqual(mapping());
  });

  it('旧图片信息基线一致时创建新版记录，保留旧记录和旧文件索引', async () => {
    await seed();
    const before = imageRecord();
    await putRows([['metadata', before]]);
    const { applySharedAssetSyncCommit } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    const next = { ...before, id: 'asset-image:new-file:digest', assetId: 'new-file', contentDigest: 'b'.repeat(64), prompt: '云端新版提示词' };
    await applySharedAssetSyncCommit({ ...commit(), expectedImages: [before], images: [{ expected: null, next }] });
    expect(await read('metadata', before.id)).toEqual(before);
    expect(await read('metadata', next.id)).toEqual(next);
    expect(await read('assetIndex', 'old-file')).toEqual(oldIndex);
  });

  it('预览时无图片专属记录、下载期间新增记录时拒绝整批应用', async () => {
    await seed();
    const added = imageRecord();
    await putRows([['metadata', added]]);
    const { applySharedAssetSyncCommit } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    await expect(applySharedAssetSyncCommit({ ...commit(), expectedImageRecords: [{ assetId: 'old-file', records: [] }] })).rejects.toThrow('已变化');
    expect(await read('metadata', added.id)).toEqual(added);
    expect(await read('assetIndex', 'new-file')).toBeUndefined();
    expect(await read('sharedAssetOutbox', 'pending')).toMatchObject({ phase: 'applying' });
  });

  it('保护同一文件的全部旧内容记录，不能漏掉非当前摘要记录的修改', async () => {
    await seed();
    const first = imageRecord();
    const second = { ...first, id: 'asset-image:old-file:previous-digest', contentDigest: 'b'.repeat(64), prompt: '旧内容的专属说明' };
    await putRows([['metadata', first], ['metadata', { ...second, prompt: '用户修订的旧内容说明' }]]);
    const { applySharedAssetSyncCommit } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    await expect(applySharedAssetSyncCommit({ ...commit(), expectedImageRecords: [{ assetId: 'old-file', records: [first, second] }] })).rejects.toThrow('已变化');
    expect(await read('assetIndex', 'new-file')).toBeUndefined();
    expect(await read('sharedAssetMappings', 'mapping')).toEqual(mapping());
  });

  it('先完成图片集合基线检查，再写入本事务的新图片记录', async () => {
    await seed();
    await putRows(Array.from({ length: 12 }, (_, index): [string, unknown] => ['metadata', {
      ...imageRecord(), id: `asset-image:a-unrelated-${index.toString().padStart(2, '0')}`, assetId: 'unrelated-file',
    }]));
    const next = { ...imageRecord(), id: 'asset-image:new-file:digest', assetId: 'new-file', contentDigest: 'b'.repeat(64) };
    const { applySharedAssetSyncCommit } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    await applySharedAssetSyncCommit({ ...commit(), expectedImageRecords: [{ assetId: 'old-file', records: [] }, { assetId: 'new-file', records: [] }],
      images: [{ expected: null, next }] });
    expect(await read('metadata', next.id)).toEqual(next);
    expect(await read('sharedAssetOutbox', 'pending')).toMatchObject({ phase: 'applied' });
  });

  it('禁止把已有文件身份重指向新版文件', async () => {
    await seed();
    const { applySharedAssetSyncCommit } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    await expect(applySharedAssetSyncCommit({ ...commit(), indexes: [{ ...newIndex, assetId: 'old-file' }] })).rejects.toThrow('已变化');
    expect(await read('assetIndex', 'old-file')).toEqual(oldIndex);
    expect(await read('sharedAssetOutbox', 'pending')).toMatchObject({ phase: 'applying' });
  });

  it('既有清理墓碑会阻止迟到下载复活失效身份', async () => {
    await seed();
    await putRows([['metadata', { id: 'forgotten-missing-asset:old-file', forgottenAt: 2 }]]);
    const { applySharedAssetSyncCommit } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    await expect(applySharedAssetSyncCommit(commit())).rejects.toThrow('清理');
    expect(await read('assetIndex', 'new-file')).toBeUndefined();
  });

  it('下载材料涉及已迁移路径时失败关闭，不与旧路径迁移竞争', async () => {
    await seed();
    await putRows([['metadata', { id: 'media-relocations', pending: [], moves: [{ oldPath: newIndex.path,
      newPath: 'C:/project/moved.png', relativePath: 'moved.png', assetUrl: 'asset://moved.png', projectId: 'owner' }] }]]);
    const { applySharedAssetSyncCommit } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    await expect(applySharedAssetSyncCommit(commit())).rejects.toThrow('已变化');
    expect(await read('assetIndex', 'new-file')).toBeUndefined();
    expect(await read('sharedAssetOutbox', 'pending')).toMatchObject({ phase: 'applying' });
  });

  it('发布候选的固定版本和基线不能被恢复补丁改变', async () => {
    await seed();
    const { patchSharedAssetSyncOperation, putSharedAssetSyncPlan } = await import('../../src/services/indexedDb/sharedAssetSyncRepository');
    await patchSharedAssetSyncOperation('operation', { phase: 'paused' });
    await expect(putSharedAssetSyncPlan({ ownerId: 'owner', mappings: [], outbox: [{ ...operation(), revisionId: 'new-retry-version' }] })).rejects.toThrow('已变化');
    expect(await read('sharedAssetOutbox', 'pending')).toMatchObject({ revisionId: 'r2', baseRevisionId: 'r1', phase: 'paused' });
  });
});
