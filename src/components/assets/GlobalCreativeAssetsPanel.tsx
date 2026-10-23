import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { generateId } from '../../store/store.utils';
import type { DramaAsset, DramaAssetKind, DramaCharacter } from '../../types/dramaAssets';
import { DRAMA_ASSET_KIND_LABEL } from '../../types/dramaAssets';
import { normalizeAssetKey } from '../../services/dramaAssetExtract';
import { formatDramaAssetTextBrief } from '../../services/dramaAssetPrompt';
import { confirmAction } from '../../services/confirmDialog';
import { getAssetUrlFromPath, uploadSourceFileToProject, type AssetFileEntry } from '../../services/fileService';
import { DramaAssetCard } from '../DramaAssetsPanel';
import ModalOverlay from '../shared/ModalOverlay';
import Select from '../shared/Select';

const CharacterAssetDialog = lazy(() => import('../CharacterAssetDialog'));

function globalAssets(kind: DramaAssetKind): DramaAsset[] {
  const state = useAppStore.getState();
  return kind === 'character' ? state.globalCharacters : kind === 'scene' ? state.globalScenes : state.globalProps;
}

function newAsset(kind: DramaAssetKind, name: string): DramaAsset {
  const now = Date.now();
  const base = {
    id: `${kind}-${generateId()}`, name, key: normalizeAssetKey(name), summary: '', visualNotes: '',
    importance: 'supporting' as const, confirmed: true, createdAt: now, updatedAt: now, source: 'manual' as const,
  };
  if (kind === 'character') return { ...base, kind, identity: '' };
  if (kind === 'scene') return { ...base, kind };
  return { ...base, kind };
}

