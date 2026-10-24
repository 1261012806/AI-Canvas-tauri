import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Star, Trash2, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { CharacterLibraryScope } from '../../store/store.dramaAssets';
import type { DramaAssetReferenceImage, DramaProp, DramaScene } from '../../types/dramaAssets';
import { MAX_DRAMA_REFERENCE_IMAGES, normalizeDramaVisualAsset } from '../../types/dramaAssets';
import { uploadSourceFileToProject } from '../../services/fileService';
import { seriesOwnerId } from '../../store/store.utils';
import { confirmAction } from '../../services/confirmDialog';
import { useT } from '../../i18n';
import ModalOverlay from '../shared/ModalOverlay';
import Select from '../shared/Select';

/** 场景、道具共用参考图管理器；主图只是兼容投影，单图引用保持自己的稳定 ID。 */
export default function DramaVisualReferencesDialog({ asset, scope, onClose }: {
  asset: DramaScene | DramaProp;
  scope: CharacterLibraryScope;
  onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(() => normalizeDramaVisualAsset(asset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nodeId, setNodeId] = useState('');
  const initialProjectId = useRef(useAppStore.getState().currentProjectId);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const nodes = useAppStore((state) => state.nodes);
  const imageNodes = nodes.filter((node) => ['ai-image', 'source-image', 'ai-panorama', 'ai-storyboard', 'ai-animation'].includes(node.type ?? '')
    && Boolean(node.data.imageUrl || node.data.thumbnailUrl));
  const references = draft.referenceImages ?? [];
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useAppStore.subscribe((state) => {
      if (!state.assetsPanelOpen || scope === 'project' && state.currentProjectId !== initialProjectId.current) operation.current?.abort();
    });
    return () => { mounted.current = false; operation.current?.abort(); unsubscribe(); };
  }, [scope]);
  const assertCurrent = () => {
    if (!mounted.current || operation.current?.signal.aborted) throw new Error('操作已取消');
    const state = useAppStore.getState();
    if (scope === 'project' && state.currentProjectId !== initialProjectId.current) throw new Error('项目已切换');
    const current = (scope === 'global' ? asset.kind === 'scene' ? state.globalScenes : state.globalProps
      : asset.kind === 'scene' ? state.dramaAssets.scenes : state.dramaAssets.props).find((item) => item.id === asset.id);
    if (current !== asset) throw new Error('资产已变化，请关闭后重新打开');
    if (references.some((reference) => reference.sourceNodeId) && state.currentProjectId !== initialProjectId.current) throw new Error('项目已切换');
  };
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    operation.current = new AbortController();
    try { assertCurrent(); await action(); }
    catch { if (mounted.current && !operation.current.signal.aborted) setError(t('参考图操作失败，请检查资产是否已变化后重试')); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const addReference = (reference: DramaAssetReferenceImage) => setDraft((current) => ({ ...current,
    referenceImages: [...(current.referenceImages ?? []), reference],
    primaryReferenceImageId: current.primaryReferenceImageId ?? reference.id,
  }));
  const upload = () => void run(async () => {
    if (references.length >= MAX_DRAMA_REFERENCE_IMAGES) return;
    const state = useAppStore.getState();
    const ownerId = scope === 'project' && state.currentProjectId ? seriesOwnerId(state.projects, state.currentProjectId) : null;
    const selected = await uploadSourceFileToProject('.png,.jpg,.jpeg,.webp,.gif,.bmp', ownerId, ownerId ? 'Library' : undefined);
    assertCurrent();
    if (!selected) return;
    const now = Date.now();
    addReference({ id: crypto.randomUUID(), label: selected.fileName.replace(/\.[^.]+$/, ''), prompt: '',
      imageUrl: selected.dataUrl, filePath: selected.filePath, createdAt: now, updatedAt: now });
  });
  const close = () => { if (!pending.current) onClose(); };
  return <ModalOverlay isOpen onClose={close} closeOnBackdrop={!busy} ariaLabel={t('管理参考图')}
    className="w-[min(760px,calc(100vw-24px))] max-h-[85vh] p-3 gap-3" zIndex={340}>
    <div className="flex items-center gap-2">
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-canvas-text">{asset.name} · {t('参考图')}</h3>
      <span className="text-xs text-canvas-text-secondary">{references.length}/{MAX_DRAMA_REFERENCE_IMAGES}</span>
      <button type="button" className="ui-icon-btn ui-icon-btn--sm" disabled={busy} onClick={close} aria-label={t('关闭')}><X size={16} /></button>
    </div>
    <p className="text-xs text-canvas-text-secondary">{t('给参考图标注角度、时段或细节；@ 时可选择其中一张。')}</p>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy || references.length >= MAX_DRAMA_REFERENCE_IMAGES} onClick={upload}>
        <ImagePlus size={14} />{t('上传参考图')}</button>
      <Select value={nodeId} size="sm" className="min-w-0 w-48" disabled={busy}
        aria-label={t('选择画布图片')} options={[{ value: '', label: t('选择画布图片') }, ...imageNodes.map((node) => ({ value: node.id, label: node.data.label || node.id }))]}
        onChange={setNodeId} />
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy || !nodeId || references.length >= MAX_DRAMA_REFERENCE_IMAGES}
        onClick={() => { const node = imageNodes.find((item) => item.id === nodeId); if (!node) return;
          const now = Date.now(); addReference({ id: crypto.randomUUID(), label: node.data.label || '', prompt: node.data.prompt || '',
            sourceNodeId: node.id, assetId: node.data.assetId, relativePath: node.data.relativePath, filePath: node.data.filePath,
            imageUrl: node.data.imageUrl || node.data.thumbnailUrl, createdAt: now, updatedAt: now }); setNodeId('');
        }}>{t('添加图片')}</button>
    </div>
    <div className="min-h-0 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2">
      {references.map((reference, index) => <div key={reference.id} className="ui-card p-2 flex gap-2">
        <div className="w-24 h-24 shrink-0 rounded-lg overflow-hidden bg-canvas-bg flex items-center justify-center">
          {reference.imageUrl ? <img src={reference.imageUrl} alt={reference.label || t('参考图 {number}', { number: index + 1 })} className="w-full h-full object-contain" />
            : <span className="text-xs text-canvas-text-secondary">{t('图片不可用')}</span>}
        </div>
        <div className="min-w-0 flex-1 flex flex-col gap-2">
          <input className="ui-input ui-input--sm w-full" disabled={busy} maxLength={120} value={reference.label} aria-label={t('参考图标题')}
            placeholder={t('角度、时段或细节')} onChange={(event) => setDraft((current) => ({ ...current,
              referenceImages: current.referenceImages?.map((item) => item.id === reference.id ? { ...item, label: event.target.value, updatedAt: Date.now() } : item) }))} />
          <textarea className="ui-textarea w-full text-xs" disabled={busy} rows={2} maxLength={4000} value={reference.prompt} aria-label={t('参考图说明')}
            placeholder={t('参考图说明')} onChange={(event) => setDraft((current) => ({ ...current,
              referenceImages: current.referenceImages?.map((item) => item.id === reference.id ? { ...item, prompt: event.target.value, updatedAt: Date.now() } : item) }))} />
          <div className="flex items-center gap-2">
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || draft.primaryReferenceImageId === reference.id}
              onClick={() => setDraft((current) => ({ ...current, primaryReferenceImageId: reference.id }))}>
              <Star size={12} />{t(draft.primaryReferenceImageId === reference.id ? '主图' : '设为主图')}</button>
            <button type="button" className="ui-icon-btn ui-icon-btn--sm ml-auto" disabled={busy} aria-label={t('移除参考图')}
              onClick={() => void confirmAction(t('移除这张参考图？已有的单图 @ 引用将失效，原文件会保留。'), { title: t('移除参考图') }).then((confirmed) => {
                if (!confirmed || pending.current || !mounted.current) return;
                setDraft((current) => { const next = current.referenceImages?.filter((item) => item.id !== reference.id) ?? [];
                  return { ...current, referenceImages: next, primaryReferenceImageId: current.primaryReferenceImageId === reference.id ? next[0]?.id : current.primaryReferenceImageId }; });
              })}><Trash2 size={14} /></button>
          </div>
        </div>
      </div>)}
      {!references.length && <p className="text-sm text-canvas-text-secondary py-3">{t('暂无参考图')}</p>}
    </div>
    {error && <p className="ui-alert ui-alert--warning" role="alert">{error}</p>}
    <div className="flex justify-end gap-2">
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy} onClick={close}>{t('取消')}</button>
      <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy} onClick={() => void run(async () => {
        assertCurrent();
        const saved = await useAppStore.getState().saveDramaVisualAsset(scope, { ...draft, updatedAt: Date.now() }, {
          signal: operation.current?.signal, assertCurrent,
        });
        if (saved && mounted.current) onClose(); else if (mounted.current) setError(t('参考图保存失败，素材文件已保留，请重试'));
      })}>{t(busy ? '保存中…' : '保存')}</button>
    </div>
  </ModalOverlay>;
}
