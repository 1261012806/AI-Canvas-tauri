import { useCallback, useDeferredValue, useEffect, useMemo, useState, type DragEvent } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import {
  comfyRefmodKey,
  loadComfyRefmodCatalog,
  resolveComfyRefmodServerIdentity,
} from '../../services/comfyRefmodService';
import { appendRefmodsToVideoNode } from '../../services/comfyRefmodNodeService';
import { COMFY_REFMOD_MIME, normalizeComfyRefmodAssets } from '../../utils/comfyRefmod';
import { mergeRefmodCatalogEntries, refmodMatchesQuery } from '../../utils/comfyRefmodAssets';
import type {
  ComfyRefmodAsset,
  ComfyRefmodCatalog,
  ComfyRefmodLoaderType,
  ComfyRefmodSelection,
  ComfyRefmodServerIdentity,
} from '../../types/comfyRefmod';
import Select from '../shared/Select';
import ViewportImage from '../shared/ViewportImage';

const DEFAULT_SERVER = '__default__';
const LOADER_LABELS: Record<ComfyRefmodLoaderType, string> = {
  'minimax-h3': 'MiniMax H3',
  'refmods-lab': 'RefMods Lab',
  'h3-refmods': 'H3 RefMods',
};
const EMPTY_KEYS: string[] = [];

interface RefmodBrowserProps {
  serverId?: string;
  lockServer?: boolean;
  loaderType?: ComfyRefmodLoaderType;
  selectedKeys?: string[];
  maxSelections?: number;
  compact?: boolean;
  editable?: boolean;
  draggable?: boolean;
  confirmLabel?: string;
  onConfirm: (items: ComfyRefmodSelection[]) => void | Promise<void>;
  onCountChange?: (count: number) => void;
  onDragStart?: () => void;
}

