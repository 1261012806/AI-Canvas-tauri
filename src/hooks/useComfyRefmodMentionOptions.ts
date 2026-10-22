import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import type { WorkflowDefinition } from '../types';
import type { ComfyRefmodAsset, ComfyRefmodCatalog } from '../types/comfyRefmod';
import { loadComfyRefmodCatalog, loadComfyRefmodCatalogDetails } from '../services/comfyRefmodService';
import { getComfyRefmodLoaders } from '../services/comfyRefmodWorkflow';
import { buildComfyRefmodMentionEntries } from '../utils/comfyRefmodMentionOptions';

/** 仅在 @ 的 ComfyUI 分类展开时读取目标工作流服务器，不写入资产或画布。 */
export function useComfyRefmodMentionOptions({ enabled, workflow }: {
  enabled: boolean;
  workflow?: WorkflowDefinition;
}): {
  catalog?: ComfyRefmodCatalog;
  entries: Array<{ asset: ComfyRefmodAsset; thumbnailUrl?: string; characterName?: string }>;
  loading: boolean;
  error: string;
  refresh: () => void;
} {
  const { defaultUrl, servers, savedAssets, projectCharacters, globalCharacters, currentProjectId } = useAppStore(useShallow((state) => ({
    defaultUrl: state.config.comfyUIUrl,
    servers: state.config.comfyServers,
    savedAssets: state.config.comfyRefmodAssets,
    projectCharacters: state.dramaAssets.characters,
    globalCharacters: state.globalCharacters,
    currentProjectId: state.currentProjectId,
  })));
  const active = enabled && !!workflow && (!workflow.adapterType || workflow.adapterType === 'comfyui');
  const [revision, setRevision] = useState(0);
  const refreshedKey = useRef<string | undefined>(undefined);
  const [view, setView] = useState<{ requestKey: string; catalog?: ComfyRefmodCatalog; error?: string }>();
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  const serverId = workflow?.serverId;
  const endpoint = serverId === undefined ? defaultUrl ?? '' : servers?.find((server) => server.id === serverId)?.url ?? '';
  // 地址和项目只存在本轮运行期 key 中；配置变化时 render 即隐藏旧结果。
  const requestKey = JSON.stringify([currentProjectId, workflow?.id, serverId ?? null, endpoint, revision]);
  const currentView = active && view?.requestKey === requestKey ? view : undefined;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const fresh = revision > 0 && refreshedKey.current !== requestKey;
    if (fresh) refreshedKey.current = requestKey;
    void loadComfyRefmodCatalog(serverId, { signal: controller.signal, fresh, includeDetails: false }).then((catalog) => {
      if (controller.signal.aborted) return;
      setView({ requestKey, catalog });
      void loadComfyRefmodCatalogDetails(catalog, { signal: controller.signal, fresh }).then((detailed) => {
        if (!controller.signal.aborted) setView({ requestKey, catalog: detailed });
      }).catch(() => { /* 可选描述不阻断核心目录；下次刷新可重试。 */ });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setView({
        requestKey,
        error: cause instanceof Error ? cause.message : '读取 ComfyUI 角色参考包失败，请刷新目录后重试',
      });
    });
    return () => controller.abort();
  }, [active, requestKey, serverId, revision]);

  useEffect(() => {
    if (!active) return;
    const state = useAppStore.getState();
    if (!state.globalCharacters.length && !state.globalCharactersLoading) {
      void state.loadGlobalCharacters().catch(() => { /* 全局角色预览不阻断服务目录。 */ });
    }
  }, [active]);

  const prepared = useMemo(() => {
    const catalog = currentView?.catalog;
    if (!active || !workflow || !catalog) return { entries: [], error: '' };
    try {
      const loaders = getComfyRefmodLoaders(workflow, catalog);
      if (!loaders.length) return { entries: [], error: catalog.failedLoaderTypes?.length
        ? '读取工作流的 RefMod 加载器失败，请检查服务连接或刷新目录。'
        : '当前工作流没有兼容的 RefMod 加载器，请在 ComfyUI 中连接加载器并重新导入工作流。' };
      const entries = buildComfyRefmodMentionEntries({ catalog, loaders, savedAssets, projectCharacters, globalCharacters });
      return { entries, error: entries.length ? '' : '当前工作流的加载器没有可用的参考包，请在对应 ComfyUI 中保存 RefMod 后刷新目录。' };
    } catch (cause) {
      return { entries: [], error: cause instanceof Error ? cause.message : '读取 ComfyUI 工作流加载器失败' };
    }
  }, [active, currentView, workflow, savedAssets, projectCharacters, globalCharacters]);

  return {
    catalog: currentView?.catalog,
    entries: prepared.entries,
    loading: active && !currentView,
    error: !enabled ? '' : !active ? '请先选择本地 ComfyUI 工作流以使用角色参考包。' : currentView?.error || prepared.error,
    refresh,
  };
}
