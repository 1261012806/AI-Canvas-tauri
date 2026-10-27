import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetIndexRecord } from '../../src/services/indexedDbService';
import type { DramaAssetLibrary, DramaCharacter } from '../../src/types/dramaAssets';
import type { SharedAssetSyncLocalState, SharedSyncDownloadInput, SharedSyncPrepareInput, SharedSyncRemoteAsset } from '../../src/types/assetSync';
import type { SharedAssetSyncCommitInput } from '../../src/services/indexedDb/sharedAssetSyncRepository';
import type { AssetImageRecord } from '../../src/types/assetImage';

const mocks = vi.hoisted(() => ({
  repo: { mappings: [], outbox: [], conflicts: [] } as SharedAssetSyncLocalState,
  indexes: new Map<string, AssetIndexRecord>(), cloud: [] as SharedSyncRemoteAsset[],
  roots: new Map<string, string>(),
  imageRecords: [] as AssetImageRecord[],
  changedPaths: new Set<string>(),
  prepare: vi.fn(), publish: vi.fn(), recover: vi.fn(), download: vi.fn(), acknowledge: vi.fn(),
  scan: vi.fn(), list: vi.fn(), listHeads: vi.fn(), copy: vi.fn(), image: vi.fn(), prepareImage: vi.fn(), putPlan: vi.fn(), patch: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => true), mkdir: vi.fn(async () => undefined), remove: vi.fn(async () => undefined),
  lstat: vi.fn(async (path: string) => ({ isFile: /\.(?:png|wav|mp4)$/.test(path),
    isDirectory: !/\.(?:png|wav|mp4)$/.test(path), isSymlink: false, size: 10, mtime: new Date(mocks.changedPaths.has(path) ? 20 : 10) })),
}));
vi.mock('../../src/services/fs/core', () => ({
  getProjectDataDir: vi.fn(async (projectId: string) => mocks.roots.get(projectId)),
  joinPath: (...parts: string[]) => parts.join('/'), stripVerbatimPrefix: (value: string) => value,
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://localhost${path}`),
  getFileCategory: (name: string) => name.endsWith('.wav') ? 'audio' : name.endsWith('.mp4') ? 'video' : 'image',
}));
vi.mock('../../src/services/fs/assetIndex', () => ({
  getRelativeAssetPath: (path: string, root: string) => path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined,
}));
vi.mock('../../src/services/fileService', () => ({ listProjectFiles: mocks.list, copyAssetFileToFolder: mocks.copy }));
vi.mock('../../src/services/fs/assetLibrary', () => ({ scanDirectoryFiles: mocks.scan }));
vi.mock('../../src/services/fs/assetImageMetadata', () => ({ readSharedAssetImageMetadata: mocks.image,
  prepareSharedAssetImageMetadata: mocks.prepareImage }));
vi.mock('../../src/services/indexedDbService', () => ({
  getAllProjects: vi.fn(async () => [{ id: 'owner' }, { id: 'episode', parentId: 'owner' }]),
  getAssetIndexById: vi.fn(async (id: string) => mocks.indexes.get(id)),
  getAllAssetMeta: vi.fn(async () => []), getAssetMetaById: vi.fn(async () => undefined),
  getAssetImageRecords: vi.fn(async () => structuredClone(mocks.imageRecords)),
}));
vi.mock('../../src/services/indexedDb/sharedAssetSyncRepository', () => ({
  loadSharedAssetSyncState: vi.fn(async () => structuredClone(mocks.repo)),
  putSharedAssetSyncPlan: mocks.putPlan, patchSharedAssetSyncOperation: mocks.patch,
}));
vi.mock('../../src/services/fs/sharedAssetStorage', () => ({
  listSharedAssetHeads: mocks.listHeads,
  prepareSharedAssetPublish: mocks.prepare, publishSharedAssetRevision: mocks.publish,
  recoverSharedAssetOperation: mocks.recover, downloadSharedAssetRevision: mocks.download,
  acknowledgeSharedAssetApply: mocks.acknowledge,
}));

import { buildSharedAssetSyncPreview, executeSharedAssetSync, projectSharedFileView, sharedAssetSyncContentDigest,
  sharedAssetSyncExcludedPaths, projectAssetSyncService, type SharedAssetSyncContext } from '../../src/services/fs/sharedAssetSync';
import type { SharedAssetSyncExecution } from '../../src/services/fs/sharedAssetSync';

