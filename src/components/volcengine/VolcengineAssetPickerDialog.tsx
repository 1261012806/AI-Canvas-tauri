import { useT } from '../../i18n';
import { getVolcengineAssetStatusLabel } from './volcengineAssetLabels';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import { useAppStore } from '../../store/useAppStore';
import { listAssetGroups, listAssets } from '../../services/ai/providers/volcengineAssetLibrary';
import { readAppSecret } from '../../services/providerSecretService';
import type { VolcengineAsset, VolcengineAssetGroup } from '../../types/volcengineAssetLibrary';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import ViewportImage from '../shared/ViewportImage';
import VideoThumbnail from '../shared/VideoThumbnail';
import Select from '../shared/Select';

const PAGE_SIZE = 20;
const ALL_ASSET_TYPES: Array<'Image' | 'Video' | 'Audio'> = ['Image', 'Video', 'Audio'];

export interface VolcengineAssetSelection {
  asset: VolcengineAsset;
  groupName?: string;
}

export default function VolcengineAssetPickerDialog({
  isOpen,
  selectedAssetIds,
  onClose,
  onConfirm,
  allowedAssetTypes = ALL_ASSET_TYPES,
  maxSelections,
}: {
  isOpen: boolean;
  selectedAssetIds: string[];
  onClose: () => void;
  onConfirm: (items: VolcengineAssetSelection[]) => void;
  allowedAssetTypes?: Array<'Image' | 'Video' | 'Audio'>;
  maxSelections?: number;
}) {
  const t = useT();
  const provider = useAppStore((state) => state.config.providers.volcengine
    || Object.values(state.config.providers).find((item) => item.catalogId === 'volcengine'));
  const library = provider?.assetLibrary;
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [groups, setGroups] = useState<VolcengineAssetGroup[]>([]);
  const [assets, setAssets] = useState<VolcengineAsset[]>([]);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Map<string, VolcengineAsset>>(new Map());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const projectName = library?.projectName?.trim() || 'default';
  const allowedAssetTypeKey = allowedAssetTypes.join(',');
  const options = useMemo(() => ({
    accessKeyId,
    secretAccessKey,
    projectName,
    region: library?.region || 'cn-beijing',
    baseUrl: library?.apiBaseUrl,
  }), [accessKeyId, secretAccessKey, library?.apiBaseUrl, library?.region, projectName]);

  useEffect(() => {
    let cancelled = false;
    const ref = (value: string | undefined, fallback: string) => (
      value?.startsWith('secret:') ? value.slice(7) : value || fallback
    );
    void Promise.all([
      readAppSecret(ref(library?.accessKeyIdRef, 'provider/volcengine/asset-library/access-key')),
      readAppSecret(ref(library?.secretAccessKeyRef, 'provider/volcengine/asset-library/secret-key')),
    ]).then(([ak, sk]) => {
      if (!cancelled) { setAccessKeyId(ak || ''); setSecretAccessKey(sk || ''); }
    });
    return () => { cancelled = true; };
  }, [library?.accessKeyIdRef, library?.secretAccessKeyRef]);

  const load = useCallback(async () => {
    if (!isOpen) return;
    if (!library?.enabled || !accessKeyId || !secretAccessKey) {
      setMessage('请先在火山方舟编辑连接中启用虚拟人像库并保存 AK/SK。');
      setAssets([]); setTotal(0); return;
    }
    setBusy(true); setMessage('');
    try {
      const [groupResult, assetResult] = await Promise.all([
        listAssetGroups(options, { pageNumber: 1, pageSize: 100 }),
        listAssets(options, selectedGroup || undefined, query.trim() || undefined, page, PAGE_SIZE),
      ]);
      setGroups(groupResult.items);
      const supportedItems = assetResult.items.filter((asset) => allowedAssetTypeKey.split(',').includes(asset.assetType || ''));
      setAssets(supportedItems);
      setTotal(assetResult.totalCount ?? supportedItems.length);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加载方舟素材失败');
    } finally { setBusy(false); }
  }, [accessKeyId, allowedAssetTypeKey, isOpen, library?.enabled, options, page, query, secretAccessKey, selectedGroup]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const existingIds = useMemo(() => new Set(selectedAssetIds), [selectedAssetIds]);
  const selectedNumber = (asset: VolcengineAsset) => {
    const type = asset.assetType?.toLowerCase() || 'image';
    const sameType = [...selected.values()].filter((item) => (item.assetType?.toLowerCase() || 'image') === type);
    const index = sameType.findIndex((item) => item.id === asset.id);
    if (index < 0) return undefined;
    return t('{kind}{index}', { kind: t(type === 'image' ? '图片' : type === 'video' ? '视频' : '音频'), index: index + 1 });
  };
  const groupedAssets = useMemo(() => {
    const result = new Map<string, VolcengineAsset[]>();
    assets.forEach((asset) => {
      const key = asset.groupId || 'unknown';
      result.set(key, [...(result.get(key) || []), asset]);
    });
    return [...result.entries()];
  }, [assets]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const toggle = (asset: VolcengineAsset) => {
    if (asset.status !== 'Active') return;
    if (existingIds.has(asset.id)) return;
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(asset.id)) next.delete(asset.id);
      else {
        if (maxSelections === 1) next.clear();
        next.set(asset.id, asset);
      }
      return next;
    });
  };
  const confirm = () => {
    onConfirm([...selected.values()].map((asset) => ({
      asset,
      groupName: asset.groupId ? groupsById.get(asset.groupId)?.name : undefined,
    })));
    setSelected(new Map());
  };
  const close = () => { setSelected(new Map()); onClose(); };

  return <ModalOverlay isOpen={isOpen} onClose={close} ariaLabel={t('选择火山方舟素材')} className="h-[min(82vh,44rem)] w-[min(92vw,58rem)]" closeOnBackdrop={false}>
    <div className="flex items-center justify-between border-b border-canvas-border px-2.5 py-2">
      <div><h2 className="ui-title">{t('选择火山方舟素材')}</h2><p className="mt-1 text-xs text-canvas-text-muted">{t('项目：{name} · 仅 Active 素材可用于 Seedance 2.0/2.5', { name: projectName })}</p></div>
      <PopupCloseButton onClick={close} ariaLabel={t('关闭')} />
    </div>
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <div className="flex gap-2">
        <Select className="max-w-56" value={selectedGroup} onChange={(value) => { setSelectedGroup(value); setPage(1); }} options={[{ value: '', label: t('全部素材组') }, ...groups.map((group) => ({ value: group.id, label: group.name }))]} fixedMenu />
        <input className="ui-input min-w-0 flex-1" placeholder={t('按素材名称搜索')} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
        <button type="button" className="ui-btn ui-btn--ghost" disabled={busy} onClick={() => void load()}><Icon icon="mdi:refresh" />{t('刷新')}</button>
      </div>
      {message && <div className="ui-alert ui-alert--warning mt-3"><Icon icon="mdi:alert-outline" width="18" /><span>{t(message)}</span></div>}
      <div className="mt-3 min-h-0 flex-1 space-y-4 overflow-auto pr-1">
        {groupedAssets.map(([groupId, items]) => <section key={groupId}><div className="mb-2 flex items-center gap-2 text-xs"><Icon icon="mdi:folder-outline" /><strong>{groupsById.get(groupId)?.name || t('未命名素材组')}</strong><span className="text-canvas-text-muted">{items.length}</span></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">{items.map((asset) => {
          const active = asset.status === 'Active'; const exists = existingIds.has(asset.id); const checked = selected.has(asset.id) || exists; const mediaType = asset.assetType?.toLowerCase();
          return <button key={asset.id} type="button" disabled={!active || exists} onClick={() => toggle(asset)} className={`overflow-hidden rounded-lg border text-left transition-colors ${checked ? 'border-brand bg-brand/10' : 'border-canvas-border bg-canvas-surface'} ${active && !exists ? 'hover:border-canvas-text-muted' : 'cursor-not-allowed opacity-50'}`}><div className="aspect-video overflow-hidden bg-canvas-bg">{mediaType === 'image' && asset.thumbnailUrl ? <ViewportImage src={asset.thumbnailUrl} alt={asset.name} className="h-full w-full object-cover" draggable={false} /> : mediaType === 'video' && asset.thumbnailUrl ? <VideoThumbnail src={asset.thumbnailUrl} name={asset.name} alt="" className="block h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center text-canvas-text-muted"><Icon icon={mediaType === 'audio' ? 'mdi:music-note-outline' : mediaType === 'video' ? 'mdi:video-outline' : 'mdi:image-outline'} width="28" /></span>}</div><div className="flex items-center gap-2 p-2"><span className="min-w-0 flex-1 truncate text-xs">{selectedNumber(asset) || (exists ? t('已添加') : asset.name)}</span><span className={active ? 'text-[10px] text-emerald-400' : 'text-[10px] text-canvas-text-muted'}>{exists ? t('已添加') : getVolcengineAssetStatusLabel(asset.status)}</span>{checked && <Icon icon="mdi:check-circle" className="text-brand" />}</div></button>;
        })}</div></section>)}
        {!busy && assets.length === 0 && !message && <div className="ui-empty"><Icon icon="mdi:account-box-outline" width="30" className="ui-empty__icon" /><p className="ui-empty__title">{t('没有可选素材')}</p></div>}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-canvas-border pt-3"><span className="text-xs text-canvas-text-muted">{t('第 {page} / {pages} 页 · 已选择 {count} 个', { page, pages, count: selected.size })}{maxSelections === 1 ? t('（仅可绑定一个）') : ''}</span><div className="flex gap-2"><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={page <= 1 || busy} onClick={() => setPage((value) => value - 1)}>{t('上一页')}</button><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={page >= pages || busy} onClick={() => setPage((value) => value + 1)}>{t('下一页')}</button><button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" onClick={close}>{t('取消')}</button><button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={selected.size === 0} onClick={confirm}>{t(maxSelections === 1 ? '绑定此素材' : '添加所选素材')}</button></div></div>
    </div>
  </ModalOverlay>;
}
