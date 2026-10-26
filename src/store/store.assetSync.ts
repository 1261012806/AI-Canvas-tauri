/** 项目云存储状态只由原生 catalog 投影；凭据、请求与取消句柄不进入 Store。 */
import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import { seriesOwnerId } from './store.utils';
import { areSettingsMutationsFrozen, enqueueConfigPersistence } from '../services/configPersistenceQueue';
import {
  bindSharedStorageProject, cancelSharedStorageTask, loadSharedStorageSnapshot,
  probeSharedStorageProject, removeSharedStorageConnection, saveSharedStorageConnection,
  sharedStorageErrorMessage, unbindSharedStorageProject,
} from '../services/fs/sharedAssetStorage';
import type {
  BindSharedProjectInput, ProbeSharedProjectInput, SaveSharedStorageConnectionInput,
  SharedAssetStorageSnapshot, SharedProjectOperationResult,
} from '../types/assetSync';

export interface AssetSyncSlice {
  sharedAssetStorage: SharedAssetStorageSnapshot | null;
  sharedAssetStorageLoading: boolean;
  loadSharedAssetStorage: () => Promise<void>;
  saveSharedStorageConnection: (input: SaveSharedStorageConnectionInput) => Promise<void>;
  removeSharedStorageConnection: (id: string, revision: string) => Promise<void>;
  bindSharedProject: (input: BindSharedProjectInput) => Promise<SharedProjectOperationResult>;
  probeSharedProject: (input: ProbeSharedProjectInput) => Promise<SharedProjectOperationResult>;
  unbindSharedProject: (ownerId: string, connectionRevision: string) => Promise<void>;
  cancelSharedStorageOperation: (taskId: string) => Promise<void>;
}

export const createAssetSyncSlice: StateCreator<AppState, [], [], AssetSyncSlice> = (set, get, api) => {
  const operations = new Map<string, { ownerId: string; connectionId: string; revision: string; cancelled: boolean }>();
  let unwatch: (() => void) | undefined;
  let loads = 0;

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
  };
  const execute = async (
    input: { taskId: string; ownerId: string; connectionId: string; connectionRevision: string },
    run: () => Promise<SharedProjectOperationResult>,
  ) => {
    requireOwner(input.ownerId);
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
    loadSharedAssetStorage: async () => {
      loads += 1;
      set({ sharedAssetStorageLoading: true });
      try { acceptSnapshot(await loadSharedStorageSnapshot()); }
      finally { loads -= 1; set({ sharedAssetStorageLoading: loads > 0 }); }
    },
    saveSharedStorageConnection: async (input) => {
      ensureSettingsWritable();
      cancelConnection(input.connection.id);
      await enqueueConfigPersistence(async () => { acceptSnapshot(await saveSharedStorageConnection(input)); });
    },
    removeSharedStorageConnection: async (id, revision) => {
      ensureSettingsWritable();
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