function character(): DramaCharacter {
  return { id: 'local-character', kind: 'character', name: '角色', key: '角色', identity: '身份', summary: '', visualNotes: '',
    importance: 'main', source: 'manual', confirmed: true, createdAt: 1, updatedAt: 2 };
}
function context(library?: DramaAssetLibrary): SharedAssetSyncContext {
  return { binding: { ownerId: 'owner', ownerName: '项目', connectionId: 'connection', connectionRevision: '1',
    libraryId: 'library', sharedProjectId: 'shared-project', projectPrefix: 'prefix', updatedAt: 1,
    capabilities: { checks: [], checkedAt: 1, cleanupPending: false, multiplayerWritable: true } },
    originProjectId: 'owner', projects: [{ id: 'owner' }], library: library ?? { version: 2, characters: [character()], scenes: [], props: [] },
    nodes: [], assertCurrent: vi.fn(), onStatus: vi.fn(), onTask: vi.fn() };
}
const prepared = new Map<string, { revision: SharedSyncRemoteAsset['revision']; revisionDigest: string }>();
const leaseToken = () => `${Date.now() + 120_000}.${'1'.repeat(64)}`;
function remoteFile(): SharedSyncRemoteAsset {
  return { etag: 'remote-etag', head: { sharedAssetId: 'remote-file', kind: 'file', revisionId: 'remote-revision',
    revisionDigest: 'd'.repeat(64), operationId: 'publisher-operation', updatedAt: 1 }, revision: {
    format: 'ai-canvas-shared-asset', version: 1, libraryId: 'library', sharedProjectId: 'shared-project', sharedAssetId: 'remote-file',
    revisionId: 'remote-revision', operationId: 'publisher-operation', createdAt: 1,
    payload: { kind: 'file', name: '共享.png', displayRelativePath: 'Library/共享.png', mediaId: 'image', tags: [] },
    media: [{ id: 'image', kind: 'image', extension: 'png', bytes: 10, sha256: 'a'.repeat(64) }] } };
}
function commitExecution(): SharedAssetSyncExecution & { applyDownload: ReturnType<typeof vi.fn> } {
  return { applyDownload: vi.fn(async ({ commit }: { commit: SharedAssetSyncCommitInput }) => {
    for (const mapping of commit.mappings) mocks.repo.mappings = [...mocks.repo.mappings.filter((row) => row.id !== mapping.id), structuredClone(mapping)];
    const operation = { ...structuredClone(commit.operation), phase: commit.operation.direction === 'download' ? 'applied' as const : 'completed' as const };
    mocks.repo.outbox = [...mocks.repo.outbox.filter((row) => row.id !== operation.id), operation];
    for (const index of commit.indexes ?? []) mocks.indexes.set(index.assetId, index);
    return { alreadyApplied: false };
  }) };
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.clearAllMocks(); prepared.clear(); mocks.repo = { mappings: [], outbox: [], conflicts: [] }; mocks.indexes.clear(); mocks.cloud = [];
  mocks.roots = new Map([['owner', '/project/owner'], ['episode', '/project/episode']]);
  mocks.imageRecords = [];
  mocks.changedPaths.clear();
  mocks.list.mockResolvedValue([]);
  mocks.listHeads.mockImplementation(async () => ({ assets: structuredClone(mocks.cloud), complete: true }));
  mocks.image.mockResolvedValue(null); mocks.acknowledge.mockResolvedValue(undefined);
  mocks.scan.mockResolvedValue({ files: [], folders: [], complete: true, truncated: false, failedDirectories: 0, failedFiles: 0 });
  mocks.copy.mockImplementation(async (source: string, directory: string) => ({ path: `${directory}/${source.split('/').at(-1)}`, totalBytes: 10, digest: 'a'.repeat(64) }));
  mocks.putPlan.mockImplementation(async (input: { mappings: SharedAssetSyncLocalState['mappings']; outbox: SharedAssetSyncLocalState['outbox']; conflicts?: SharedAssetSyncLocalState['conflicts'] }) => {
    for (const mapping of input.mappings) mocks.repo.mappings = [...mocks.repo.mappings.filter((row) => row.id !== mapping.id), structuredClone(mapping)];
    for (const operation of input.outbox) if (!mocks.repo.outbox.some((row) => row.id === operation.id)) mocks.repo.outbox.push(structuredClone(operation));
    mocks.repo.conflicts.push(...structuredClone(input.conflicts ?? []));
  });
  mocks.patch.mockImplementation(async (operationId: string, patch: object) => {
    const operation = mocks.repo.outbox.find((row) => row.operationId === operationId);
    if (!operation) throw new Error('未找到同步操作'); Object.assign(operation, patch); return structuredClone(operation);
  });
  mocks.prepare.mockImplementation(async (input: SharedSyncPrepareInput) => {
    // 真正副作用前必须已有固定操作；此断言可捕获先写文件再记录待办的倒序。
    expect(mocks.repo.outbox.some((row) => row.operationId === input.draft.operationId && row.draft)).toBe(true);
    const result = { revision: { ...structuredClone(input.draft), media: input.draft.media.map((entry) => ({ ...entry, sha256: 'a'.repeat(64), bytes: 10 })) },
      revisionDigest: 'd'.repeat(64) };
    prepared.set(input.draft.operationId, result); return result;
  });
  mocks.recover.mockImplementation(async (input: { operationId: string; sharedAssetId: string; revisionId: string }) => {
    const published = mocks.cloud.find((asset) => asset.head.sharedAssetId === input.sharedAssetId && asset.head.revisionId === input.revisionId);
    if (published) return { status: 'published', asset: structuredClone(published), applyToken: leaseToken() };
    return { status: 'retryable', prepared: prepared.get(input.operationId) };
  });
  mocks.publish.mockImplementation(async (input: { operationId: string }) => {
    const result = prepared.get(input.operationId)!;
    const asset: SharedSyncRemoteAsset = { revision: result.revision, etag: 'etag', head: {
      sharedAssetId: result.revision.sharedAssetId, revisionId: result.revision.revisionId,
      operationId: result.revision.operationId, revisionDigest: result.revisionDigest, kind: result.revision.payload.kind, updatedAt: 3 } };
    mocks.cloud = [...mocks.cloud.filter((entry) => entry.head.sharedAssetId !== asset.head.sharedAssetId), asset];
    return { status: 'published', asset, applyToken: leaseToken() };
  });
  mocks.download.mockImplementation(async (input: SharedSyncDownloadInput) => {
    const asset = mocks.cloud.find((entry) => entry.head.sharedAssetId === input.sharedAssetId && entry.head.revisionId === input.revisionId)!;
    return { status: 'ready', operationId: input.operationId, revision: asset.revision, revisionDigest: asset.head.revisionDigest,
      applyToken: leaseToken(), media: asset.revision.media.map((media) => ({ mediaId: media.id,
        relativePath: `.shared-sync/files/${input.sharedAssetId}/${input.revisionId}/${media.id}.${media.extension}`, bytes: media.bytes, sha256: media.sha256 })) };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('手动项目资产同步协调', () => {
  it('恢复预览仅读取原版本并释放本机令牌，不自动执行', async () => {
    const initial = await buildSharedAssetSyncPreview(context());
    await executeSharedAssetSync(initial, commitExecution());
    const operation = mocks.repo.outbox[0];
    operation.phase = 'paused'; operation.revision = undefined; operation.revisionDigest = undefined;
    mocks.acknowledge.mockClear(); mocks.publish.mockClear();
    const resumed = await buildSharedAssetSyncPreview(context());
    expect(resumed.operations.map((item) => item.operation.operationId)).toEqual([operation.operationId]);
    expect(mocks.acknowledge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: operation.operationId, applied: false }));
    expect(mocks.acknowledge.mock.calls[0][0]).not.toHaveProperty('releaseProjectLock');
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('预览持久化固定操作再准备原字节，用户执行前不上传，空数据可完成', async () => {
    const session = await buildSharedAssetSyncPreview(context());
    expect(session.items).toMatchObject([{ kind: 'character', direction: 'upload' }]);
    expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.publish).not.toHaveBeenCalled();
    expect(session.operations[0].operation.revisionId).toBe(mocks.repo.outbox[0].revisionId);
    const empty = context({ version: 2, characters: [], scenes: [], props: [] });
    mocks.repo = { mappings: [], outbox: [], conflicts: [] };
    await buildSharedAssetSyncPreview(empty);
    expect(empty.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'completed', total: 0 }));
  });

  it('完整扫描失败不把部分项目文件当完整同步成功', async () => {
    mocks.scan.mockResolvedValue({ files: [], complete: false, truncated: true, failedDirectories: 0, failedFiles: 0 });
    await expect(buildSharedAssetSyncPreview(context())).rejects.toThrow('读取不完整');
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('缺失或全局媒体只阻塞对应资产，不按名字或URL补造依赖', async () => {
    const value = context(); value.library.characters[0].imageUrl = 'https://private.example.com/image.png';
    const session = await buildSharedAssetSyncPreview(value);
    expect(session.items).toMatchObject([{ direction: 'blocked' }]); expect(session.operations).toHaveLength(0);
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
    expect(value.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'paused' }));
  });

  it('项目人物参考图/动作和文件专属提示词中的合法节点统一转共享库引用，不扩大媒体闭包', async () => {
    const index: AssetIndexRecord = { assetId: 'project-image', path: '/project/owner/image.png', relativePath: 'image.png',
      rootPath: '/project/owner', projectId: 'owner', source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 };
    mocks.indexes.set(index.assetId, index);
    mocks.scan.mockResolvedValue({ files: [{ assetId: index.assetId, name: 'image.png', path: index.path, relativePath: index.relativePath,
      category: 'image', source: 'project', size: 10 }], complete: true });
    const value = context(); const source = value.library.characters[0]; const imageUrl = `asset://localhost${index.path}`;
    source.assetId = index.assetId; source.imageUrl = imageUrl;
    source.referenceImages = [{ id: 'reference', kind: 'primary', assetId: index.assetId, imageUrl, sourceNodeId: 'project-node',
      prompt: '参考 @{project-node:项目图片}，保持原造型', createdAt: 1, updatedAt: 1 }];
    source.primaryReferenceImageId = 'reference';
    source.actions = [{ id: 'walk', category: 'walking', name: '行走', prompt: '让 @{project-node:项目图片} 向前走', media: [], createdAt: 1, updatedAt: 1 }];
    value.nodes = [{ id: 'project-node', type: 'source-image', position: { x: 0, y: 0 }, data: {
      label: '项目图片', type: 'source-image', status: 'success', prompt: '', role: 'source', imageUrl, filePath: index.path, assetId: index.assetId,
    } }];
    const record: AssetImageRecord = { id: 'asset-image:project-image:digest', assetId: index.assetId, contentDigest: 'a'.repeat(64),
      fileName: 'image.png', prompt: '以 @{project-node:项目图片} 为参考', references: [], revision: 1, updatedAt: 1 };
    mocks.imageRecords = [record]; mocks.image.mockResolvedValue({ record, references: [] });
    const session = await projectAssetSyncService.preview(value);
    expect(session.items.some((item) => item.direction === 'blocked')).toBe(false);
    const mapping = session.mappings.find((entry) => entry.kind === 'character')!;
    const referenceId = mapping.members.find((entry) => entry.kind === 'referenceImage' && entry.localId === 'reference')!.sharedId;
    const wireMention = `@drama{${mapping.sharedAssetId}#${referenceId}:角色}`;
    const preparedInputs = mocks.prepare.mock.calls.map(([input]) => input as SharedSyncPrepareInput);
    const card = preparedInputs.find((input) => input.draft.payload.kind === 'character')!.draft.payload;
    const file = preparedInputs.find((input) => input.draft.payload.kind === 'file')!.draft.payload;
    if (card.kind === 'file' || card.data.kind !== 'character' || file.kind !== 'file') throw new Error('缺少项目共享预览');
    expect(card.data.referenceImages![0].prompt).toBe(`参考 ${wireMention}，保持原造型`);
    expect(card.data.actions![0].prompt).toBe(`让 ${wireMention} 向前走`);
    expect(file.imageMetadata?.prompt).toBe(`以 ${wireMention} 为参考`);
    expect(preparedInputs.every((input) => input.sources.length === 1 && input.sources[0].filePath === index.path)).toBe(true);
    expect(source.referenceImages[0].prompt).toBe('参考 @{project-node:项目图片}，保持原造型');
    expect(record.prompt).toBe('以 @{project-node:项目图片} 为参考');
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('规范业务摘要忽略封套、属性顺序及创建/修改时间，保留媒体内容与参考顺序', async () => {
    const session = await buildSharedAssetSyncPreview(context()); const first = session.operations[0].operation.revision!;
    const second = structuredClone(first); second.createdAt = 999; second.operationId = 'other-operation';
    second.revisionId = 'other-revision';
    if (second.payload.kind !== 'file') second.payload.data.updatedAt = 999;
    expect(await sharedAssetSyncContentDigest(first)).toBe(await sharedAssetSyncContentDigest(second));
    if (second.payload.kind !== 'file') second.payload.data.summary = '实际修改';
    expect(await sharedAssetSyncContentDigest(first)).not.toBe(await sharedAssetSyncContentDigest(second));
  });

  it('未修改版本清理prepared暂存，不新增远端版本，全部未变显示完成', async () => {
    await executeSharedAssetSync(await buildSharedAssetSyncPreview(context()), commitExecution());
    const next = context(); const session = await buildSharedAssetSyncPreview(next);
    expect(session.items).toMatchObject([{ direction: 'unchanged' }]); expect(session.operations).toHaveLength(0);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ applied: false }));
    expect(next.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'completed' }));
  });

  it('本地和远端同时修改保留候选并报告冲突，不自动覆盖', async () => {
    await executeSharedAssetSync(await buildSharedAssetSyncPreview(context()), commitExecution());
    const remote = structuredClone(mocks.cloud[0]);
    remote.head.revisionId = 'remote-new'; remote.revision.revisionId = 'remote-new';
    if (remote.revision.payload.kind !== 'file') remote.revision.payload.data.summary = '云端修改';
    mocks.cloud = [remote]; const next = context(); next.library.characters[0].summary = '本地修改';
    const session = await buildSharedAssetSyncPreview(next);
    expect(session.items).toMatchObject([{ direction: 'conflict' }]); expect(session.operations).toHaveLength(0);
    expect(mocks.repo.conflicts).toMatchObject([{ reason: 'bothChanged' }]);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it('提交后上传ack失败只恢复ack，不重新发布或重复接受基线', async () => {
    const session = await buildSharedAssetSyncPreview(context()); const execution = commitExecution(); let fail = true;
    mocks.acknowledge.mockImplementation(async (input: { applied: boolean }) => { if (input.applied && fail) { fail = false; throw new Error('网络失败'); } });
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('网络失败');
    expect(mocks.repo.outbox[0]).toMatchObject({ phase: 'completed', errorCode: 'ack_pending' });
    const firstAck = mocks.acknowledge.mock.calls[0][0] as { operationId: string; applyToken: string };
    expect(mocks.acknowledge).toHaveBeenNthCalledWith(2, expect.objectContaining({ applied: false,
      operationId: firstAck.operationId, applyToken: firstAck.applyToken }));
    expect(mocks.acknowledge.mock.calls[1][0]).not.toHaveProperty('releaseProjectLock');
    await executeSharedAssetSync(session, execution);
    expect(mocks.publish).toHaveBeenCalledTimes(1); expect(execution.applyDownload).toHaveBeenCalledTimes(1);
    expect(mocks.repo.outbox[0].errorCode).toBeUndefined();
  });

  it('本地提交和仅回执恢复连续失败均释放同一租约，两次恢复不重复publish或commit', async () => {
    const session = await buildSharedAssetSyncPreview(context()); const execution = commitExecution();
    const operationId = session.operations[0].operation.operationId; const revisionId = session.operations[0].operation.revisionId;
    const publish = mocks.publish.getMockImplementation()!; const recover = mocks.recover.getMockImplementation()!;
    let activeToken: string | undefined; let failures = 2;
    mocks.publish.mockImplementation(async (...args: unknown[]) => {
      const result = await publish(...args); activeToken = result.applyToken; return result;
    });
    mocks.recover.mockImplementation(async (...args: unknown[]) => {
      if (activeToken) throw new Error('该项目仍有未释放的应用租约');
      const result = await recover(...args); activeToken = result.applyToken; return result;
    });
    mocks.acknowledge.mockImplementation(async (input: { applied: boolean; applyToken?: string }) => {
      if (!activeToken || input.applyToken !== activeToken) throw new Error('应用租约不匹配');
      if (input.applied && failures-- > 0) throw new Error('回执响应丢失');
      activeToken = undefined;
    });
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('回执响应丢失');
    expect(activeToken).toBeUndefined();
    const firstRecovery = await buildSharedAssetSyncPreview(context());
    await expect(executeSharedAssetSync(firstRecovery, execution)).rejects.toThrow('回执响应丢失');
    expect(activeToken).toBeUndefined();
    const secondRecovery = await buildSharedAssetSyncPreview(context());
    await executeSharedAssetSync(secondRecovery, execution);
    expect(mocks.repo.outbox).toHaveLength(1);
    expect(mocks.repo.outbox[0]).toMatchObject({ operationId, revisionId, phase: 'completed' });
    expect(mocks.repo.outbox[0].errorCode).toBeUndefined();
    expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(execution.applyDownload).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledge.mock.calls.filter(([input]) => input.applied === false)).toHaveLength(2);
  });

  it('ack已在原生成功但响应丢失时，释放失败不覆盖原错误或清掉回执待确认状态', async () => {
    const session = await buildSharedAssetSyncPreview(context()); const execution = commitExecution(); let lostResponse = true;
    mocks.acknowledge.mockImplementation(async (input: { applied: boolean }) => {
      if (!input.applied) throw new Error('原生已清除此租约');
      if (lostResponse) { lostResponse = false; throw new Error('回执响应丢失'); }
    });
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('回执响应丢失');
    expect(mocks.repo.outbox[0]).toMatchObject({ phase: 'completed', errorCode: 'ack_pending' });
    const resumed = await buildSharedAssetSyncPreview(context()); await executeSharedAssetSync(resumed, execution);
    expect(execution.applyDownload).toHaveBeenCalledTimes(1); expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.repo.outbox[0].errorCode).toBeUndefined();
  });

  it('publish结果不确定后，两轮恢复只核对原operation和revision，不创建新版本或盲重投', async () => {
    const session = await buildSharedAssetSyncPreview(context()); const execution = commitExecution();
    const operationId = session.operations[0].operation.operationId; const revisionId = session.operations[0].operation.revisionId;
    mocks.publish.mockResolvedValue({ status: 'uncertain' });
    mocks.recover.mockImplementation(async (input: { operationId: string }) => ({
      status: mocks.publish.mock.calls.length ? 'uncertain' : 'retryable', prepared: prepared.get(input.operationId),
    }));
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('版本提交结果尚未确认');
    for (let round = 0; round < 2; round++) {
      const value = context(); value.library.characters[0].summary = `后续本地编辑${round}`;
      const resumed = await buildSharedAssetSyncPreview(value);
      expect(resumed.operations[0].operation).toMatchObject({ operationId, revisionId, phase: 'checkingCommit', errorCode: 'unknown_commit' });
      await expect(executeSharedAssetSync(resumed, execution)).rejects.toThrow('版本提交结果尚未确认');
    }
    expect(mocks.repo.outbox).toHaveLength(1);
    expect(mocks.repo.outbox[0]).toMatchObject({ operationId, revisionId, phase: 'checkingCommit', errorCode: 'unknown_commit' });
    expect(mocks.repo.conflicts).toHaveLength(0); expect(execution.applyDownload).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.recover.mock.calls.every(([input]) => input.operationId === operationId && input.revisionId === revisionId)).toBe(true);
  });

  it('恢复返回uncertain与prepared时不把prepared当作可发布，旧unknownCommit冲突只恢复原身份', async () => {
    const initial = await buildSharedAssetSyncPreview(context());
    const operation = mocks.repo.outbox[0];
    mocks.repo.conflicts = [{ ...operation, id: 'legacy-conflict', reason: 'unknownCommit', createdAt: 1 }];
    operation.phase = 'conflict'; delete operation.revision; delete operation.revisionDigest;
    mocks.recover.mockImplementation(async (input: { operationId: string }) => ({ status: 'uncertain', prepared: prepared.get(input.operationId) }));
    const resumed = await buildSharedAssetSyncPreview(context());
    expect(resumed.operations[0].operation).toMatchObject({ operationId: operation.operationId, revisionId: operation.revisionId,
      phase: 'checkingCommit', errorCode: 'unknown_commit' });
    await expect(executeSharedAssetSync(resumed, commitExecution())).rejects.toThrow('版本提交结果尚未确认');
    expect(mocks.prepare).toHaveBeenCalledTimes(1); expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.repo.outbox).toHaveLength(1);
    expect(mocks.repo.outbox[0].operationId).toBe(initial.operations[0].operation.operationId);
  });

  it('真正的原生conflict仍记录冲突，不能误当作未知提交重投', async () => {
    const session = await buildSharedAssetSyncPreview(context());
    mocks.recover.mockResolvedValue({ status: 'conflict', lockRetained: false }); const execution = commitExecution();
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('并发修改');
    expect(mocks.repo.outbox[0].phase).toBe('conflict'); expect(mocks.repo.conflicts[0].reason).toBe('headChanged');
    expect(mocks.publish).not.toHaveBeenCalled(); expect(execution.applyDownload).not.toHaveBeenCalled();
  });

  it('原生准备成功但JS阶段未写回时恢复同一operation与revision，不另造候选', async () => {
    const initial = await buildSharedAssetSyncPreview(context());
    const operationId = initial.operations[0].operation.operationId;
    const revisionId = initial.operations[0].operation.revisionId;
    delete mocks.repo.outbox[0].revision; delete mocks.repo.outbox[0].revisionDigest; mocks.repo.outbox[0].phase = 'preparing';
    const resumed = await buildSharedAssetSyncPreview(context());
    expect(resumed.operations[0].operation).toMatchObject({ operationId, revisionId, phase: 'prepared' });
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    await executeSharedAssetSync(resumed, commitExecution());
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ operationId, revisionId }));
  });

  it('已下载卡片媒体仅供闭包重新同步，不重新创建普通文件资产', async () => {
    const initial = await buildSharedAssetSyncPreview(context()); const mapping = structuredClone(initial.mappings[0]);
    const index: AssetIndexRecord = { assetId: 'downloaded-image', path: '/project/owner/.shared-sync/files/card/revision/image.png',
      relativePath: '.shared-sync/files/card/revision/image.png', projectId: 'owner', source: 'project', status: 'online',
      rootPath: '/project/owner', fingerprint: '10:10', size: 10, mtimeMs: 10, updatedAt: 1 };
    mapping.media = [{ sharedMediaId: 'stable-media', localAssetId: index.assetId, projectId: 'owner',
      relativePath: index.relativePath!, bytes: 10, sha256: 'a'.repeat(64) }];
    mocks.repo = { mappings: [mapping], outbox: [], conflicts: [] }; mocks.indexes.set(index.assetId, index);
    const next = context(); next.library.characters[0].assetId = index.assetId;
    next.library.characters[0].imageUrl = `asset://localhost${index.path}`;
    const resumed = await buildSharedAssetSyncPreview(next);
    expect(resumed.mappings.filter((entry) => entry.kind === 'file')).toHaveLength(0);
    const preparedInput = mocks.prepare.mock.calls.at(-1)![0] as SharedSyncPrepareInput;
    expect(preparedInput.sources).toEqual([{ mediaId: 'stable-media', filePath: index.path }]);
    expect(preparedInput.draft.media).toMatchObject([{ id: 'stable-media', kind: 'image' }]);
  });

  it('分集媒体先复制到owner固定输入目录，nativeprepare不接收分集或辅助目录路径', async () => {
    const value = context(); value.projects = [{ id: 'owner' }, { id: 'episode', parentId: 'owner' }];
    value.library.characters[0].imageUrl = 'asset://localhost/project/episode/image.png'; value.library.characters[0].assetId = 'image';
    const index: AssetIndexRecord = { assetId: 'image', path: '/project/episode/image.png', relativePath: 'image.png',
      rootPath: '/project/episode', projectId: 'episode', source: 'project', status: 'online', size: 10, mtimeMs: 10, fingerprint: '10:10', updatedAt: 1 };
    mocks.indexes.set(index.assetId, index);
    mocks.scan.mockImplementation(async (_directory: string, options: { projectId: string }) => ({ files: options.projectId === 'episode' ? [{ assetId: 'image', path: index.path,
      name: 'image.png', relativePath: 'image.png', category: 'image', source: 'project', size: 10 }] : [],
      folders: [], complete: true, truncated: false, failedDirectories: 0, failedFiles: 0 }));
    await buildSharedAssetSyncPreview(value);
    expect(mocks.copy).toHaveBeenCalledWith(index.path, expect.stringContaining('/project/owner/.shared-sync/inputs/'), expect.anything());
    for (const [input] of mocks.prepare.mock.calls as [SharedSyncPrepareInput][]) {
      expect(input.sources.every((source) => source.filePath.startsWith('/project/owner/'))).toBe(true);
    }
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('下载已应用但ack失败保留新文件身份；恢复仅ack，不再次下载或写库', async () => {
    const asset: SharedSyncRemoteAsset = { etag: 'remote-etag', head: { sharedAssetId: 'remote-file', kind: 'file', revisionId: 'remote-revision',
      revisionDigest: 'd'.repeat(64), operationId: 'publisher-operation', updatedAt: 1 }, revision: {
      format: 'ai-canvas-shared-asset', version: 1, libraryId: 'library', sharedProjectId: 'shared-project', sharedAssetId: 'remote-file',
      revisionId: 'remote-revision', operationId: 'publisher-operation', createdAt: 1,
      payload: { kind: 'file', name: '共享.png', displayRelativePath: 'Library/共享.png', mediaId: 'image', tags: [] },
      media: [{ id: 'image', kind: 'image', extension: 'png', bytes: 10, sha256: 'a'.repeat(64) }] } };
    mocks.cloud = [asset]; mocks.download.mockImplementation(async (input: { operationId: string }) => ({ status: 'ready', operationId: input.operationId,
      revision: asset.revision, revisionDigest: asset.head.revisionDigest, applyToken: leaseToken(),
      media: [{ mediaId: 'image', relativePath: '.shared-sync/files/remote-file/remote-revision/image.png', bytes: 10, sha256: 'a'.repeat(64) }] }));
    const session = await buildSharedAssetSyncPreview(context({ version: 2, characters: [], scenes: [], props: [] }));
    const execution = commitExecution(); let fail = true;
    mocks.acknowledge.mockImplementation(async (input: { applied: boolean }) => { if (input.applied && fail) { fail = false; throw new Error('网络失败'); } });
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('网络失败');
    const currentId = mocks.repo.mappings[0].currentFileAssetId;
    expect(mocks.repo.outbox[0].phase).toBe('applied');
    const failedAck = mocks.acknowledge.mock.calls[0][0] as { operationId: string; applyToken: string };
    expect(mocks.acknowledge).toHaveBeenNthCalledWith(2, expect.objectContaining({ applied: false,
      operationId: failedAck.operationId, applyToken: failedAck.applyToken }));
    const resumed = await buildSharedAssetSyncPreview(context({ version: 2, characters: [], scenes: [], props: [] }));
    await executeSharedAssetSync(resumed, execution);
    expect(mocks.download).toHaveBeenCalledTimes(1); expect(execution.applyDownload).toHaveBeenCalledTimes(1);
    expect(mocks.repo.mappings[0].currentFileAssetId).toBe(currentId);
    expect(mocks.repo.outbox[0].phase).toBe('completed');
    expect(resumed.context.onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'paused', error: expect.stringContaining('重新预览') }));
    const unchanged = await buildSharedAssetSyncPreview(context({ version: 2, characters: [], scenes: [], props: [] }));
    expect(unchanged.items).toMatchObject([{ name: '共享.png', direction: 'unchanged' }]);
    expect(unchanged.operations).toHaveLength(0);
  });

  it('切换代次保留旧文件并重新预览，旧待办与共享身份不被复用', async () => {
    mocks.cloud = [remoteFile()];
    const empty = { version: 2 as const, characters: [], scenes: [], props: [] };
    const previous = await buildSharedAssetSyncPreview(context(empty));
    await executeSharedAssetSync(previous, commitExecution());
    const oldMapping = structuredClone(mocks.repo.mappings[0]);
    const oldOperation = structuredClone(mocks.repo.outbox[0]);
    mocks.repo.outbox.push({ ...oldOperation, id: 'old-pending', operationId: 'old-pending', phase: 'paused' });
    mocks.cloud = [];
    mocks.recover.mockClear();
    const next = context(empty); next.binding.generation = 'new-generation';
    const session = await buildSharedAssetSyncPreview(next);
    expect(session.items).toMatchObject([{ name: '共享.png', direction: 'upload' }]);
    expect(session.mappings[0]).toMatchObject({ generation: 'new-generation', currentFileAssetId: oldMapping.currentFileAssetId });
    expect(session.mappings[0].sharedAssetId).not.toBe(oldMapping.sharedAssetId);
    expect(session.operations[0].operation.operationId).not.toBe('old-pending');
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.repo.outbox.find((entry) => entry.operationId === 'old-pending')?.phase).toBe('paused');
    expect(mocks.repo.mappings.find((entry) => entry.id === oldMapping.id)).toEqual(oldMapping);
  });

  it('新代人物可引用旧代已下载的本地媒体，但使用新共享身份', async () => {
    const index = { assetId: 'old-image', path: '/project/owner/.shared-sync/files/old-character/old-revision/image.png',
      relativePath: '.shared-sync/files/old-character/old-revision/image.png', rootPath: '/project/owner', projectId: 'owner',
      source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 } satisfies AssetIndexRecord;
    mocks.indexes.set(index.assetId, index);
    mocks.repo.mappings = [{ ownerId: 'owner', connectionId: 'connection', connectionRevision: '1', libraryId: 'library',
      sharedProjectId: 'shared-project', generation: 'legacy', id: 'old-mapping', kind: 'character', localEntityId: 'local-character',
      sharedAssetId: 'old-character', members: [], media: [{ sharedMediaId: 'image', localAssetId: index.assetId, projectId: 'owner',
        relativePath: index.relativePath, sha256: 'a'.repeat(64), bytes: 10 }], updatedAt: 1 }];
    const value = context(); value.binding.generation = 'new-generation';
    value.library.characters[0].assetId = index.assetId;
    value.library.characters[0].imageUrl = `asset://localhost${index.path}`;
    const session = await buildSharedAssetSyncPreview(value);
    expect(session.items).toMatchObject([{ kind: 'character', direction: 'upload' }]);
    expect(session.mappings[0]).toMatchObject({ generation: 'new-generation', localEntityId: 'local-character' });
    expect(session.mappings[0].sharedAssetId).not.toBe('old-character');
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ generation: 'new-generation',
      sources: [expect.objectContaining({ filePath: index.path })] }));
  });

  it('新代人物可继续引用旧代声音和动作媒体', async () => {
    const makeIndex = (assetId: string, suffix: string): AssetIndexRecord & { relativePath: string } => ({ assetId,
      path: `/project/owner/.shared-sync/files/old-character/old-revision/${suffix}`,
      relativePath: `.shared-sync/files/old-character/old-revision/${suffix}`, rootPath: '/project/owner', projectId: 'owner',
      source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 });
    const audio = makeIndex('old-audio', 'voice.wav'); const video = makeIndex('old-video', 'action.mp4');
    mocks.indexes.set(audio.assetId, audio); mocks.indexes.set(video.assetId, video);
    mocks.repo.mappings = [{ ownerId: 'owner', connectionId: 'connection', connectionRevision: '1', libraryId: 'library',
      sharedProjectId: 'shared-project', generation: 'legacy', id: 'old-mapping', kind: 'character', localEntityId: 'local-character',
      sharedAssetId: 'old-character', members: [], media: [audio, video].map((entry) => ({ sharedMediaId: entry.assetId,
        localAssetId: entry.assetId, projectId: 'owner', relativePath: entry.relativePath, sha256: 'a'.repeat(64), bytes: 10 })), updatedAt: 1 }];
    const value = context(); value.binding.generation = 'new-generation';
    value.library.characters[0].voiceClips = [{ id: 'voice', kind: 'timbre', assetId: audio.assetId, audioUrl: `asset://localhost${audio.path}`,
      transcript: '', createdAt: 1, updatedAt: 1 }];
    value.library.characters[0].actions = [{ id: 'action', category: 'walking', name: '走路', prompt: '', createdAt: 1, updatedAt: 1,
      media: [{ id: 'action-media', kind: 'video', name: '动作', assetId: video.assetId, url: `asset://localhost${video.path}`, createdAt: 1, updatedAt: 1 }] }];
    const session = await buildSharedAssetSyncPreview(value);
    expect(session.items).toMatchObject([{ kind: 'character', direction: 'upload' }]);
    const sources = (mocks.prepare.mock.calls[0][0] as SharedSyncPrepareInput).sources;
    expect(sources.map((source) => source.filePath)).toEqual(expect.arrayContaining([audio.path, video.path]));
  });

  it('列表适配保持流式onFiles，并在身份识别前注入同owner范围及历史路径', async () => {
    const old: AssetIndexRecord = { assetId: 'old', path: '/project/owner/old.png', relativePath: 'old.png',
      projectId: 'owner', source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 };
    mocks.indexes.set('old', old);
    mocks.repo.mappings = [{ ownerId: 'owner', connectionId: 'connection', connectionRevision: '1', libraryId: 'library', sharedProjectId: 'shared-project',
      id: 'mapping', kind: 'file', localEntityId: 'logical-file', sharedAssetId: 'shared-file', members: [], media: [], previousFileAssetIds: ['old'], updatedAt: 1 }];
    const current = { name: 'current.png', path: '/project/owner/current.png', category: 'image' as const, size: 10 };
    mocks.list.mockImplementation(async (_projectId: string, options: { onFiles?: (files: object[]) => void }) => {
      options.onFiles?.([{ name: 'old.png', path: old.path, category: 'image', size: 10 }, current]);
      return [current];
    });
    const onFiles = vi.fn();
    expect(await projectAssetSyncService.readProjectFiles('episode', { onFiles })).toEqual([current]);
    // 共用受管根的分集必须排除owner退休文件，包括没有assetId的旧节点投影。
    mocks.roots.set('episode', '/project/owner');
    await projectAssetSyncService.readProjectFiles('episode', { onFiles });
    expect(mocks.list).toHaveBeenLastCalledWith('episode', expect.objectContaining({ excludedFilePaths: [old.path],
      projectIdentityScope: expect.arrayContaining(['owner', 'episode']) }));
    expect(onFiles).toHaveBeenLastCalledWith([current]);
  });

  it('上传提交携带旧图片记录的完整空集合，守卫缺省到新增的竞态', async () => {
    const index: AssetIndexRecord = { assetId: 'image', path: '/project/owner/image.png', relativePath: 'image.png', rootPath: '/project/owner',
      projectId: 'owner', source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 };
    mocks.indexes.set(index.assetId, index);
    mocks.scan.mockResolvedValue({ files: [{ assetId: index.assetId, name: 'image.png', path: index.path, relativePath: 'image.png',
      category: 'image', source: 'project', size: 10 }], complete: true });
    const session = await buildSharedAssetSyncPreview(context({ version: 2, characters: [], scenes: [], props: [] }));
    const execution = commitExecution(); await executeSharedAssetSync(session, execution);
    expect(execution.applyDownload).toHaveBeenCalledWith(expect.objectContaining({ commit: expect.objectContaining({
      expectedImageRecords: [{ assetId: index.assetId, records: [] }], expectedIndexes: [index],
    }) }));
  });

  it('卡片下载覆盖前复核本轮源媒体，即使卡片字段没变也阻止同URL文件替换', async () => {
    const index: AssetIndexRecord = { assetId: 'image', path: '/project/owner/image.png', relativePath: 'image.png', rootPath: '/project/owner',
      projectId: 'owner', source: 'project', fingerprint: '10:10', size: 10, mtimeMs: 10, status: 'online', updatedAt: 1 };
    mocks.indexes.set(index.assetId, index);
    mocks.scan.mockResolvedValue({ files: [{ assetId: index.assetId, name: 'image.png', path: index.path, relativePath: 'image.png',
      category: 'image', source: 'project', size: 10 }], complete: true });
    const value = context(); value.library.characters[0].assetId = index.assetId; value.library.characters[0].imageUrl = `asset://localhost${index.path}`;
    await executeSharedAssetSync(await buildSharedAssetSyncPreview(value), commitExecution());
    const remote = mocks.cloud.find((asset) => asset.head.kind === 'character')!;
    remote.revision.parentRevisionId = remote.revision.revisionId;
    remote.revision.revisionId = 'changed-revision'; remote.head.revisionId = 'changed-revision';
    remote.revision.operationId = 'other-operation'; remote.head.operationId = 'other-operation';
    if (remote.revision.payload.kind !== 'file') remote.revision.payload.data.summary = '云端新设定';
    const session = await buildSharedAssetSyncPreview(value); const execution = commitExecution();
    expect(session.items.find((item) => item.kind === 'character')?.direction).toBe('download');
    mocks.changedPaths.add(index.path);
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('项目文件或标签已变化');
    expect(execution.applyDownload).not.toHaveBeenCalled(); expect(value.library.characters[0].summary).toBe('');
    expect(mocks.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ applied: false }));
  });

  it('租约期限前五秒中止慢事务，并将独立signal和同步期限断言传入提交', async () => {
    vi.useFakeTimers();
    const session = await buildSharedAssetSyncPreview(context());
    const applyDownload = vi.fn(async ({ commit }: { commit: SharedAssetSyncCommitInput }) => {
      expect(commit.signal).toBeDefined(); expect(commit.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(115_000);
      expect(commit.signal?.aborted).toBe(true); expect(() => commit.assertCurrent?.()).toThrow('已过期');
      throw commit.signal?.reason;
    });
    await expect(executeSharedAssetSync(session, { applyDownload })).rejects.toThrow('已过期');
    expect(mocks.repo.mappings[0].acceptedRevisionId).toBeUndefined();
    expect(mocks.acknowledge).toHaveBeenCalledWith(expect.objectContaining({ applied: false }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('慢事务在令牌过期后才结束时，仍以同一令牌确认中止且不释放云端锁', async () => {
    vi.useFakeTimers();
    const session = await buildSharedAssetSyncPreview(context());
    const applyDownload = vi.fn(async ({ commit }: { commit: SharedAssetSyncCommitInput }) => {
      await vi.advanceTimersByTimeAsync(121_000);
      expect(commit.signal?.aborted).toBe(true);
      throw commit.signal?.reason;
    });
    await expect(executeSharedAssetSync(session, { applyDownload })).rejects.toThrow('已过期');
    const ack = mocks.acknowledge.mock.calls.at(-1)?.[0] as { applied: boolean; applyToken: string; releaseProjectLock?: boolean };
    expect(ack.applied).toBe(false);
    expect(Number(ack.applyToken.split('.')[0])).toBeLessThan(Date.now());
    expect(ack).not.toHaveProperty('releaseProjectLock');
  });

  it('图片准备期间时钟越过margin时保留旧库，不进入本地事务', async () => {
    vi.useFakeTimers(); const asset = remoteFile();
    if (asset.revision.payload.kind === 'file') asset.revision.payload.imageMetadata = { prompt: '新提示词', references: [] };
    mocks.cloud = [asset];
    mocks.prepareImage.mockImplementation(async (file: { assetId: string; name: string }) => {
      vi.setSystemTime(Date.now() + 116_000);
      return { id: `asset-image:${file.assetId}:digest`, assetId: file.assetId, fileName: file.name, contentDigest: 'a'.repeat(64),
        prompt: '新提示词', references: [], revision: 1, updatedAt: Date.now() };
    });
    const value = context({ version: 2, characters: [], scenes: [], props: [] });
    const session = await buildSharedAssetSyncPreview(value); const execution = commitExecution();
    await expect(executeSharedAssetSync(session, execution)).rejects.toThrow('已过期');
    expect(execution.applyDownload).not.toHaveBeenCalled(); expect(session.expectedLibrary).toBe(value.library);
    expect(mocks.repo.mappings[0].currentFileAssetId).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it('其他实例已应用同operation时停止，不认领本轮重新分配但未落库的ID', async () => {
    mocks.cloud = [remoteFile()]; const value = context({ version: 2, characters: [], scenes: [], props: [] });
    const session = await buildSharedAssetSyncPreview(value);
    const applyDownload = vi.fn(async ({ commit }: { commit: SharedAssetSyncCommitInput }) => {
      mocks.repo.outbox = [{ ...commit.operation, phase: 'applied' }];
      mocks.repo.mappings = [{ ...commit.mappings[0], currentFileAssetId: 'accepted-by-other-instance' }];
      return { alreadyApplied: true };
    });
    await expect(executeSharedAssetSync(session, { applyDownload })).rejects.toThrow('重新打开项目');
    expect(session.invalidated).toBe(true); expect(session.expectedLibrary).toBe(value.library);
    expect(session.mappings[0].currentFileAssetId).toBeUndefined();
    expect(mocks.repo.mappings[0].currentFileAssetId).toBe('accepted-by-other-instance');
    await expect(executeSharedAssetSync(session, { applyDownload })).rejects.toThrow('重新打开项目');
    expect(mocks.download).toHaveBeenCalledTimes(1); expect(applyDownload).toHaveBeenCalledTimes(1);
  });

  it('仅映射的当前版本进入文件列表，历史路径可在identify前排除', async () => {
    const oldIndex: AssetIndexRecord = { assetId: 'old', path: '/project/owner/old.png', projectId: 'owner', source: 'project',
      relativePath: 'old.png', size: 10, mtimeMs: 10, fingerprint: '10:10', status: 'online', updatedAt: 1 };
    const nextIndex = { ...oldIndex, assetId: 'current', path: '/project/owner/.shared-sync/files/card/revision/image.png',
      relativePath: '.shared-sync/files/card/revision/image.png' };
    mocks.indexes.set('old', oldIndex); mocks.indexes.set('current', nextIndex);
    const session = await buildSharedAssetSyncPreview(context()); const mapping = session.mappings[0];
    mocks.repo.mappings = [{ ...mapping, kind: 'file', sharedAssetId: 'card', acceptedRevisionId: 'revision',
      localEntityId: 'logical-file', currentFileAssetId: 'current', media: [{ sharedMediaId: 'image', localAssetId: 'current',
        projectId: 'owner', relativePath: nextIndex.relativePath, sha256: 'a'.repeat(64), bytes: 10 }],
      previousFileAssetIds: ['old'], displayRelativePath: 'Library/当前.png' }];
    expect(await sharedAssetSyncExcludedPaths('owner')).toEqual([oldIndex.path]);
    const view = await projectSharedFileView('owner', [{ assetId: 'old', name: 'old.png', path: oldIndex.path, category: 'image', size: 10 }]);
    expect(view).toMatchObject([{ assetId: 'current', name: '当前.png', path: nextIndex.path }]);
    mocks.repo.mappings[0].acceptedRevisionId = 'newer-metadata-revision';
    expect(await projectSharedFileView('owner', [])).toMatchObject([{ name: '当前.png', relativePath: 'Library/当前.png' }]);
    expect(await projectSharedFileView('episode', [])).toEqual([]);
    mocks.roots.set('episode', '/project/owner');
    expect(await sharedAssetSyncExcludedPaths('episode')).toEqual([oldIndex.path]);
    expect(await projectSharedFileView('episode', [{ name: 'old.png', path: oldIndex.path, category: 'image', size: 10 }])).toEqual([]);
    mocks.indexes.set('current', { ...nextIndex, path: '/project/owner/改名.png', relativePath: '改名.png' });
    expect(await projectSharedFileView('owner', [])).toMatchObject([{ assetId: 'current', name: '改名.png', relativePath: '改名.png' }]);
  });
});
