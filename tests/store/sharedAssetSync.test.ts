import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AppState } from '../../src/store/useAppStore';
import type { SharedProjectBinding } from '../../src/types/assetSync';
import type { SharedAssetSyncContext, SharedAssetSyncSession } from '../../src/services/fs/sharedAssetSync';

const mocks = vi.hoisted(() => ({
  preview: vi.fn(), execute: vi.fn(), cancel: vi.fn(async () => undefined),
  load: vi.fn(), listen: vi.fn<(name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>>(),
  notify: vi.fn(), commit: vi.fn(async () => ({ alreadyApplied: false })),
  invoke: vi.fn(),
  previewReset: vi.fn(), applyReset: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/services/fs/sharedAssetSync', () => ({ projectAssetSyncService: {
  preview: mocks.preview, apply: mocks.execute, readState: mocks.load,
} }));
vi.mock('../../src/services/fs/sharedAssetStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/services/fs/sharedAssetStorage')>(),
  cancelSharedStorageTask: mocks.cancel, sharedStorageErrorMessage: (code: string) => code,
  previewSharedProjectReset: mocks.previewReset, applySharedProjectReset: mocks.applyReset,
  bindSharedStorageProject: vi.fn(), probeSharedStorageProject: vi.fn(), loadSharedStorageSnapshot: vi.fn(),
  removeSharedStorageConnection: vi.fn(), saveSharedStorageConnection: vi.fn(), unbindSharedStorageProject: vi.fn(),
}));
vi.mock('../../src/services/configPersistenceQueue', () => ({
  areSettingsMutationsFrozen: () => false, enqueueConfigPersistence: (run: () => Promise<void>) => run(),
}));
vi.mock('../../src/services/fs/core', () => ({ notifyProjectDiskChanged: mocks.notify, isTauriEnv: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
import { createAssetSyncSlice } from '../../src/store/store.assetSync';

const binding: SharedProjectBinding = {
  ownerId: 'series', ownerName: '测试剧集', connectionId: 'connection', connectionRevision: 'connection-v1',
  libraryId: 'library', sharedProjectId: 'shared-project', projectPrefix: 'team/libraries/library/projects/shared-project',
  capabilities: { checks: [], multiplayerWritable: true, cleanupPending: false, checkedAt: 1 }, updatedAt: 1,
};
function session(context: SharedAssetSyncContext): SharedAssetSyncSession {
  context.onStatus({ stage: 'preview', items: [{ id: 'asset', name: '角色', kind: 'character', direction: 'upload' }], total: 1 });
  return { context, expectedLibrary: context.library, rootDirectory: 'runtime-only', mappings: [],
    operations: [{ operation: {} }], items: [], completed: 0, executing: false, savedMappings: new Map() } as unknown as SharedAssetSyncSession;
}
function arrange() {
  return createStore<AppState>()((...args) => ({
    ...createAssetSyncSlice(...args), currentProjectId: 'episode', projectInitialized: true, projectLoadStatus: 'ready',
    projects: [{ id: 'series', dataFolder: 'series' }, { id: 'episode', parentId: 'series', dataFolder: 'series' }, { id: 'other' }],
    config: { baseDataDir: 'runtime-root' }, nodes: [], dramaAssets: { version: 2, characters: [], scenes: [], props: [] },
    sharedAssetStorage: { revision: 1, bindings: [binding], connections: [{ id: 'connection', name: '测试存储',
      endpoint: 'https://s3.example.com', bucket: 'assets', region: 'us-east-1', rootPrefix: 'team', pathStyle: true,
      revision: 'connection-v1', credentialsSaved: true, sessionTokenSaved: false }] }, commitSharedAssetSyncDownload: mocks.commit,
  } as unknown as AppState));
}
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.cancel.mockResolvedValue(undefined);
  mocks.previewReset.mockImplementation(async (input: { mode: string }) => ({ mode: input.mode, objectCount: 3, bytes: 10, previewToken: 'preview-token' }));
  mocks.applyReset.mockResolvedValue({ status: 'completed', deletedCount: 3, totalCount: 3 });
  mocks.load.mockResolvedValue({ mappings: [], outbox: [], conflicts: [] });
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.preview.mockImplementation(async (context: SharedAssetSyncContext) => session(context));
  mocks.commit.mockResolvedValue({ alreadyApplied: false });
  mocks.execute.mockImplementation(async (value: SharedAssetSyncSession) => value.context.onStatus({ stage: 'completed' }));
});

describe('手动项目资产同步协调边界', () => {
  it('清理仅在用户确认预览后执行，保留本机项目和绑定', async () => {
    const store = arrange();
    const originalLibrary = store.getState().dramaAssets;
    const preview = await store.getState().previewSharedProjectReset('series', 'clear');
    expect(preview).toMatchObject({ objectCount: 3, bytes: 10 });
    expect(mocks.applyReset).not.toHaveBeenCalled();
    const result = await store.getState().applySharedProjectReset('series', 'clear', preview.previewToken);
    expect(result).toEqual({ status: 'completed', deletedCount: 3, totalCount: 3 });
    expect(mocks.applyReset).toHaveBeenCalledWith(expect.objectContaining({ mode: 'clear', previewToken: 'preview-token' }));
    expect(store.getState().dramaAssets).toBe(originalLibrary);
    expect(store.getState().sharedAssetStorage?.bindings).toEqual([binding]);
  });
  it('部分失败返回真实数量且不修改本地资产', async () => {
    const store = arrange();
    const preview = await store.getState().previewSharedProjectReset('series', 'delete');
    mocks.applyReset.mockResolvedValue({ status: 'failed', deletedCount: 1, totalCount: 3, errorCode: 'network' });
    const result = await store.getState().applySharedProjectReset('series', 'delete', preview.previewToken);
    expect(result).toMatchObject({ status: 'failed', deletedCount: 1, totalCount: 3 });
    expect(store.getState().sharedAssetStorage?.bindings).toEqual([binding]);
    expect(store.getState().sharedProjectResetStatus.series.stage).toBe('idle');
  });
  it('取消预览等待原请求结束，迟到结果不能重新显示', async () => {
    const store = arrange();
    let finish!: (value: { mode: 'clear'; objectCount: number; bytes: number; previewToken: string }) => void;
    mocks.previewReset.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = store.getState().previewSharedProjectReset('series', 'clear');
    const rejected = expect(pending).rejects.toThrow('cancelled');
    let cancelled = false;
    const stopping = store.getState().cancelSharedProjectResetPreview('series').then(() => { cancelled = true; });
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(1));
    expect(cancelled).toBe(false);
    finish({ mode: 'clear', objectCount: 1, bytes: 1, previewToken: 'token' });
    await rejected; await stopping;
    expect(store.getState().sharedProjectResetStatus.series.stage).toBe('idle');
    expect(mocks.applyReset).not.toHaveBeenCalled();
  });
  it('执行时显示清理进度，取消等待实际结果并保留部分删除数', async () => {
    const store = arrange();
    const preview = await store.getState().previewSharedProjectReset('series', 'delete');
    let emit!: (event: { payload: unknown }) => void;
    mocks.listen.mockImplementation(async (_name: string, handler: typeof emit) => { emit = handler; return vi.fn<() => void>(); });
    let finish!: (result: { status: 'cancelled'; deletedCount: number; totalCount: number }) => void;
    mocks.applyReset.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const applying = store.getState().applySharedProjectReset('series', 'delete', preview.previewToken);
    await vi.waitFor(() => expect(mocks.applyReset).toHaveBeenCalledTimes(1));
    const taskId = mocks.applyReset.mock.calls[0][0].taskId;
    emit({ payload: { taskId, ownerId: 'series', phase: 'cleanup', transferredBytes: 2, totalBytes: 3 } });
    expect(store.getState().sharedProjectResetStatus.series.progress).toEqual({ deletedCount: 2, totalCount: 3 });
    let done = false;
    const stopping = store.getState().cancelSharedProjectResetPreview('series').then(() => { done = true; });
    await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(taskId));
    expect(done).toBe(false);
    finish({ status: 'cancelled', deletedCount: 2, totalCount: 3 });
    expect(await applying).toEqual({ status: 'cancelled', deletedCount: 2, totalCount: 3 });
    await stopping;
    expect(store.getState().sharedAssetStorage?.bindings).toEqual([binding]);
  });
  it('原生清理接口验证输出计数', async () => {
    const storage = await vi.importActual<typeof import('../../src/services/fs/sharedAssetStorage')>('../../src/services/fs/sharedAssetStorage');
    const context = { taskId: 'task', ownerId: 'owner', connectionId: 'connection', connectionRevision: 'revision', libraryId: 'library', sharedProjectId: 'project' };
    mocks.invoke.mockResolvedValueOnce({ mode: 'clear', objectCount: 3, bytes: 10, previewToken: 'token' });
    expect(await storage.previewSharedProjectReset({ ...context, mode: 'clear' })).toMatchObject({ objectCount: 3 });
    mocks.invoke.mockResolvedValueOnce({ status: 'failed', deletedCount: 5, totalCount: 3 });
    await expect(storage.applySharedProjectReset({ ...context, mode: 'clear', previewToken: 'token' })).rejects.toThrow();
  });

  it('记录恢复失败时仅输出白名单字段，不记录原始异常或参数', async () => {
    const storage = await vi.importActual<typeof import('../../src/services/fs/sharedAssetStorage')>('../../src/services/fs/sharedAssetStorage');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mocks.invoke.mockRejectedValue({ code: 'unknown', stage: 'partUpload', message: 'private-signature' });
      await expect(storage.recoverSharedAssetOperation({
        taskId: 'task', ownerId: 'owner', connectionId: 'connection', connectionRevision: 'revision',
        libraryId: 'library', sharedProjectId: 'project', operationId: 'operation', revisionId: 'revision', sharedAssetId: 'asset',
      })).rejects.toBeInstanceOf(Error);
      expect(warning).toHaveBeenCalledWith('[project-asset-sync] IPC failed', 'project_asset_storage_recover_operation',
        { code: 'unknown', stage: 'partUpload' });
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-signature');
      expect(JSON.stringify(warning.mock.calls)).not.toContain('operationId');
    } finally { warning.mockRestore(); }
  });

  it('只将安全的原生失败阶段投影到状态，不暴露原始错误内容', async () => {
    const storage = await vi.importActual<typeof import('../../src/services/fs/sharedAssetStorage')>('../../src/services/fs/sharedAssetStorage');
    mocks.invoke.mockRejectedValue({ code: 'unknown', stage: 'partUpload', message: 'private-signature' });
    const failure = await storage.loadSharedStorageSnapshot().then(
      () => { throw new Error('expected failure'); },
      (error: unknown) => error as Error,
    );
    expect(failure).toMatchObject({ cause: { code: 'unknown', stage: 'partUpload' } });
    expect(JSON.stringify(failure.cause)).not.toContain('private-signature');
    expect(storage.sharedStorageErrorStage(new Error('x', { cause: { stage: 'private-signature' } }))).toBeUndefined();
    const store = arrange();
    mocks.execute.mockRejectedValue(failure);
    await store.getState().previewSharedProjectSync('series');
    await store.getState().syncSharedProjectNow('series');
    expect(store.getState().sharedAssetSyncStatus.series).toMatchObject({ stage: 'failed', errorStage: 'partUpload' });
    expect(JSON.stringify(store.getState().sharedAssetSyncStatus)).not.toContain('private-signature');
  });

  it('预览不提交传输，显式应用后才执行，并不把路径或会话放进Store', async () => {
    const store = arrange();
    await store.getState().previewSharedProjectSync('series');
    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ binding, originProjectId: 'episode' }));
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('preview');
    expect(JSON.stringify(store.getState().sharedAssetSyncStatus)).not.toContain('runtime-only');
    await store.getState().syncSharedProjectNow('series');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('completed');
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it('切换后再切回仍撤销原预览与原生请求，不自动应用迟到结果', async () => {
    const store = arrange();
    let finish!: (value: SharedAssetSyncSession) => void;
    let captured!: SharedAssetSyncContext;
    mocks.preview.mockImplementation((context: SharedAssetSyncContext) => {
      captured = context; context.onTask('native-task', true);
      return new Promise<SharedAssetSyncSession>((resolve) => { finish = resolve; });
    });
    const preparing = store.getState().previewSharedProjectSync('series');
    await vi.waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    store.setState({ currentProjectId: 'other' });
    store.setState({ currentProjectId: 'episode' });
    expect(captured.signal?.aborted).toBe(true);
    finish(session(captured)); await preparing;
    expect(mocks.cancel).toHaveBeenCalledWith('native-task');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('paused');
  });

  it('库内容变化使已有预览失效，不能发布旧预览', async () => {
    const store = arrange();
    await store.getState().previewSharedProjectSync('series');
    store.setState({ dramaAssets: { ...store.getState().dramaAssets, lastViewedAt: 2 } });
    await store.getState().cancelSharedProjectSync('series');
    await expect(store.getState().syncSharedProjectNow('series')).rejects.toThrow('请先重新预览');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('实际传输时的本地提交通过项目保存屏障，不能绕过Store直接保存', async () => {
    const store = arrange();
    mocks.execute.mockImplementation(async (_value, options) => {
      await options.applyDownload({ expectedLibrary: store.getState().dramaAssets,
        commit: { ownerId: 'series', operationId: 'operation', mappings: [], operation: {} } });
    });
    await store.getState().previewSharedProjectSync('series');
    await store.getState().syncSharedProjectNow('series');
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'series', originProjectId: 'episode' }));
  });

  it('无变更的已完成预览释放运行实例，关闭面板不会改成暂停', async () => {
    const store = arrange();
    mocks.preview.mockImplementation(async (context: SharedAssetSyncContext) => {
      const value = session(context); value.operations = [];
      context.onStatus({ stage: 'completed', items: [], total: 0, lastSyncedAt: 20 });
      return value;
    });
    await store.getState().previewSharedProjectSync('series');
    await store.getState().cancelSharedProjectSync('series');
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('completed');
    expect(store.getState().sharedAssetSyncStatus.series.lastSyncedAt).toBe(20);
  });

  it('晚到的旧失败不能覆盖新预览', async () => {
    const store = arrange();
    let fail!: (error: Error) => void;
    mocks.preview.mockImplementationOnce(() => new Promise<SharedAssetSyncSession>((_resolve, reject) => { fail = reject; }));
    const old = store.getState().previewSharedProjectSync('series');
    await vi.waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
    await store.getState().cancelSharedProjectSync('series');
    await store.getState().previewSharedProjectSync('series');
    fail(new Error('旧任务失败')); await old;
    expect(store.getState().sharedAssetSyncStatus.series.stage).toBe('preview');
    expect(store.getState().sharedAssetSyncStatus.series.error).toBeUndefined();
  });
});
