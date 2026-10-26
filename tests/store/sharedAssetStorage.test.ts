import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AppState } from '../../src/store/useAppStore';
import type { BindSharedProjectInput, SharedAssetStorageSnapshot, SharedProjectOperationResult } from '../../src/types/assetSync';

const native = vi.hoisted(() => ({
  loadSharedStorageSnapshot: vi.fn(), saveSharedStorageConnection: vi.fn(), removeSharedStorageConnection: vi.fn(),
  bindSharedStorageProject: vi.fn(), probeSharedStorageProject: vi.fn(), unbindSharedStorageProject: vi.fn(),
  cancelSharedStorageTask: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/fs/sharedAssetStorage', () => ({ ...native, sharedStorageErrorMessage: (code: string) => code }));
vi.mock('../../src/services/configPersistenceQueue', () => ({
  areSettingsMutationsFrozen: () => false, enqueueConfigPersistence: (run: () => Promise<void>) => run(),
}));
import { createAssetSyncSlice } from '../../src/store/store.assetSync';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
const snapshot = (revision = 1): SharedAssetStorageSnapshot => ({
  revision, connections: [{
    id: 'connection-a', name: '团队存储', endpoint: 'https://storage.example.com', region: 'region-1',
    bucket: 'project-assets', rootPrefix: 'team', pathStyle: true, revision: `connection-${revision}`,
    credentialsSaved: true, sessionTokenSaved: false,
  }], bindings: [],
});
const request = (): BindSharedProjectInput => ({
  taskId: 'task-a', ownerId: 'series-a', ownerName: '整部剧', connectionId: 'connection-a',
  connectionRevision: 'connection-1', mode: 'create', libraryId: 'library-a', sharedProjectId: 'shared-project-a',
});
const report = { checks: [], checkedAt: 1, cleanupPending: false, multiplayerWritable: false };
function result(revision = 1): SharedProjectOperationResult { return { snapshot: snapshot(revision), report, bound: false }; }
function arrange() {
  return createStore<AppState>()((...args) => ({
    ...createAssetSyncSlice(...args),
    projects: [{ id: 'series-a' }, { id: 'episode-a', parentId: 'series-a' }, { id: 'other-project' }],
    currentProjectId: 'episode-a', projectInitialized: true, projectLoadStatus: 'ready', sharedAssetStorage: snapshot(),
  } as AppState));
}
beforeEach(() => { for (const mock of Object.values(native)) mock.mockReset(); native.cancelSharedStorageTask.mockResolvedValue(undefined); });

describe('项目 S3 状态投影与操作租约', () => {
  it('迟到的 catalog 读取不能覆盖新版本，并等待所有并发读取结束', async () => {
    const store = arrange();
    const old = deferred<SharedAssetStorageSnapshot>();
    const latest = deferred<SharedAssetStorageSnapshot>();
    native.loadSharedStorageSnapshot.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const first = store.getState().loadSharedAssetStorage();
    const second = store.getState().loadSharedAssetStorage();
    latest.resolve(snapshot(5)); await second;
    expect(store.getState().sharedAssetStorageLoading).toBe(true);
    old.resolve(snapshot(2)); await first;
    expect(store.getState().sharedAssetStorage?.revision).toBe(5);
    expect(store.getState().sharedAssetStorageLoading).toBe(false);
  });

  it('分集绑定整部剧 owner，不能从该入口误绑其他查看项目', async () => {
    const store = arrange(); native.bindSharedStorageProject.mockResolvedValue(result());
    await expect(store.getState().bindSharedProject({ ...request(), ownerId: 'other-project' })).rejects.toThrow('conflict');
    expect(native.bindSharedStorageProject).not.toHaveBeenCalled();
    await store.getState().bindSharedProject(request());
    expect(native.bindSharedStorageProject).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'series-a' }));
  });

  it('切换项目后即使切回，也取消原任务并拒绝迟到的成功显示', async () => {
    const store = arrange(); const remote = deferred<SharedProjectOperationResult>();
    native.bindSharedStorageProject.mockReturnValue(remote.promise);
    const pending = store.getState().bindSharedProject(request());
    const rejected = expect(pending).rejects.toThrow('cancelled');
    store.setState({ currentProjectId: 'other-project' });
    store.setState({ currentProjectId: 'episode-a' });
    expect(native.cancelSharedStorageTask).toHaveBeenCalledWith('task-a');
    remote.resolve(result()); await rejected;
    expect(store.getState().currentProjectId).toBe('episode-a');
  });

  it('连接版本更新会撤销操作，旧回复不能恢复过期能力', async () => {
    const store = arrange(); const remote = deferred<SharedProjectOperationResult>();
    native.bindSharedStorageProject.mockReturnValue(remote.promise);
    const pending = store.getState().bindSharedProject(request());
    const rejected = expect(pending).rejects.toThrow('cancelled');
    native.loadSharedStorageSnapshot.mockResolvedValue(snapshot(8));
    await store.getState().loadSharedAssetStorage();
    remote.resolve(result(2)); await rejected;
    expect(store.getState().sharedAssetStorage?.connections[0].revision).toBe('connection-8');
  });

  it('同一 owner 的并行操作被阻止，显式取消会调用原生任务撤销', async () => {
    const store = arrange(); const remote = deferred<SharedProjectOperationResult>();
    native.bindSharedStorageProject.mockReturnValue(remote.promise);
    const pending = store.getState().bindSharedProject(request());
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await expect(store.getState().bindSharedProject({ ...request(), taskId: 'task-b' })).rejects.toThrow('busy');
    await store.getState().cancelSharedStorageOperation('task-a');
    remote.resolve(result()); await rejected;
    expect(native.bindSharedStorageProject).toHaveBeenCalledTimes(1);
  });

  it('保存失败保留旧状态，成功也只接收公开 catalog，凭据不进 Store', async () => {
    const store = arrange(); const connection = snapshot().connections[0];
    const input = { connection, expectedRevision: connection.revision, credentials: { accessKeyId: 'private-key', secretAccessKey: 'private-secret' } };
    native.saveSharedStorageConnection.mockRejectedValueOnce(new Error('save failed'));
    await expect(store.getState().saveSharedStorageConnection(input)).rejects.toThrow('save failed');
    expect(store.getState().sharedAssetStorage?.revision).toBe(1);
    native.saveSharedStorageConnection.mockResolvedValue(snapshot(3));
    await store.getState().saveSharedStorageConnection(input);
    expect(JSON.stringify(store.getState().sharedAssetStorage)).not.toContain('private-secret');
    expect(JSON.stringify(store.getState().sharedAssetStorage)).not.toContain('private-key');
  });

  it('解绑捕获共享项目身份，防止仅凭连接版本解除另一个项目绑定', async () => {
    const store = arrange();
    store.setState({ sharedAssetStorage: { ...snapshot(), bindings: [{
      ownerId: 'series-a', ownerName: '整部剧', connectionId: 'connection-a', connectionRevision: 'connection-1',
      libraryId: 'library-a', sharedProjectId: 'project-a', projectPrefix: 'team/libraries/library-a/projects/project-a',
      capabilities: report, updatedAt: 1,
    }] } });
    native.unbindSharedStorageProject.mockResolvedValue(snapshot(2));
    await store.getState().unbindSharedProject('series-a', 'connection-1');
    expect(native.unbindSharedStorageProject).toHaveBeenCalledWith({
      ownerId: 'series-a', connectionRevision: 'connection-1', libraryId: 'library-a', sharedProjectId: 'project-a',
    });
  });

  it('项目目录完成加载后才允许清理已删除项目的孤立绑定', async () => {
    const store = arrange();
    const binding = {
      ownerId: 'deleted-project', ownerName: '已删除项目', connectionId: 'connection-a', connectionRevision: 'connection-1',
      libraryId: 'library-a', sharedProjectId: 'project-a', projectPrefix: 'team/libraries/library-a/projects/project-a',
      capabilities: report, updatedAt: 1,
    };
    store.setState({ sharedAssetStorage: { ...snapshot(), bindings: [binding] }, projectInitialized: false });
    await expect(store.getState().unbindSharedProject('deleted-project', 'connection-1')).rejects.toThrow('conflict');
    expect(native.unbindSharedStorageProject).not.toHaveBeenCalled();
    store.setState({ projectInitialized: true });
    native.unbindSharedStorageProject.mockResolvedValue(snapshot(2));
    await store.getState().unbindSharedProject('deleted-project', 'connection-1');
    expect(native.unbindSharedStorageProject).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'deleted-project' }));
  });
});