/** 资产页、角色绑定与视频槽位共用服务目录和文件身份。 */
export function RefmodCatalogBrowser({
  serverId,
  lockServer = false,
  loaderType,
  selectedKeys = EMPTY_KEYS,
  maxSelections = 8,
  compact = false,
  editable = false,
  draggable = false,
  confirmLabel = '添加所选参考包',
  onConfirm,
  onCountChange,
  onDragStart,
}: RefmodBrowserProps) {
  const { servers, defaultComfyUrl, savedAssets, projectCharacters, globalCharacters, currentProjectId } = useAppStore(useShallow((state) => ({
    servers: state.config.comfyServers,
    defaultComfyUrl: state.config.comfyUIUrl,
    savedAssets: state.config.comfyRefmodAssets,
    projectCharacters: state.dramaAssets.characters,
    globalCharacters: state.globalCharacters,
    currentProjectId: state.currentProjectId,
  })));
  const [chosenServer, setChosenServer] = useState(serverId ?? DEFAULT_SERVER);
  const actualServerId = lockServer ? serverId : chosenServer === DEFAULT_SERVER ? undefined : chosenServer;
  const [view, setView] = useState<{
    requestKey: string;
    identity: ComfyRefmodServerIdentity;
    catalog?: ComfyRefmodCatalog;
    error?: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [activeTag, setActiveTag] = useState('');
  const [visibleCount, setVisibleCount] = useState(48);
  const [selected, setSelected] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [saving, setSaving] = useState(false);
  const serverKey = actualServerId ?? DEFAULT_SERVER;
  // 地址只用于本轮请求的运行期身份；同 ID 修改地址时立即隐藏旧目录，不写入资产元数据。
  const endpointUrl = actualServerId ? servers?.find((server) => server.id === actualServerId)?.url ?? '' : defaultComfyUrl ?? '';
  const requestKey = JSON.stringify([serverKey, endpointUrl]);
  const currentView = view?.requestKey === requestKey ? view : undefined;

  useEffect(() => {
    const state = useAppStore.getState();
    if (!state.globalCharacters.length && !state.globalCharactersLoading) void state.loadGlobalCharacters();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setBusy(true);
      setMessage('');
      setSelected([]);
      setEditingKey(null);
      setVisibleCount(48);
      let identity: ComfyRefmodServerIdentity | undefined;
      try {
        identity = await resolveComfyRefmodServerIdentity(actualServerId);
        if (controller.signal.aborted) return;
        setView({ requestKey, identity });
        const catalog = await loadComfyRefmodCatalog(actualServerId, {
          signal: controller.signal,
          fresh: refreshVersion > 0,
        });
        if (controller.signal.aborted) return;
        setView({ requestKey, identity, catalog });
        const state = useAppStore.getState();
        const previous = state.config.comfyRefmodAssets ?? [];
        const next = normalizeComfyRefmodAssets(mergeRefmodCatalogEntries(previous, catalog.entries));
        const changed = JSON.stringify(previous) !== JSON.stringify(next);
        if (changed) state.updateConfig({ comfyRefmodAssets: next });
        if (changed || state.configSaveError) {
          try {
            await state.saveConfig({ silent: true, throwOnError: true });
          } catch {
            if (!controller.signal.aborted) setMessage('目录已读取，但参考包信息未保存。可稍后重试刷新。');
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const detail = error instanceof Error ? error.message : '读取参考包目录失败';
        if (identity) setView({ requestKey, identity, error: detail });
        else { setView(undefined); setMessage(detail); }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [actualServerId, refreshVersion, requestKey]);

  const entries = useMemo(() => {
    if (!currentView) return [];
    return mergeRefmodCatalogEntries(savedAssets ?? [], currentView.catalog?.entries ?? []).filter((entry) => (
      entry.serverId === currentView.identity.serverId
      && entry.endpointFingerprint === currentView.identity.endpointFingerprint
      && (!loaderType || entry.loaderType === loaderType)
    ));
  }, [savedAssets, currentView, loaderType]);
  const availableKeys = useMemo(() => new Set(currentView?.catalog?.entries.map(comfyRefmodKey) ?? []), [currentView]);
  const existingKeys = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const tags = useMemo(() => [...new Set(entries.flatMap((entry) => entry.tags))].sort(), [entries]);
  const visibleEntries = useMemo(() => entries.filter((entry) => (
    (!activeTag || entry.tags.includes(activeTag)) && refmodMatchesQuery(entry, deferredQuery)
  )), [entries, activeTag, deferredQuery]);
  const previews = useMemo(() => {
    const result = new Map<string, { url: string; projectId?: string | null; name: string }>();
    for (const [characters, projectId] of [[projectCharacters, currentProjectId], [globalCharacters, null]] as const) {
      for (const character of characters) {
        const reference = character.referenceImages?.find((image) => image.id === character.primaryReferenceImageId)
          ?? character.referenceImages?.[0];
        const url = reference?.imageUrl ?? character.imageUrl;
        if (!url) continue;
        for (const binding of character.refmods ?? []) {
          if (!result.has(comfyRefmodKey(binding))) result.set(comfyRefmodKey(binding), { url, projectId, name: character.name });
        }
      }
    }
    return result;
  }, [projectCharacters, globalCharacters, currentProjectId]);

  useEffect(() => { onCountChange?.(entries.length); }, [entries.length, onCountChange]);

  const toggle = (key: string) => {
    if (!availableKeys.has(key) || existingKeys.has(key)) return;
    setSelected((previous) => previous.includes(key) ? previous.filter((item) => item !== key)
      : maxSelections === 1 ? [key] : previous.length < maxSelections ? [...previous, key] : previous);
    setMessage('');
  };
  const selectionFor = (entry: ComfyRefmodAsset): ComfyRefmodSelection => ({
    serverId: entry.serverId,
    endpointFingerprint: entry.endpointFingerprint,
    loaderType: entry.loaderType,
    fileName: entry.fileName,
    strength: 1,
  });
  const confirm = async () => {
    const items = entries.filter((entry) => selectedSet.has(comfyRefmodKey(entry)) && availableKeys.has(comfyRefmodKey(entry))).map(selectionFor);
    if (!items.length || applying) return;
    setApplying(true); setMessage('');
    try { await onConfirm(items); setSelected([]); }
    catch (error) { setMessage(error instanceof Error ? error.message : '添加参考包失败'); }
    finally { setApplying(false); }
  };
  const saveMetadata = async (entry: ComfyRefmodAsset, updatedAt: number) => {
    if (!draftName.trim() || saving) return;
    setSaving(true); setMessage('');
    try {
      const state = useAppStore.getState();
      const key = comfyRefmodKey(entry);
      const updated = { ...entry, name: draftName.trim(), tags: draftTags.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean), updatedAt };
      const next = normalizeComfyRefmodAssets([
        ...(state.config.comfyRefmodAssets ?? []).filter((item) => comfyRefmodKey(item) !== key), updated,
      ]);
      state.updateConfig({ comfyRefmodAssets: next });
      await state.saveConfig({ silent: true, throwOnError: true });
      setEditingKey(null);
    } catch { setMessage('参考包信息保存失败，请重试。'); }
    finally { setSaving(false); }
  };
  const startDrag = (event: DragEvent, entry: ComfyRefmodAsset) => {
    if (!availableKeys.has(comfyRefmodKey(entry))) { event.preventDefault(); return; }
    event.stopPropagation();
    event.dataTransfer.setData(COMFY_REFMOD_MIME, JSON.stringify({ version: 1, items: [selectionFor(entry)] }));
    event.dataTransfer.effectAllowed = 'copy';
    onDragStart?.();
  };
  const serverOptions = [
    { value: DEFAULT_SERVER, label: '默认 ComfyUI 服务器' },
    ...(servers ?? []).map((server) => ({ value: server.id, label: server.name })),
  ];
  const displayedServer = lockServer ? serverId ?? DEFAULT_SERVER : chosenServer;
  if (!serverOptions.some((option) => option.value === displayedServer)) serverOptions.push({ value: displayedServer, label: '未配置的服务器' });

  return <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
    <div className="flex flex-wrap items-center gap-2">
      <Select className={compact ? 'w-full' : 'w-60'} value={displayedServer} disabled={lockServer || applying}
        aria-label="参考包所在服务器" options={serverOptions}
        onChange={(value) => { setChosenServer(value); setActiveTag(''); setVisibleCount(48); }} />
      <label className="relative min-w-40 flex-1">
        <span className="sr-only">搜索角色参考包</span>
        <input className="ui-input" value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(48); }} placeholder="搜索名称、文件名或标签" />
      </label>
      <button type="button" className="ui-btn ui-btn--secondary" disabled={busy || applying} onClick={() => setRefreshVersion((value) => value + 1)}>
        <Icon icon={busy ? 'mdi:loading' : 'mdi:refresh'} className={busy ? 'animate-spin' : ''} />{busy ? '读取中' : '刷新目录'}
      </button>
    </div>
    <p className="text-xs leading-relaxed text-canvas-text-muted">RefMod 是已编码的 H3 角色参考包。文件保留在对应 ComfyUI 服务器中，画布只保存引用。不同插件格式分别显示。</p>
    {tags.length > 0 && <div className="flex flex-wrap gap-1.5" aria-label="参考包标签">
      <button type="button" className={`ui-badge ${activeTag ? 'ui-badge--outline' : 'ui-badge--primary'}`} onClick={() => { setActiveTag(''); setVisibleCount(48); }}>全部标签</button>
      {tags.map((tag) => <button key={tag} type="button" className={`ui-badge ${activeTag === tag ? 'ui-badge--primary' : 'ui-badge--outline'}`} onClick={() => { setActiveTag(activeTag === tag ? '' : tag); setVisibleCount(48); }}>{tag}</button>)}
    </div>}
    {currentView?.error && <div className="ui-alert ui-alert--warning" role="status"><Icon icon="mdi:cloud-off-outline" /><span>{currentView.error} 已保存的参考包仍保留，连接恢复后刷新目录。</span></div>}
    {message && <div className="ui-alert ui-alert--warning" role="status"><Icon icon="mdi:alert-outline" /><span>{message}</span></div>}
    {currentView?.catalog?.warnings.map((warning) => <div key={warning} className="ui-alert ui-alert--info"><Icon icon="mdi:information-outline" /><span>{warning}</span></div>)}
    <div className="ui-scroll min-h-0 flex-1">
      {visibleEntries.length === 0 ? <div className="ui-empty">
        <Icon className="ui-empty__icon" icon={busy ? 'mdi:loading' : 'mdi:account-box-multiple-outline'} />
        <p className="ui-empty__title">{busy ? '正在读取角色参考包…' : query || activeTag ? '没有匹配的参考包' : '暂无角色参考包'}</p>
        <p className="ui-empty__desc">{query || activeTag ? '试试其他名称或标签。' : '先在对应 ComfyUI 中安装兼容的 RefMod 插件并保存参考包，再刷新目录。'}</p>
      </div> : <div className={`grid gap-2 ${compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'}`}>
        {visibleEntries.slice(0, visibleCount).map((entry) => {
          const key = comfyRefmodKey(entry);
          const available = availableKeys.has(key);
          const checked = selectedSet.has(key) || existingKeys.has(key);
          const preview = previews.get(key);
          const catalog = currentView?.catalog;
          const loaderFailed = catalog?.failedLoaderTypes?.includes(entry.loaderType);
          const loaderPresent = catalog?.loaders.some((loader) => loader.loaderType === entry.loaderType);
          const status = available ? '可用' : loaderFailed ? '目录读取失败'
            : catalog ? loaderPresent ? '文件缺失' : '加载器不可用'
              : currentView?.error ? '服务器离线' : '等待确认';
          return <article key={key} className={`ui-card min-w-0 p-2 ${checked ? 'is-selected' : ''}`}
            draggable={draggable && available && !applying} onDragStart={(event) => startDrag(event, entry)}>
            <label className="group relative mb-2 flex aspect-video cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-canvas-bg">
              {preview ? <ViewportImage className="h-full w-full object-cover" src={preview.url} projectId={preview.projectId} previewMaxEdge={256} draggable={false} alt={`${preview.name}角色参考图`} />
                : <Icon icon="mdi:account-box-outline" className="text-4xl text-canvas-text-muted" />}
              <input type="checkbox" className="absolute left-2 top-2 h-4 w-4 accent-brand" aria-label={`选择 ${entry.name}`} checked={checked}
                disabled={!available || existingKeys.has(key) || applying || (!checked && selected.length >= maxSelections)} onChange={() => toggle(key)} />
              <span className={`ui-badge absolute bottom-2 right-2 ${available ? 'ui-badge--success' : 'ui-badge--warning'}`}>{existingKeys.has(key) && available ? '已添加' : status}</span>
            </label>
            {editingKey === key ? <div className="space-y-2">
              <label className="ui-field"><span className="ui-label">名称</span><input className="ui-input" value={draftName} maxLength={120} onChange={(event) => setDraftName(event.target.value)} /></label>
              <label className="ui-field"><span className="ui-label">标签（逗号分隔）</span><input className="ui-input" value={draftTags} maxLength={600} onChange={(event) => setDraftTags(event.target.value)} /></label>
              <div className="flex justify-end gap-2"><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={saving} onClick={() => setEditingKey(null)}>取消</button><button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={!draftName.trim() || saving} onClick={() => void saveMetadata(entry, Date.now())}>保存</button></div>
            </div> : <>
              <div className="flex items-start gap-1"><h3 className="min-w-0 flex-1 break-words text-sm font-medium text-canvas-text">{entry.name}</h3>
                {editable && <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost" aria-label={`编辑 ${entry.name}`} onClick={() => { setEditingKey(key); setDraftName(entry.name); setDraftTags(entry.tags.join(', ')); }}><Icon icon="mdi:pencil-outline" /></button>}
              </div>
              <p className="mt-1 break-all text-xs text-canvas-text-muted" title={entry.fileName}>{entry.fileName}</p>
              <div className="mt-2 flex flex-wrap gap-1"><span className="ui-badge ui-badge--outline">{LOADER_LABELS[entry.loaderType]}</span>{entry.tags.map((tag) => <span key={tag} className="ui-badge">{tag}</span>)}</div>
              <p className="mt-2 truncate text-xs text-canvas-text-muted">{currentView?.identity.serverName}{preview ? ` · ${preview.name}` : ''}</p>
            </>}
          </article>;
        })}
      </div>}
      {visibleEntries.length > visibleCount && <div className="flex justify-center p-3"><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setVisibleCount((count) => count + 48)}>加载更多参考包（剩余 {visibleEntries.length - visibleCount} 个）</button></div>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-canvas-border pt-3">
      <span className="text-xs text-canvas-text-muted">{entries.length} 个参考包 · 已选择 {selected.length} / {maxSelections}{draggable ? ' · 可拖到 H3 视频节点' : ''}</span>
      <button type="button" className="ui-btn ui-btn--primary" disabled={!selected.length || applying || busy} onClick={() => void confirm()}><Icon icon={applying ? 'mdi:loading' : 'mdi:plus'} className={applying ? 'animate-spin' : ''} />{applying ? '添加中…' : confirmLabel}</button>
    </div>
  </div>;
}

export default function RefModAssetsPanel({ compact = false, onCountChange }: { compact?: boolean; onCountChange?: (count: number) => void }) {
  const { request, projectId, mode, nodes, selectedNodeIds } = useAppStore(useShallow((state) => ({
    request: state.assetsPanelRequest,
    projectId: state.currentProjectId,
    mode: state.assetsPanelMode,
    nodes: state.nodes,
    selectedNodeIds: state.selectedNodeIds,
  })));
  const videoNodes = useMemo(() => nodes.filter((node) => node.type === 'ai-video').map((node) => ({ id: node.id, label: node.data.label || '生成视频' })), [nodes]);
  const requestedNodeId = request?.tab === 'refmods' ? request.targetNodeId : undefined;
  const [chosenTarget, setChosenTarget] = useState('');
  const targetId = requestedNodeId ?? (chosenTarget || videoNodes.find((node) => selectedNodeIds.includes(node.id))?.id || '');
  const apply = useCallback(async (items: ComfyRefmodSelection[]) => {
    if (!targetId) throw new Error('请先选择要添加参考包的 H3 视频节点。');
    await appendRefmodsToVideoNode(targetId, items, request?.projectId ?? projectId ?? undefined);
    useAppStore.getState().showToast('角色参考包已添加，可在 @ → ComfyUI → ComfyUI 角色中查看手工绑定。', 'success');
  }, [targetId, request?.projectId, projectId]);
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b border-canvas-border p-3">
      <span className="text-xs text-canvas-text-secondary">添加到视频节点</span>
      <Select className="min-w-40 flex-1" value={targetId} disabled={!!requestedNodeId} aria-label="目标 H3 视频节点"
        options={[{ value: '', label: '选择 H3 视频节点' }, ...videoNodes.map((node) => ({ value: node.id, label: node.label }))]} onChange={setChosenTarget} />
    </div>
    <RefmodCatalogBrowser compact={compact} editable draggable onConfirm={apply} onCountChange={onCountChange}
      onDragStart={() => { if (mode === 'modal') window.setTimeout(() => useAppStore.getState().setAssetsPanelOpen(false), 0); }} />
  </div>;
}