/** 场景与道具使用创作资产卡片；人物继续打开已有角色编辑器。 */
function GlobalAssetEditor({ asset, creating, onClose }: { asset: DramaAsset; creating: boolean; onClose: () => void }) {
  const [name, setName] = useState(asset.name);
  const [summary, setSummary] = useState(asset.summary);
  const [visualNotes, setVisualNotes] = useState(asset.visualNotes);
  const [storyRole, setStoryRole] = useState(asset.storyRole ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const close = () => { if (!pending.current) onClose(); };
  return <ModalOverlay isOpen onClose={close} closeOnBackdrop={!saving} ariaLabel={`编辑全局${DRAMA_ASSET_KIND_LABEL[asset.kind]}`}
    className="w-[min(480px,calc(100vw-24px))] p-3 gap-3">
    <h3 className="text-sm font-semibold text-canvas-text">{creating ? '新增' : '编辑'}全局{DRAMA_ASSET_KIND_LABEL[asset.kind]}</h3>
    <form className="flex flex-col gap-3" onSubmit={(event) => {
      event.preventDefault();
      if (pending.current || !name.trim()) return;
      pending.current = true; setSaving(true); setError('');
      const request = new AbortController(); controller.current = request;
      const latest = globalAssets(asset.kind).find((item) => item.id === asset.id);
      if (!creating && !latest) {
        pending.current = false; setSaving(false); setError('资产已删除，请关闭后重新选择'); return;
      }
      void useAppStore.getState().saveGlobalDramaAsset({
        ...(latest ?? asset), name: name.trim(), key: normalizeAssetKey(name), summary: summary.trim(),
        visualNotes: visualNotes.trim(), storyRole: storyRole.trim() || undefined, updatedAt: Date.now(),
      }, { signal: request.signal }).then((saved) => {
        if (!request.signal.aborted) { if (saved) onClose(); else setError('保存失败，修改仍保留，请重试'); }
      }).catch(() => { if (!request.signal.aborted) setError('保存失败，修改仍保留，请重试'); })
        .finally(() => { pending.current = false; if (!request.signal.aborted) setSaving(false); });
    }}>
      <label className="flex flex-col gap-1 text-xs text-canvas-text-secondary">名称
        <input autoFocus className="ui-input" value={name} disabled={saving} required onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-canvas-text-secondary">简介
        <textarea className="ui-textarea" rows={3} value={summary} disabled={saving} onChange={(event) => setSummary(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-canvas-text-secondary">外形 / 视觉要点
        <textarea className="ui-textarea" rows={3} value={visualNotes} disabled={saving} onChange={(event) => setVisualNotes(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-canvas-text-secondary">剧情功能（可选）
        <input className="ui-input" value={storyRole} disabled={saving} onChange={(event) => setStoryRole(event.target.value)} />
      </label>
      {error && <p role="alert" className="ui-alert ui-alert--danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="ui-btn ui-btn--ghost" disabled={saving} onClick={close}>取消</button>
        <button type="submit" className="ui-btn ui-btn--primary" disabled={saving || !name.trim()}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </form>
  </ModalOverlay>;
}

/** 从文件创建或追加创作资产；文件身份与人物身份独立，不移动原文件。 */
export function GlobalCreativeAssetFileDialog({ file, kind, onClose, onSaved }: {
  file: AssetFileEntry; kind: DramaAssetKind; onClose: () => void; onSaved: () => void;
}) {
  const cards = useAppStore(useShallow((state) => kind === 'character' ? state.globalCharacters
    : kind === 'scene' ? state.globalScenes : state.globalProps));
  const [targetId, setTargetId] = useState('');
  const [name, setName] = useState(file.name.replace(/\.[^.]+$/, ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const close = () => { if (!pending.current) onClose(); };
  const save = async () => {
    if (pending.current || (!targetId && !name.trim())) return;
    pending.current = true; setSaving(true); setError('');
    const request = new AbortController(); controller.current = request;
    try {
      if (!file.assetId || file.availability === 'offline') throw new Error('素材不可用，请刷新文件列表后重试');
      const url = file.assetUrl || await getAssetUrlFromPath(file.path);
      if (request.signal.aborted) return;
      const existing = targetId ? globalAssets(kind).find((item) => item.id === targetId) : undefined;
      if (targetId && !existing) throw new Error('目标资产已删除，请重新选择');
      let asset = existing ?? newAsset(kind, name.trim());
      if (asset.kind === 'character') {
        const referenceId = `reference-${generateId()}`;
        const references = asset.referenceImages ?? [];
        const reference = references.find((item) => item.assetId === file.assetId);
        asset = { ...asset, referenceImages: reference ? references : [...references, {
          id: referenceId, kind: 'primary', assetId: file.assetId, imageUrl: url, prompt: '',
          createdAt: Date.now(), updatedAt: Date.now(),
        }], primaryReferenceImageId: asset.primaryReferenceImageId ?? reference?.id ?? referenceId };
      } else {
        asset = { ...asset, imageAssetId: file.assetId, imageUrl: url, imageNodeId: undefined };
      }
      if (!await useAppStore.getState().saveGlobalDramaAsset(asset, { signal: request.signal })) throw new Error('保存失败，文件和原资产仍保留，请重试');
      if (!request.signal.aborted) onSaved();
    } catch (reason) {
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : '添加失败，请重试');
    } finally { pending.current = false; if (!request.signal.aborted) setSaving(false); }
  };
  return <ModalOverlay isOpen onClose={close} closeOnBackdrop={!saving} ariaLabel={`添加到全局${DRAMA_ASSET_KIND_LABEL[kind]}`}
    className="w-[min(440px,calc(100vw-24px))] p-3 gap-3">
    <h3 className="text-sm font-semibold text-canvas-text">添加到全局{DRAMA_ASSET_KIND_LABEL[kind]}</h3>
    <p className="truncate text-xs text-canvas-text-secondary" title={file.name}>{file.name}</p>
    <label className="flex flex-col gap-1 text-xs text-canvas-text-secondary">添加方式
      <Select value={targetId} disabled={saving} fixedMenu onChange={setTargetId}
        options={[{ value: '', label: `新建${DRAMA_ASSET_KIND_LABEL[kind]}` }, ...cards.map((asset) => ({ value: asset.id, label: `添加到 ${asset.name}` }))]} />
    </label>
    {!targetId && <label className="flex flex-col gap-1 text-xs text-canvas-text-secondary">名称
      <input autoFocus className="ui-input" value={name} disabled={saving} onChange={(event) => setName(event.target.value)} />
    </label>}
    {targetId && kind !== 'character' && <p className="ui-hint">将替换所选资产的主图，原图片文件仍保留。</p>}
    {error && <p role="alert" className="ui-alert ui-alert--danger">{error}</p>}
    <div className="flex justify-end gap-2">
      <button type="button" className="ui-btn ui-btn--ghost" disabled={saving} onClick={close}>取消</button>
      <button type="button" className="ui-btn ui-btn--primary" disabled={saving || (!targetId && !name.trim())} onClick={() => void save()}>
        {saving ? '添加中…' : '添加'}
      </button>
    </div>
  </ModalOverlay>;
}

export default function GlobalCreativeAssetsPanel({ kind, compact }: { kind: DramaAssetKind; compact: boolean }) {
  const { characters, scenes, props, loading, loadError, nodes, currentProjectId, load, save, remove, bind, openCharacters, showToast } = useAppStore(useShallow((state) => ({
    characters: state.globalCharacters, scenes: state.globalScenes, props: state.globalProps,
    loading: state.globalDramaAssetsLoading, loadError: state.globalDramaAssetsError, nodes: state.nodes,
    currentProjectId: state.currentProjectId, load: state.loadGlobalDramaAssets, save: state.saveGlobalDramaAsset,
    remove: state.deleteGlobalDramaAsset, bind: state.bindGlobalDramaAssetImage,
    openCharacters: state.setCharacterLibraryOpen, showToast: state.showToast,
  })));
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{ asset: DramaAsset; creating: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const source = kind === 'character' ? characters : kind === 'scene' ? scenes : props;
  const items = useMemo(() => {
    const query = search.trim().toLowerCase();
    return source.filter((asset) => !query || [asset.name, asset.summary, asset.visualNotes].some((text) => text.toLowerCase().includes(query)));
  }, [source, search]);
  const imageNodes = useMemo(() => nodes.filter((node) => ['ai-image', 'source-image', 'ai-panorama', 'ai-storyboard'].includes(node.type ?? '')
    && Boolean(node.data.imageUrl || node.data.thumbnailUrl)).map((node) => ({ id: node.id, label: node.data.label || node.data.fileName || node.id })), [nodes]);
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true);
    try { await action(controller.signal); }
    catch { if (!controller.signal.aborted) showToast('操作失败，请重试', 'error'); }
    finally { if (operation.current === controller) { operation.current = null; if (!controller.signal.aborted) setBusy(false); } }
  };
  const upload = (asset?: DramaAsset) => run(async (signal) => {
    const selected = await uploadSourceFileToProject('.png,.jpg,.jpeg,.webp,.gif,.bmp', null);
    if (!selected || signal.aborted) return;
    const latest = asset ? globalAssets(asset.kind).find((item) => item.id === asset.id) : newAsset(kind, selected.fileName.replace(/\.[^.]+$/, ''));
    if (!latest) return;
    if (latest.kind === 'character') {
      const referenceId = `reference-${generateId()}`;
      if (!await save({ ...latest, referenceImages: [...(latest.referenceImages ?? []), {
        id: referenceId, kind: 'primary', imageUrl: selected.dataUrl, prompt: '', createdAt: Date.now(), updatedAt: Date.now(),
      }], primaryReferenceImageId: latest.primaryReferenceImageId ?? referenceId }, { signal })) return;
    } else if (!await save({ ...latest, imageUrl: selected.dataUrl, imageAssetId: undefined, imageRelativePath: undefined, imageNodeId: undefined }, { signal })) return;
    if (!signal.aborted) showToast('已添加到全局创作资产');
  });
  const handleCopyToProject = (asset: DramaAsset) => {
    const state = useAppStore.getState();
    if (!state.currentProjectId || state.currentProjectId === 'default') return;
    if (asset.kind === 'character') {
      if (!state.copyGlobalCharacterToProject(asset.id)) return;
    } else {
      const { id, createdAt, updatedAt } = newAsset(asset.kind, asset.name);
      state.upsertDramaAsset({ ...asset, id, imageNodeId: undefined, createdAt, updatedAt });
    }
    showToast('已复制到本项目');
  };
  return <div className={`flex min-h-0 min-w-0 flex-1 flex-col${compact ? ' drama-assets--compact' : ''}`}>
    <div className="flex flex-wrap items-center gap-2 p-3">
      <h3 className="text-sm font-medium text-canvas-text">全局{DRAMA_ASSET_KIND_LABEL[kind]} <span className="text-canvas-text-muted">{source.length}</span></h3>
      <input className="ui-input ui-input--sm ml-auto w-44" aria-label="搜索全局创作资产" placeholder="搜索名称、简介…" value={search} onChange={(event) => setSearch(event.target.value)} />
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || loading || Boolean(loadError)} onClick={() => void upload()}>
        <Icon icon="lucide:upload" aria-hidden="true" />上传图片
      </button>
      <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || loading || Boolean(loadError)} onClick={() => setEditing({ asset: newAsset(kind, ''), creating: true })}>
        <Icon icon="lucide:plus" aria-hidden="true" />新增{DRAMA_ASSET_KIND_LABEL[kind]}
      </button>
    </div>
    {loading ? <p role="status" className="p-3 text-xs text-canvas-text-muted">正在加载全局创作资产…</p>
      : loadError ? <div role="alert" className="p-3"><p className="ui-alert ui-alert--danger">{loadError}</p>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm mt-2" onClick={() => { void load().catch(() => {}); }}>重试加载</button></div>
        : <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3${items.length ? ' drama-assets-grid' : ''}`}>
          {items.length === 0 ? <div role="status" className="flex flex-col items-center gap-2 p-3 text-xs text-canvas-text-muted">
            <p>{search ? '没有匹配的资产' : `暂无全局${DRAMA_ASSET_KIND_LABEL[kind]}`}</p>
            <p>可新建资产、上传图片，或从文件右键菜单添加；保存后可跨项目使用。</p>
          </div> : items.map((asset) => <DramaAssetCard key={asset.id} asset={asset} thumb={asset.imageUrl}
            imageNodes={imageNodes} editing={false} uploading={busy} manageUploadedImage
            onOpen={asset.kind === 'character' ? () => openCharacters(true, { scope: 'global', characterId: asset.id, origin: 'assets' }) : undefined}
            onToggleEdit={() => setEditing({ asset, creating: false })}
            onSaveFields={() => {}}
            onDelete={() => void run(async (signal) => {
              if (await confirmAction(`删除全局${DRAMA_ASSET_KIND_LABEL[kind]}「${asset.name}」？共用图片、声音和动作文件将保留。`, { title: '删除创作资产' }) && !signal.aborted) await remove(kind, asset.id, { signal });
            })}
            onBindImage={(nodeId) => void run(async (signal) => { if (await bind(kind, asset.id, nodeId, { signal }) && !signal.aborted) showToast('已绑定全局资产图片'); })}
            onUploadImage={() => void upload(asset)}
            onCopyBrief={() => { void navigator.clipboard.writeText(formatDramaAssetTextBrief(asset)).then(() => showToast('简介已复制')).catch(() => showToast('复制失败', 'error')); }}
            onManageVoice={asset.kind === 'character' ? () => openCharacters(true, { scope: 'global', characterId: asset.id, section: 'voice', origin: 'assets' }) : undefined}
            onManageActions={asset.kind === 'character' ? () => openCharacters(true, { scope: 'global', characterId: asset.id, section: 'action', origin: 'assets' }) : undefined}
            onCopyToScope={currentProjectId && currentProjectId !== 'default' ? () => handleCopyToProject(asset) : undefined} copyToScopeLabel="复制到本项目" />)}
        </div>}
    {editing && (editing.asset.kind === 'character' ? <Suspense fallback={<p role="status" className="p-3 text-xs text-canvas-text-muted">正在打开角色编辑器…</p>}>
      <CharacterAssetDialog key={editing.asset.id} isOpen scope="global" character={editing.creating ? null : editing.asset as DramaCharacter}
        onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />
    </Suspense> : <GlobalAssetEditor key={editing.asset.id} asset={editing.asset} creating={editing.creating} onClose={() => setEditing(null)} />)}
  </div>;
}
