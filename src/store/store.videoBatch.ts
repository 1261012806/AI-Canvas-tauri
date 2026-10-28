import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { VideoBatch, VideoBatchItem, VideoPreflightItem } from '../types/videoBatch';
import { readVideoBatches, writeVideoBatches } from '../services/videoBatchRepository';
import { recoverVideoBatches, runVideoBatch } from '../services/videoBatchRunner';
import { checkVideoServices, inspectVideoNode, isComfyH3VideoNode } from '../services/videoBatchPlanning';
import { generateId } from './store.utils';
import type { GenerationLease } from '../services/generationService';

export interface VideoBatchSlice {
  videoBatches: Record<string, VideoBatch[]>;
  videoBatchBusy: boolean;
  loadVideoBatches: (projectId: string) => Promise<void>;
  startVideoBatch: (projectId: string, items: VideoPreflightItem[], lease?: GenerationLease) => Promise<VideoBatch>;
  cancelWaitingVideos: (projectId: string, batchId: string) => Promise<void>;
}

export const createVideoBatchSlice: StateCreator<AppState, [], [], VideoBatchSlice> = (set, get, api) => {
  let persistence: Promise<void> = Promise.resolve();
  const persist = (projectId: string) => {
    const snapshot = get().videoBatches[projectId] || [];
    const next = persistence.catch(() => undefined).then(() => writeVideoBatches(projectId, snapshot));
    persistence = next;
    return next;
  };
  const patch = async (projectId: string, batchId: string, nodeId: string, value: Partial<VideoBatchItem>) => {
    set((s) => ({ videoBatches: { ...s.videoBatches, [projectId]: (s.videoBatches[projectId] || []).map((b) => b.id !== batchId ? b
      : { ...b, items: b.items.map((i) => i.nodeId === nodeId ? { ...i, ...value } : i) }) } }));
    await persist(projectId);
  };
  return {
    videoBatches: {}, videoBatchBusy: false,
    loadVideoBatches: async (projectId) => {
      if (get().videoBatches[projectId]) return;
      const batches = recoverVideoBatches(await readVideoBatches(projectId));
      if (get().videoBatches[projectId]) return;
      set((s) => ({ videoBatches: { ...s.videoBatches, [projectId]: batches } }));
    },
    cancelWaitingVideos: async (projectId, batchId) => {
      set((s) => ({ videoBatches: { ...s.videoBatches, [projectId]: (s.videoBatches[projectId] || []).map((b) => b.id !== batchId ? b
        : { ...b, items: b.items.map((i) => i.status === 'waiting' ? { ...i, status: 'cancelled' as const, message: '已取消，未提交' } : i) }) } }));
      await persist(projectId);
    },
    startVideoBatch: async (projectId, items, lease) => {
      if (lease?.signal?.aborted) throw new Error('视频批次已取消，未提交');
      if (get().videoBatchBusy) throw new Error('已有视频批次正在执行');
      if (get().currentProjectId !== projectId || !items.length) throw new Error('项目或提交范围已变化');
      if (new Set(items.map((i) => i.nodeId)).size !== items.length) throw new Error('提交范围包含重复节点');
      set({ videoBatchBusy: true });
      let projectChanged = false;
      const unsubscribe = api.subscribe((state) => {
        if (state.currentProjectId !== projectId) projectChanged = true;
      });
      try {
        const hasGlobalAssetReferences = items.some((item) => {
          const data = get().nodes.find((node) => node.id === item.nodeId)?.data;
          return data && /@drama\{global\//.test(`${data.prompt || ''}\n${JSON.stringify(data.workflowInputs || {})}`);
        });
        if (hasGlobalAssetReferences) {
          await get().loadGlobalDramaAssets();
          if (lease?.signal?.aborted) throw new Error('视频批次已取消，未提交');
          if (projectChanged || get().currentProjectId !== projectId) throw new Error('项目已切换');
        }
        await get().loadVideoBatches(projectId);
        if (lease?.signal?.aborted) throw new Error('视频批次已取消，未提交');
        if (projectChanged || get().currentProjectId !== projectId) throw new Error('项目已切换');
        const h3Items = items.filter((item) => {
          const node = get().nodes.find((entry) => entry.id === item.nodeId);
          return node && isComfyH3VideoNode(node, get());
        });
        if (h3Items.some((item) => !item.comfyH3SettingsFingerprint)) throw new Error('H3 显存设置尚未检查，请重新检查视频批次');
        const h3Checked = h3Items.length ? await checkVideoServices(h3Items, get()) : [];
        if (lease?.signal?.aborted) throw new Error('视频批次已取消，未提交');
        if (projectChanged || get().currentProjectId !== projectId) throw new Error('项目已切换');
        if (h3Checked.some((fresh, index) => fresh.issues.length || !fresh.comfyH3SettingsFingerprint
          || fresh.comfyH3SettingsFingerprint !== h3Items[index].comfyH3SettingsFingerprint)) {
          throw new Error('H3 显存设置或服务已变化，请重新检查视频批次');
        }
        const h3Fingerprints = new Map(h3Checked.map((item) => [item.nodeId, item.comfyH3SettingsFingerprint]));
        for (const item of items) {
          const node = get().nodes.find((n) => n.id === item.nodeId);
          const fresh = node && inspectVideoNode(node, get());
          if (item.issues.length || !node || !fresh || fresh.issues.length || fresh.fingerprint !== item.fingerprint) throw new Error('物料或参数已变化，请重新检查');
          if (isComfyH3VideoNode(node, get()) !== h3Fingerprints.has(item.nodeId)) throw new Error('H3 工作流已变化，请重新检查视频批次');
        }
        const batch: VideoBatch = { id: generateId(), projectId, createdAt: Date.now(), items: items.map((i) => ({
          nodeId: i.nodeId, label: i.label, fingerprint: i.fingerprint, duration: i.duration, status: 'waiting',
          ...(h3Fingerprints.has(i.nodeId) ? { comfyH3SettingsFingerprint: h3Fingerprints.get(i.nodeId) } : {}),
        })) };
        set((s) => ({ videoBatches: { ...s.videoBatches, [projectId]: [...(s.videoBatches[projectId] || []), batch].slice(-30) } }));
        await persist(projectId);
        await runVideoBatch({
          projectId: () => projectChanged || lease?.signal?.aborted ? null : get().currentProjectId,
          read: () => get().videoBatches[projectId].find((b) => b.id === batch.id)!,
          update: (nodeId, value) => patch(projectId, batch.id, nodeId, value),
          inspect: (nodeId) => {
            const node = get().nodes.find((n) => n.id === nodeId);
            return node ? inspectVideoNode(node, get()) : null;
          },
          execute: async (nodeId) => {
            const { executeGeneration } = await import('../services/generationService');
            if (projectChanged || get().currentProjectId !== projectId) return { success: false, message: '项目已切换' };
            const expected = batch.items.find((item) => item.nodeId === nodeId)?.comfyH3SettingsFingerprint;
            if (expected !== undefined) return executeGeneration(nodeId, undefined, undefined, undefined, lease, { comfyH3ExpectedSettings: expected });
            return lease ? executeGeneration(nodeId, undefined, undefined, undefined, lease) : executeGeneration(nodeId);
          },
        });
        const completed = get().videoBatches[projectId]?.find((item) => item.id === batch.id);
        if (!completed) throw new Error('视频批次结果已不可用');
        return completed;
      } catch (error) {
        set((s) => ({ videoBatches: { ...s.videoBatches, [projectId]: recoverVideoBatches(s.videoBatches[projectId] || []) } }));
        await persist(projectId).catch(() => undefined);
        throw error;
      } finally { unsubscribe(); set({ videoBatchBusy: false }); }
    },
  };
};
