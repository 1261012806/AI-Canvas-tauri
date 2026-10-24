import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import { listUnavailableAssetIndexes, previewAssetRepair, type AssetRepairPreview, type AssetRepairTarget } from '../../services/fs/assetRepair';
import ModalOverlay from '../shared/ModalOverlay';

export type { AssetRepairTarget } from '../../services/fs/assetRepair';
interface AssetRepairDialogProps {
  target: AssetRepairTarget; onClose: () => void; onRepaired?: () => void;
}

export default function AssetRepairDialog(props: AssetRepairDialogProps) {
  const targetKey = JSON.stringify(props.target.kind === 'all' ? { kind: props.target.kind }
    : props.target.kind === 'file' ? { kind: props.target.kind, assetId: props.target.assetId, path: props.target.path, name: props.target.name }
      : { kind: props.target.kind, path: props.target.path, name: props.target.name });
  const target = useMemo(() => JSON.parse(targetKey) as AssetRepairTarget, [targetKey]);
  return <AssetRepairDialogContent key={targetKey} {...props} target={target} />;
}

function AssetRepairDialogContent({ target, onClose, onRepaired }: AssetRepairDialogProps) {
  const t = useT();
  const [preview, setPreview] = useState<AssetRepairPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); active.current = controller;
    void listUnavailableAssetIndexes(target, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setPreview({ target, ...result });
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '失效素材读取失败，请重试'); })
      .finally(() => { if (mounted.current && active.current === controller) setBusy(false); });
    return () => { mounted.current = false; controller.abort(); active.current?.abort(); };
  }, [target]);
  const choose = async (selection: AssetRepairTarget, replaceAll = false) => {
    if (busy) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError('');
    try {
      const result = await previewAssetRepair(selection, { signal: controller.signal });
      if (!result || controller.signal.aborted) return;
      setSelected([]);
      setPreview((previous) => replaceAll || !previous ? result : { ...previous, candidates: previous.candidates.map((candidate) =>
        result.candidates.find((item) => item.index.assetId === candidate.index.assetId) ?? candidate) });
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '素材预览失败，请重试'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const apply = async () => {
    if (busy || !preview || !selected.length) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError('');
    try {
      const count = await useAppStore.getState().repairAssetLocations(preview, selected, { signal: controller.signal });
      if (mounted.current) { useAppStore.getState().showToast(t('已重连 {count} 个素材，原文件保留', { count })); onRepaired?.(); onClose(); }
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '素材修复失败，请重新预览'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const items = preview?.candidates.filter((candidate) => candidate.status !== 'online') ?? [];
  return <ModalOverlay isOpen onClose={() => { if (!busy) onClose(); }} closeOnBackdrop={!busy} ariaLabel={t('重新定位素材')}
    className="w-[min(720px,calc(100vw-24px))] max-h-[80vh] p-3 gap-3" zIndex={375}>
    <h3 className="ui-title">{t('重新定位素材')}</h3>
    <p className="ui-hint">{t('请选择原文件或移动后的目录。不会按同名自动重连；原文件和旧路径保护均保留。')}</p>
    {target.kind !== 'all' && <button type="button" className="ui-btn ui-btn--ghost self-start" disabled={busy} onClick={() => void choose(target, true)}>
      {target.kind === 'folder' ? t('选择移动后的文件夹') : t('选择原文件')}</button>}
    {busy && <p role="status" className="ui-hint">{t('正在核对素材，请稍候…')}</p>}
    {preview && <>
      {preview.truncated && <p className="ui-alert ui-alert--warning">{t('扫描达到上限，仅展示本批结果；请按具体目录分批继续，未扫描项状态未知。')}</p>}
      <p className="ui-hint">{t('共 {count} 个待处理项，已选择 {selected} 项', { count: items.length, selected: selected.length })}</p>
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm self-start" disabled={busy}
        onClick={() => setSelected(items.filter((candidate) => candidate.status === 'ready' && candidate.match === 'hash').map((candidate) => candidate.index.assetId))}>{t('选择内容摘要一致项')}</button>
      <ul className="min-h-0 overflow-y-auto flex flex-col gap-2">
        {items.map((candidate) => <li key={candidate.index.assetId} className="ui-card p-2 flex items-center gap-2">
          <input type="checkbox" aria-label={t('确认修复 {name}', { name: candidate.index.path.split(/[\\/]/).pop() || '' })}
            disabled={busy || candidate.status !== 'ready'} checked={selected.includes(candidate.index.assetId)}
            onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, candidate.index.assetId] : previous.filter((id) => id !== candidate.index.assetId))} />
          <div className="min-w-0 flex-1"><p className="text-xs text-canvas-text break-words">{candidate.index.path.split(/[\\/]/).pop()}</p>
            <p className="text-xs text-canvas-text-muted break-all">{candidate.targetPath || candidate.index.path}</p>
            <p className="text-xs text-canvas-text-secondary">
              {candidate.message ? t(candidate.message) : candidate.status === 'missing' ? t('原文件未找到，请选择新位置') : t('无法自动重连，请检查文件')}</p></div>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm shrink-0" disabled={busy || candidate.status === 'error' && !candidate.targetPath}
            onClick={() => void choose({ kind: 'file', assetId: candidate.index.assetId, path: candidate.index.path, name: candidate.index.path.split(/[\\/]/).pop() || '' })}>{t('选择文件')}</button>
        </li>)}
      </ul>
      {items.length === 0 && !preview.truncated && <p className="ui-hint">{t('未发现可重连的失效索引；未登记的文件请重新导入')}</p>}
    </>}
    {error && <p role="alert" className="ui-alert ui-alert--danger">{t(error)}</p>}
    <div className="flex flex-wrap justify-end gap-2">
      {busy && <button type="button" className="ui-btn ui-btn--ghost" onClick={() => active.current?.abort()}>{t('取消操作')}</button>}
      <button type="button" className="ui-btn ui-btn--ghost" disabled={busy} onClick={onClose}>{t('关闭')}</button>
      <button type="button" className="ui-btn ui-btn--primary" disabled={busy || !selected.length} onClick={() => void apply()}>{t('确认重连所选素材')}</button>
    </div>
  </ModalOverlay>;
}
