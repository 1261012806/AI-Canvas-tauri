import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { AssetUsageReport, AssetUsageTarget } from '../../types/assetUsage';
import { loadAssetUsage, locateAssetUsage } from '../../services/assetUsageService';
import ModalOverlay from '../shared/ModalOverlay';

export type { AssetUsageTarget } from '../../types/assetUsage';
export interface AssetUsageDialogProps {
  target?: AssetUsageTarget;
  targets?: readonly AssetUsageTarget[];
  onClose: () => void;
  onConfirmDelete?: () => Promise<void>;
}

export default function AssetUsageDialog(props: AssetUsageDialogProps) {
  const queryKey = JSON.stringify((props.targets ?? (props.target ? [props.target] : [])).map((entry) => entry.kind === 'file'
    ? { kind: entry.kind, assetId: entry.assetId, path: entry.path, name: entry.name }
    : { kind: entry.kind, scope: entry.scope, assetKind: entry.assetKind, assetId: entry.assetId, ownerId: entry.ownerId, name: entry.name }));
  const query = useMemo(() => JSON.parse(queryKey) as AssetUsageTarget[], [queryKey]);
  return <AssetUsageDialogContent key={queryKey} {...props} query={query} />;
}

function AssetUsageDialogContent({ target, targets, onClose, onConfirmDelete, query }: AssetUsageDialogProps & { query: AssetUsageTarget[] }) {
  const t = useT();
  const [report, setReport] = useState<AssetUsageReport | null>(null);
  const [error, setError] = useState(query.length ? '' : '请选择需要查询的素材');
  const [busy, setBusy] = useState(query.length > 0);
  const [deleting, setDeleting] = useState(false);
  const [revision, setRevision] = useState(0);
  const lease = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); lease.current = controller;
    if (!query.length) return () => controller.abort();
    void loadAssetUsage(query, controller.signal).then((result) => { if (!controller.signal.aborted) setReport(result); })
      .catch(() => { if (!controller.signal.aborted) setError('使用位置读取失败，未执行删除，请重试'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [query, revision]);
  const confirm = async () => {
    if (busy || !report || !onConfirmDelete || !query.length) return;
    setBusy(true); setError('');
    const controller = lease.current;
    try {
      const fresh = await loadAssetUsage(query, controller?.signal);
      if (controller?.signal.aborted) return;
      if (fresh.signature !== report.signature) {
        setReport(fresh); setError('使用位置已变化，请核对后再次确认'); return;
      }
      setDeleting(true);
      await onConfirmDelete();
      if (!controller?.signal.aborted) onClose();
    } catch { if (!controller?.signal.aborted) setError('操作失败，未完成删除，请重试'); }
    finally { if (!controller?.signal.aborted) { setBusy(false); setDeleting(false); } }
  };
  const labels = { node: t('画布节点'), creative: t('创作资产'), history: t('生成历史'), chat: t('对话记录'),
    task: t('助手任务'), 'video-editor': t('剪辑工程'), workflow: t('工作流'), preset: t('预设'), 'image-details': t('图片信息关联') };
  return <ModalOverlay isOpen onClose={() => { if (!deleting) onClose(); }} closeOnBackdrop={!deleting}
    ariaLabel={t('素材使用位置')} className="w-[min(640px,calc(100vw-24px))] max-h-[80vh] p-3 gap-3" zIndex={370}>
    <h3 className="ui-title">{onConfirmDelete ? t('删除前查看影响') : t('素材使用位置')}</h3>
    <p className="text-sm break-words text-canvas-text">{targets ? t('已选择 {count} 项资产', { count: targets.length }) : target?.name}</p>
    {busy && !report ? <p role="status" className="ui-hint">{t('正在读取全部项目的使用位置…')}</p> : report && <>
      <p className="ui-hint">{t('找到 {count} 处使用位置', { count: report.locations.length })}</p>
      <ul className="min-h-0 overflow-y-auto flex flex-col gap-2">
        {report.locations.map((location) => <li key={location.key} className="ui-card flex items-center gap-2 p-2">
          <div className="min-w-0 flex-1"><p className="text-xs text-canvas-text break-words">{location.name}</p>
            <p className="text-xs text-canvas-text-muted">{location.projectName || t('全局')} · {labels[location.kind]}{location.live ? ` · ${t('当前画布')}` : ''}</p></div>
          {location.projectId && location.nodeId && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy}
            onClick={() => { setBusy(true); void locateAssetUsage(location, lease.current?.signal).then(onClose)
              .catch(() => setError('引用节点已不存在，请刷新使用位置')).finally(() => { if (!lease.current?.signal.aborted) setBusy(false); }); }}>{t('定位节点')}</button>}
        </li>)}
      </ul>
      {report.locations.length === 0 && <p className="ui-hint">{t('未发现已保存项目和当前画布中的引用')}</p>}
      {onConfirmDelete && <p className="ui-alert ui-alert--warning">{target?.kind === 'file'
        ? t('删除会移除原文件，以上引用可能失效。可从系统回收站恢复文件。')
        : t('删除只移除资产卡片，媒体文件保留；以上资产引用可能失效。')}</p>}
    </>}
    {error && <p role="alert" className="ui-alert ui-alert--danger">{t(error)}</p>}
    <div className="flex justify-end flex-wrap gap-2">
      <button type="button" className="ui-btn ui-btn--ghost" disabled={busy} onClick={() => {
        lease.current?.abort(); setReport(null); setError(query.length ? '' : '请选择需要查询的素材');
        setBusy(query.length > 0); setRevision((value) => value + 1);
      }}>{t('刷新')}</button>
      <button type="button" className="ui-btn ui-btn--ghost" disabled={deleting} onClick={onClose}>{t('关闭')}</button>
      {onConfirmDelete && <button type="button" className="ui-btn ui-btn--danger" disabled={busy || !report} onClick={() => void confirm()}>{busy ? t('处理中…') : t('确认删除')}</button>}
    </div>
  </ModalOverlay>;
}
