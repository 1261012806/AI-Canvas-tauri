import { createStore } from 'zustand/vanilla';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { DramaAssetLibrary } from '../../src/types/dramaAssets';
import type { SharedAssetSyncCommitInput } from '../../src/services/indexedDb/sharedAssetSyncRepository';
import type { ProjectSaveData } from '../../src/services/storageService';

const mocks = vi.hoisted(() => ({
  saveProject: vi.fn(),
  getProjectById: vi.fn(),
  serializeProjectRecord: vi.fn(),
  applySharedAssetSyncCommit: vi.fn(),
}));
vi.mock('../../src/services/fileService', () => ({
  saveProject: mocks.saveProject,
  setBaseDataDir: vi.fn(), syncAuthorizedDirectories: vi.fn(),
}));
vi.mock('../../src/services/storageService', () => ({ serializeProjectRecord: mocks.serializeProjectRecord }));
vi.mock('../../src/services/indexedDb/sharedAssetSyncRepository', () => ({ applySharedAssetSyncCommit: mocks.applySharedAssetSyncCommit }));
vi.mock('../../src/services/indexedDbService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/indexedDbService')>('../../src/services/indexedDbService'),
  getProjectById: mocks.getProjectById,
}));
vi.mock('../../src/services/projectSnapshotService', () => ({ captureCurrentCanvasSnapshot: vi.fn() }));
vi.mock('../../src/services/pollManager', () => ({ resumePendingTasks: vi.fn(), clearProjectTasks: vi.fn(), cancelNodePolling: vi.fn() }));
// 本用例独立组装 project slice，不应初始化全局 Store 或其他 slice。
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: vi.fn() } }));

import { createProjectSlice } from '../../src/store/store.projects';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const library = (): DramaAssetLibrary => ({ version: 2, characters: [], scenes: [], props: [] });
function arrange() {
  return createStore<AppState>()((...args) => ({ ...createProjectSlice(...args),
    projects: [{ id: 'owner', name: '项目', createdAt: 1, updatedAt: 1 }],
    currentProjectId: 'owner', projectName: '项目', projectLoadStatus: 'ready', projectInitialized: true,
    nodes: [], edges: [], groups: [], dramaAssets: library(), showToast: vi.fn(),
  } as unknown as AppState));
}
function commit(): SharedAssetSyncCommitInput {
  const binding = { ownerId: 'owner', connectionId: 'connection', connectionRevision: 'c1', libraryId: 'library', sharedProjectId: 'shared' };
  return { ownerId: 'owner', operationId: 'operation', mappings: [], operation: { ...binding,
    id: 'pending', operationId: 'operation', sharedAssetId: 'asset', kind: 'file', direction: 'download',
    mappingId: 'mapping', revisionId: 'r2', phase: 'applying', createdAt: 1, updatedAt: 1 } };
}
function holdApply() {
  const entered = deferred<SharedAssetSyncCommitInput>();
  const release = deferred<void>();
  mocks.applySharedAssetSyncCommit.mockImplementation(async (input: SharedAssetSyncCommitInput) => {
    entered.resolve(input);
    await release.promise;
    input.assertCurrent?.();
    const result = { alreadyApplied: false };
    input.onCommitted?.(result);
    return result;
  });
  return { entered, release };
}
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.saveProject.mockImplementation(async (record: ProjectSaveData) => record.id);
  mocks.serializeProjectRecord.mockImplementation(async (record: ProjectSaveData) => record);
  mocks.getProjectById.mockResolvedValue({ id: 'owner', nodes: [], edges: [], dramaAssets: library() });
});

describe('共享资产应用与项目保存屏障', () => {
  it('等待旧保存结束，屏障内的新保存重新捕获已提交的库', async () => {
    const store = arrange();
    const oldSave = deferred<string>();
    mocks.saveProject.mockImplementationOnce(() => oldSave.promise);
    const first = store.getState().saveCurrentProjectSilent();
    const expected = store.getState().dramaAssets;
    const next = { ...expected, lastViewedAt: 2 };
    const apply = holdApply();
    const downloading = store.getState().commitSharedAssetSyncDownload({ ownerId: 'owner', originProjectId: 'owner',
      expectedLibrary: expected, nextLibrary: next, commit: commit() });
    const queued = store.getState().saveCurrentProjectSilent();
    expect(mocks.applySharedAssetSyncCommit).not.toHaveBeenCalled();
    expect(mocks.saveProject).toHaveBeenCalledTimes(1);
    oldSave.resolve('owner');
    await first;
    await apply.entered.promise;
    expect(mocks.saveProject).toHaveBeenCalledTimes(1);
    expect(store.getState().dramaAssets).toBe(expected);
    apply.release.resolve();
    await downloading;
    await queued;
    expect(store.getState().dramaAssets).toBe(next);
    expect(mocks.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({ dramaAssets: next }));
  });

  it('应用期间本地库被编辑时中止事务，随后保存本地编辑而非下载快照', async () => {
    const store = arrange();
    const expected = store.getState().dramaAssets;
    const next = { ...expected, lastViewedAt: 2 };
    const apply = holdApply();
    const downloading = store.getState().commitSharedAssetSyncDownload({ ownerId: 'owner', originProjectId: 'owner',
      expectedLibrary: expected, nextLibrary: next, commit: commit() });
    const rejected = expect(downloading).rejects.toThrow();
    const input = await apply.entered.promise;
    const edited = { ...expected, lastViewedAt: 3 };
    store.setState({ dramaAssets: edited });
    expect(input.signal?.aborted).toBe(true);
    const queued = store.getState().saveCurrentProjectSilent();
    apply.release.resolve();
    await rejected;
    await queued;
    expect(store.getState().dramaAssets).toBe(edited);
    expect(mocks.saveProject).toHaveBeenLastCalledWith(expect.objectContaining({ dramaAssets: edited }));
  });

  it('切走后再切回也不接受旧应用结果，且释放保存屏障', async () => {
    const store = arrange();
    const expected = store.getState().dramaAssets;
    const apply = holdApply();
    const downloading = store.getState().commitSharedAssetSyncDownload({ ownerId: 'owner', originProjectId: 'owner',
      expectedLibrary: expected, nextLibrary: { ...expected, lastViewedAt: 2 }, commit: commit() });
    const rejected = expect(downloading).rejects.toThrow();
    const input = await apply.entered.promise;
    store.setState({ currentProjectId: 'another' });
    store.setState({ currentProjectId: 'owner' });
    expect(input.signal?.aborted).toBe(true);
    apply.release.resolve();
    await rejected;
    await expect(store.getState().saveCurrentProjectSilent()).resolves.toBe('owner');
    expect(store.getState().dramaAssets).toBe(expected);
  });

  it('已应用操作只返回幂等结果，不再投影恢复请求中的旧快照', async () => {
    const store = arrange();
    const current = store.getState().dramaAssets;
    mocks.applySharedAssetSyncCommit.mockImplementation(async (input: SharedAssetSyncCommitInput) => {
      const result = { alreadyApplied: true };
      input.onCommitted?.(result);
      return result;
    });
    await expect(store.getState().commitSharedAssetSyncDownload({ ownerId: 'owner', originProjectId: 'owner',
      expectedLibrary: current, nextLibrary: { ...current, lastViewedAt: 0 }, commit: commit() })).resolves.toEqual({ alreadyApplied: true });
    expect(store.getState().dramaAssets).toBe(current);
  });
});
