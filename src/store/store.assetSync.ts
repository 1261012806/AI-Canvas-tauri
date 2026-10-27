/** 项目云存储状态只由原生 catalog 投影；凭据、请求与取消句柄不进入 Store。 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import { seriesOwnerId } from './store.utils';
import { areSettingsMutationsFrozen, enqueueConfigPersistence } from '../services/configPersistenceQueue';
import {
  bindSharedStorageProject, cancelSharedStorageTask, loadSharedStorageSnapshot,
  probeSharedStorageProject, removeSharedStorageConnection, saveSharedStorageConnection,
  sharedStorageErrorMessage, sharedStorageErrorStage, unbindSharedStorageProject,
  previewSharedProjectReset as previewNativeReset, applySharedProjectReset as applyNativeReset,
} from '../services/fs/sharedAssetStorage';
import type {
  BindSharedProjectInput, ProbeSharedProjectInput, SaveSharedStorageConnectionInput,
  SharedAssetStorageSnapshot, SharedProjectOperationResult, SharedAssetSyncStatus, SharedSyncProgress,
  SharedProjectBinding, SharedProjectResetMode, SharedProjectResetPreview, SharedProjectResetResult,
  SharedProjectResetStatus,
} from '../types/assetSync';
import type { SharedAssetSyncSession } from '../services/fs/sharedAssetSync';
import { notifyProjectDiskChanged } from '../services/fs/core';

export interface AssetSyncSlice {
  sharedAssetStorage: SharedAssetStorageSnapshot | null;
  sharedAssetStorageLoading: boolean;
  sharedAssetSyncStatus: Record<string, SharedAssetSyncStatus>;
  sharedProjectResetStatus: Record<string, SharedProjectResetStatus>;
  loadSharedAssetStorage: () => Promise<void>;
  saveSharedStorageConnection: (input: SaveSharedStorageConnectionInput) => Promise<void>;
  removeSharedStorageConnection: (id: string, revision: string) => Promise<void>;
  bindSharedProject: (input: BindSharedProjectInput) => Promise<SharedProjectOperationResult>;
  probeSharedProject: (input: ProbeSharedProjectInput) => Promise<SharedProjectOperationResult>;
  unbindSharedProject: (ownerId: string, connectionRevision: string) => Promise<void>;
  cancelSharedStorageOperation: (taskId: string) => Promise<void>;
  loadSharedProjectSyncState: (ownerId: string) => Promise<void>;
  previewSharedProjectSync: (ownerId: string) => Promise<void>;
  syncSharedProjectNow: (ownerId: string) => Promise<void>;
  cancelSharedProjectSync: (ownerId: string) => Promise<void>;
  previewSharedProjectReset: (ownerId: string, mode: SharedProjectResetMode) => Promise<SharedProjectResetPreview>;
  applySharedProjectReset: (ownerId: string, mode: SharedProjectResetMode, previewToken: string) => Promise<SharedProjectResetResult>;
  cancelSharedProjectResetPreview: (ownerId: string) => Promise<void>;
}

export const createAssetSyncSlice: StateCreator<AppState, [], [], AssetSyncSlice> = (set, get, api) => {
  const operations = new Map<string, { ownerId: string; connectionId: string; revision: string; cancelled: boolean }>();
  let unwatch: (() => void) | undefined;
  let loads = 0;
  const syncRuns = new Map<string, {
    controller: AbortController; tasks: Set<string>; connectionId: string;
    session?: SharedAssetSyncSession; stop?: () => void; running: boolean;
    expectedLibrary: AppState['dramaAssets']; applying: boolean;
  }>();
  // 预览令牌和取消句柄仅保存在当前窗口内存。
  const resetRuns = new Map<string, { binding: SharedProjectBinding; mode: SharedProjectResetMode;
    previewToken?: string; busy: boolean; taskId?: string; done?: Promise<void>; cancelRequested?: boolean }>();
  const resetStatus = (ownerId: string, stage: SharedProjectResetStatus['stage'], progress?: SharedProjectResetStatus['progress']) => {
    set((state) => ({ sharedProjectResetStatus: { ...state.sharedProjectResetStatus, [ownerId]: { stage, ...(progress ? { progress } : {}) } } }));
  };
  const updateSync = (ownerId: string, patch: Partial<SharedAssetSyncStatus>) => {
    set((state) => ({ sharedAssetSyncStatus: { ...state.sharedAssetSyncStatus, [ownerId]: {
      ...(state.sharedAssetSyncStatus[ownerId] ?? { ownerId, stage: 'idle', items: [], completed: 0, total: 0 }), ...patch,
    } } }));
  };
  const cancelSync = async (ownerId: string) => {
    const runtime = syncRuns.get(ownerId);
    if (!runtime) return;
    runtime.controller.abort();
    runtime.stop?.();
    await Promise.allSettled([...runtime.tasks].map((taskId) => cancelSharedStorageTask(taskId)));
    if (syncRuns.get(ownerId) === runtime) {
      syncRuns.delete(ownerId);
      updateSync(ownerId, { stage: 'paused', progress: undefined, errorStage: undefined });
    }
  };

  const currentOwner = () => {
    const state = get();
    if (!state.projectInitialized || state.projectLoadStatus !== 'ready'
      || !state.currentProjectId || !state.projects.some((project) => project.id === state.currentProjectId)) return null;
    const ownerId = seriesOwnerId(state.projects, state.currentProjectId);
    return state.projects.some((project) => project.id === ownerId) ? ownerId : null;
  };
  const requireOwner = (ownerId: string) => {
    if (currentOwner() !== ownerId) throw new Error(sharedStorageErrorMessage('conflict'));
  };
  const resetBinding = (ownerId: string) => {
    requireOwner(ownerId);
    const binding = get().sharedAssetStorage?.bindings.find((item) => item.ownerId === ownerId);
    const connection = get().sharedAssetStorage?.connections.find((item) => item.id === binding?.connectionId);
    if (!binding || !connection || connection.revision !== binding.connectionRevision || !connection.credentialsSaved) {
      throw new Error(sharedStorageErrorMessage('binding_not_found'));
    }
    return binding;
  };
  const resetContext = (binding: SharedProjectBinding) => ({ taskId: crypto.randomUUID(), ownerId: binding.ownerId,
    connectionId: binding.connectionId, connectionRevision: binding.connectionRevision,
    libraryId: binding.libraryId, sharedProjectId: binding.sharedProjectId });
  const assertResetBinding = (binding: SharedProjectBinding) => {
    const live = resetBinding(binding.ownerId);
    if (live.connectionId !== binding.connectionId || live.connectionRevision !== binding.connectionRevision
      || live.libraryId !== binding.libraryId || live.sharedProjectId !== binding.sharedProjectId) throw new Error(sharedStorageErrorMessage('conflict'));
  };
  const acceptSnapshot = (snapshot: SharedAssetStorageSnapshot) => {
    set((state) => snapshot.revision >= (state.sharedAssetStorage?.revision ?? -1) ? { sharedAssetStorage: snapshot } : {});
  };
  const cancel = async (taskId: string) => {
    const operation = operations.get(taskId);
    if (!operation || operation.cancelled) return;
    operation.cancelled = true;
    await cancelSharedStorageTask(taskId);
  };
  const cancelConnection = (connectionId: string) => {
    for (const [id, operation] of operations) {
      if (operation.connectionId === connectionId) void cancel(id).catch(() => undefined);
    }
    for (const [ownerId, runtime] of syncRuns) {
      if (runtime.connectionId === connectionId) void cancelSync(ownerId);
    }
  };
  const execute = async (
    input: { taskId: string; ownerId: string; connectionId: string; connectionRevision: string },
    run: () => Promise<SharedProjectOperationResult>,
  ) => {
    requireOwner(input.ownerId);
    if (syncRuns.has(input.ownerId) || resetRuns.has(input.ownerId)) throw new Error(sharedStorageErrorMessage('busy'));
    const connection = get().sharedAssetStorage?.connections.find((item) => item.id === input.connectionId);
    if (!connection || connection.revision !== input.connectionRevision) throw new Error(sharedStorageErrorMessage('conflict'));
    if (!connection.credentialsSaved) throw new Error(sharedStorageErrorMessage('credentials_missing'));
    if (operations.has(input.taskId) || [...operations.values()].some((operation) => operation.ownerId === input.ownerId)) {
      throw new Error(sharedStorageErrorMessage('busy'));
    }
    const operation = { ownerId: input.ownerId, connectionId: input.connectionId, revision: input.connectionRevision, cancelled: false };
    operations.set(input.taskId, operation);
    unwatch ??= api.subscribe((state) => {
      for (const [id, pending] of operations) {
        const live = state.sharedAssetStorage?.connections.find((item) => item.id === pending.connectionId);
        if (currentOwner() !== pending.ownerId || live?.revision !== pending.revision) void cancel(id).catch(() => undefined);
      }
    });
    try {
      const result = await run();
      // 已提交的原生状态仍须对账；取消不会把正确的旧 owner 绑定搬到新项目。
      acceptSnapshot(result.snapshot);
      if (operation.cancelled) throw new Error(sharedStorageErrorMessage('cancelled'));
      requireOwner(input.ownerId);
      return result;
    } finally {
      operations.delete(input.taskId);
      if (operations.size === 0) { unwatch?.(); unwatch = undefined; }
    }
  };
  const ensureSettingsWritable = () => {
    if (areSettingsMutationsFrozen()) throw new Error('设置正在关闭，请稍后重试');
  };

  return {
    sharedAssetStorage: null,
    sharedAssetStorageLoading: false,
    sharedAssetSyncStatus: {},
    sharedProjectResetStatus: {},
    loadSharedProjectSyncState: async (ownerId) => {
      requireOwner(ownerId);
      const { projectAssetSyncService } = await import('../services/fs/sharedAssetSync');
      requireOwner(ownerId);
      const local = await projectAssetSyncService.readState(ownerId);
      requireOwner(ownerId);
      if (syncRuns.has(ownerId)) return;
      const binding = get().sharedAssetStorage?.bindings.find((entry) => entry.ownerId === ownerId);
      if (!binding) {
        updateSync(ownerId, { stage: 'idle', error: undefined, errorStage: undefined, lastSyncedAt: undefined, items: [], completed: 0, total: 0 });
        return;
      }
      const entries = local.outbox.filter((entry) => entry.connectionId === binding.connectionId
        && entry.connectionRevision === binding.connectionRevision && entry.libraryId === binding.libraryId
        && entry.sharedProjectId === binding.sharedProjectId && (entry.generation ?? 'legacy') === 'legacy');
      const complete = entries.filter((entry) => entry.phase === 'completed' && entry.errorCode !== 'ack_pending');
      const pending = entries.filter((entry) => entry.errorCode === 'ack_pending' || !['completed', 'conflict'].includes(entry.phase));
      updateSync(ownerId, { stage: pending.length ? 'paused' : 'idle', error: undefined, errorStage: undefined,
        lastSyncedAt: complete.length ? Math.max(...complete.map((entry) => entry.updatedAt)) : undefined,
        items: [], completed: 0, total: pending.length });
    },
    previewSharedProjectSync: async (ownerId) => {
      requireOwner(ownerId);
      if (syncRuns.get(ownerId)?.running || resetRuns.has(ownerId) || [...operations.values()].some((operation) => operation.ownerId === ownerId)) {
        throw new Error(sharedStorageErrorMessage('busy'));
      }
      await cancelSync(ownerId);
      requireOwner(ownerId);
      if (syncRuns.has(ownerId)) throw new Error(sharedStorageErrorMessage('busy'));
      const initial = get();
      const binding = initial.sharedAssetStorage?.bindings.find((item) => item.ownerId === ownerId);
      const connection = initial.sharedAssetStorage?.connections.find((item) => item.id === binding?.connectionId);
      if (!binding || !connection || binding.connectionRevision !== connection.revision || !binding.capabilities.multiplayerWritable) {
        throw new Error(sharedStorageErrorMessage('binding_not_found'));
      }
      const originProjectId = initial.currentProjectId!;
      const controller = new AbortController();
      const runtime: NonNullable<ReturnType<typeof syncRuns.get>> = {
        controller, tasks: new Set(), connectionId: connection.id, running: true,
        expectedLibrary: initial.dramaAssets, applying: false,
      };
      syncRuns.set(ownerId, runtime);
      const folders = JSON.stringify(initial.projects.map(({ id, parentId, dataFolder }) => ({ id, parentId, dataFolder })));
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        requireOwner(ownerId);
        const state = get();
        const live = state.sharedAssetStorage?.bindings.find((item) => item.ownerId === ownerId);
        const liveConnection = state.sharedAssetStorage?.connections.find((item) => item.id === binding.connectionId);
        if (state.currentProjectId !== originProjectId || state.config.baseDataDir !== initial.config.baseDataDir
          || live?.connectionRevision !== binding.connectionRevision || live.libraryId !== binding.libraryId
          || live.sharedProjectId !== binding.sharedProjectId || liveConnection?.revision !== connection.revision
          || JSON.stringify(state.projects.map(({ id, parentId, dataFolder }) => ({ id, parentId, dataFolder }))) !== folders
          || !runtime.applying && state.dramaAssets !== runtime.expectedLibrary) {
          throw new Error(sharedStorageErrorMessage('source_changed'));
        }
      };
      let unlisten: (() => void) | undefined;
      const unsubscribe = api.subscribe(() => {
        try { assertCurrent(); } catch { void cancelSync(ownerId); }
      });
      runtime.stop = () => { unsubscribe(); unlisten?.(); };
      updateSync(ownerId, { stage: 'scanning', items: [], error: undefined, errorStage: undefined, completed: 0, total: 0, progress: undefined });
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<SharedSyncProgress>('project-asset-sync-progress', ({ payload }) => {
          if (!controller.signal.aborted && payload.ownerId === ownerId && runtime.tasks.has(payload.taskId)
            && ['preparing', 'uploading', 'downloading', 'publishing'].includes(payload.phase)
            && Number.isSafeInteger(payload.totalBytes) && Number.isSafeInteger(payload.transferredBytes)
            && payload.transferredBytes >= 0 && payload.totalBytes >= payload.transferredBytes) {
            updateSync(ownerId, { progress: payload });
          }
        });
        assertCurrent();
        const { projectAssetSyncService } = await import('../services/fs/sharedAssetSync');
        assertCurrent();
        runtime.session = await projectAssetSyncService.preview({ binding, originProjectId, projects: initial.projects,
          library: initial.dramaAssets, nodes: initial.nodes, signal: controller.signal, assertCurrent,
          onStatus: (patch) => { if (!controller.signal.aborted) updateSync(ownerId, patch); },
          onTask: (taskId, active) => { if (active) runtime.tasks.add(taskId); else runtime.tasks.delete(taskId); },
        });
        assertCurrent();
        runtime.running = false;
        updateSync(ownerId, { stage: runtime.session.operations.length ? 'preview'
          : get().sharedAssetSyncStatus[ownerId]?.stage ?? 'idle', progress: undefined });
        if (!runtime.session.operations.length) {
          runtime.stop?.();
          if (syncRuns.get(ownerId) === runtime) syncRuns.delete(ownerId);
        }
      } catch (error) {
        runtime.stop?.();
        if (syncRuns.get(ownerId) === runtime) {
          syncRuns.delete(ownerId);
          updateSync(ownerId, { stage: controller.signal.aborted ? 'paused' : 'failed', progress: undefined,
            errorStage: controller.signal.aborted ? undefined : sharedStorageErrorStage(error),
            error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : '项目资产同步预览失败' });
        }
      }
    },
    syncSharedProjectNow: async (ownerId) => {
      requireOwner(ownerId);
      const runtime = syncRuns.get(ownerId);
      if (!runtime?.session || runtime.running || runtime.controller.signal.aborted) throw new Error('请先重新预览项目资产同步');
      runtime.running = true;
      updateSync(ownerId, { stage: 'syncing', completed: 0, error: undefined, errorStage: undefined });
      try {
        const { projectAssetSyncService } = await import('../services/fs/sharedAssetSync');
        await projectAssetSyncService.apply(runtime.session, {
          applyDownload: async ({ expectedLibrary, nextLibrary, commit }) => {
            runtime.applying = true;
            try {
              const result = await get().commitSharedAssetSyncDownload({ ownerId, originProjectId: runtime.session!.context.originProjectId,
                expectedLibrary, nextLibrary, commit, signal: runtime.controller.signal,
                assertCurrent: runtime.session!.context.assertCurrent });
              runtime.expectedLibrary = get().dramaAssets;
              return result;
            } finally { runtime.applying = false; }
          },
        });
        runtime.controller.signal.throwIfAborted();
        notifyProjectDiskChanged();
      } catch (error) {
        if (syncRuns.get(ownerId) === runtime) updateSync(ownerId, { stage: runtime.controller.signal.aborted ? 'paused' : 'failed', progress: undefined,
          errorStage: runtime.controller.signal.aborted ? undefined : sharedStorageErrorStage(error),
          error: runtime.controller.signal.aborted ? undefined : error instanceof Error ? error.message : '项目资产同步未完成，请恢复核对后重试' });
      } finally {
        runtime.stop?.();
        if (syncRuns.get(ownerId) === runtime) syncRuns.delete(ownerId);
      }
    },
    cancelSharedProjectSync: cancelSync,
    previewSharedProjectReset: async (ownerId, mode) => {
      if (!['clear', 'delete'].includes(mode)) throw new Error(sharedStorageErrorMessage('invalid_input'));
      if (resetRuns.has(ownerId) || syncRuns.has(ownerId) || [...operations.values()].some((operation) => operation.ownerId === ownerId)) throw new Error(sharedStorageErrorMessage('busy'));
      const binding = resetBinding(ownerId);
      const context = resetContext(binding);
      const runtime = { binding, mode, busy: true, taskId: context.taskId } as NonNullable<ReturnType<typeof resetRuns.get>>;
      let finish!: () => void;
      runtime.done = new Promise<void>((resolve) => { finish = resolve; });
      resetRuns.set(ownerId, runtime); resetStatus(ownerId, 'previewing');
      try {
        const preview = await previewNativeReset({ ...context, mode });
        assertResetBinding(binding);
        if (runtime.cancelRequested) throw new Error(sharedStorageErrorMessage('cancelled'));
        runtime.previewToken = preview.previewToken; runtime.busy = false; resetStatus(ownerId, 'preview');
        return preview;
      } catch (error) {
        resetRuns.delete(ownerId); resetStatus(ownerId, 'idle'); throw error;
      } finally { runtime.taskId = undefined; finish(); }
    },
    applySharedProjectReset: async (ownerId, mode, previewToken) => {
      const runtime = resetRuns.get(ownerId);
      if (!runtime || runtime.busy || runtime.mode !== mode || runtime.previewToken !== previewToken
        || get().sharedProjectResetStatus[ownerId]?.stage !== 'preview') throw new Error(sharedStorageErrorMessage('conflict'));
      assertResetBinding(runtime.binding);
      runtime.busy = true;
      const context = resetContext(runtime.binding); runtime.taskId = context.taskId;
      let finish!: () => void;
      runtime.done = new Promise<void>((resolve) => { finish = resolve; });
      resetStatus(ownerId, 'applying', { deletedCount: 0, totalCount: 0 });
      let unlisten: (() => void) | undefined;
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<SharedSyncProgress>('project-asset-sync-progress', ({ payload }) => {
          if (payload.ownerId === ownerId && payload.taskId === context.taskId && payload.phase === 'cleanup'
            && Number.isSafeInteger(payload.transferredBytes) && Number.isSafeInteger(payload.totalBytes)
            && payload.transferredBytes >= 0 && payload.totalBytes >= payload.transferredBytes) {
            resetStatus(ownerId, 'applying', { deletedCount: payload.transferredBytes, totalCount: payload.totalBytes });
          }
        });
        if (runtime.cancelRequested) throw new Error(sharedStorageErrorMessage('cancelled'));
        return await applyNativeReset({ ...context, mode, previewToken });
      } finally {
        unlisten?.(); resetRuns.delete(ownerId); resetStatus(ownerId, 'idle'); finish();
      }
    },
    cancelSharedProjectResetPreview: async (ownerId) => {
      const runtime = resetRuns.get(ownerId);
      if (!runtime) return;
      runtime.cancelRequested = true;
      if (runtime.taskId) await cancelSharedStorageTask(runtime.taskId).catch(() => undefined);
      if (runtime.busy) await runtime.done;
      else { resetRuns.delete(ownerId); resetStatus(ownerId, 'idle'); }
    },
    loadSharedAssetStorage: async () => {
      loads += 1;
      set({ sharedAssetStorageLoading: true });
      try { acceptSnapshot(await loadSharedStorageSnapshot()); }
      finally { loads -= 1; set({ sharedAssetStorageLoading: loads > 0 }); }
    },
    saveSharedStorageConnection: async (input) => {
      ensureSettingsWritable();
      if ([...resetRuns.values()].some((runtime) => runtime.binding.connectionId === input.connection.id)) throw new Error(sharedStorageErrorMessage('busy'));
      cancelConnection(input.connection.id);
      await enqueueConfigPersistence(async () => { acceptSnapshot(await saveSharedStorageConnection(input)); });
    },
    removeSharedStorageConnection: async (id, revision) => {
      ensureSettingsWritable();
      if ([...resetRuns.values()].some((runtime) => runtime.binding.connectionId === id)) throw new Error(sharedStorageErrorMessage('busy'));
      cancelConnection(id);
      await enqueueConfigPersistence(async () => { acceptSnapshot(await removeSharedStorageConnection(id, revision)); });
    },
    bindSharedProject: (input) => execute(input, () => bindSharedStorageProject(input)),
    probeSharedProject: async (input) => {
      requireOwner(input.ownerId);
      const binding = get().sharedAssetStorage?.bindings.find((item) => item.ownerId === input.ownerId);
      if (!binding) throw new Error(sharedStorageErrorMessage('binding_not_found'));
      return execute({ ...input, connectionId: binding.connectionId, connectionRevision: binding.connectionRevision },
        () => probeSharedStorageProject(input));
    },
    unbindSharedProject: async (ownerId, connectionRevision) => {
      if (resetRuns.has(ownerId)) throw new Error(sharedStorageErrorMessage('busy'));
      await cancelSync(ownerId);
      const state = get();
      // 已删除项目没有可进入的画布；设置中只可清理其本机绑定，不碰媒体或远端。
      const orphan = state.projectInitialized && state.projectLoadStatus === 'ready'
        && !state.projects.some((project) => project.id === ownerId);
      if (!orphan) requireOwner(ownerId);
      const binding = get().sharedAssetStorage?.bindings.find((item) => item.ownerId === ownerId && item.connectionRevision === connectionRevision);
      if (!binding) throw new Error(sharedStorageErrorMessage('conflict'));
      for (const [id, operation] of operations) if (operation.ownerId === ownerId) await cancel(id);
      acceptSnapshot(await unbindSharedStorageProject({
        ownerId, connectionRevision, libraryId: binding.libraryId, sharedProjectId: binding.sharedProjectId,
      }));
    },
    cancelSharedStorageOperation: cancel,
  };
};
