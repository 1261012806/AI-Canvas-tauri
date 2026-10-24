import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import { listUnavailableAssetIndexes, previewAssetRepair, type AssetRepairPreview, type AssetRepairTarget } from '../../services/fs/assetRepair';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import AssetUsageDialog, { type AssetUsageTarget } from './AssetUsageDialog';

export type { AssetRepairTarget } from '../../services/fs/assetRepair';
interface AssetRepairDialogProps {
  target: AssetRepairTarget; onClose: () => void; onRepaired?: () => void;
}
type RepairMode = 'repair' | 'cleanup';

export default function AssetRepairDialog(props: AssetRepairDialogProps) {
  const [mode, setMode] = useState<RepairMode>('repair');
  const [revision, setRevision] = useState(0);
  const targetKey = JSON.stringify(props.target.kind === 'all' ? { kind: props.target.kind }
    : props.target.kind === 'file' ? { kind: props.target.kind, assetId: props.target.assetId, path: props.target.path, name: props.target.name }
      : { kind: props.target.kind, path: props.target.path, name: props.target.name });
  const target = useMemo(() => JSON.parse(targetKey) as AssetRepairTarget, [targetKey]);
  return <AssetRepairDialogContent key={`${targetKey}:${mode}:${revision}`} {...props} target={target} mode={mode} onModeChange={setMode}
    onRefresh={() => setRevision((current) => current + 1)} />;
}

function AssetRepairDialogContent({ target, onClose, onRepaired, mode, onModeChange, onRefresh }: AssetRepairDialogProps & {
  mode: RepairMode; onModeChange: (mode: RepairMode) => void; onRefresh: () => void;
}) {
  const t = useT();
  const checkboxPrefix = useId();
  const cleanup = mode === 'cleanup';
  const [preview, setPreview] = useState<AssetRepairPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [cleanupTargets, setCleanupTargets] = useState<AssetUsageTarget[] | null>(null);
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
  const applyCleanup = async () => {
    if (busy || !preview || !cleanupTargets?.length) return;
    const ids = cleanupTargets.map((entry) => entry.kind === 'file' ? entry.assetId : undefined)
      .filter((id): id is string => !!id);
    const controller = new AbortController(); active.current = controller; setBusy(true); setError('');
    try {
      const count = await useAppStore.getState().cleanupMissingAssets(preview, ids, { signal: controller.signal });
      if (mounted.current) {
        setPreview((current) => current ? { ...current, candidates: current.candidates.filter((candidate) => !ids.includes(candidate.index.assetId)) } : current);
        setSelected([]);
        useAppStore.getState().showToast(t('已清理 {count} 个失效素材及关联信息', { count }));
        onRepaired?.();
      }
    } finally { if (mounted.current) setBusy(false); }
  };
  const items = preview?.candidates.filter((candidate) => candidate.status !== 'online') ?? [];
  const title = cleanup ? t('清理失效记录') : t('重新定位素材');
  return <><ModalOverlay isOpen onClose={() => { if (!busy && !cleanupTargets) onClose(); }} closeOnBackdrop={!busy && !cleanupTargets} ariaLabel={title}
    className="ui-dialog-surface w-[min(720px,calc(100vw-24px))] max-h-[80vh]" zIndex={375}>
    <header className="ui-card__header shrink-0">
      <div className="min-w-0 flex-1">
        <h3 className="ui-card__title">{title}</h3>
        <p className="ui-card__desc">{cleanup ? t('仅清理确认缺失的素材记录及关联信息，提交前会重新核对文件状态。')
          : t('请选择原文件或移动后的目录。不会按同名自动重连；原文件和旧路径保护均保留。')}</p>
      </div>
      <div className="ui-card__header-actions shrink-0">
        <PopupCloseButton disabled={busy} onClick={onClose} ariaLabel={t('关闭')} />
      </div>
    </header>
    <div className="ui-card__body min-h-0 min-w-0 flex-1 flex flex-col gap-3 overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
      <div className="ui-segmented" role="group" aria-label={t('素材处理方式')}>
        <button type="button" className={`ui-segmented__item ${!cleanup ? 'is-active' : ''}`} aria-pressed={!cleanup} disabled={busy}
          onClick={() => onModeChange('repair')}>{t('重连素材')}</button>
        <button type="button" className={`ui-segmented__item ${cleanup ? 'is-active' : ''}`} aria-pressed={cleanup} disabled={busy}
          onClick={() => onModeChange('cleanup')}>{t('清理失效记录')}</button>
      </div>
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={onRefresh}>{t('刷新')}</button>
      </div>
      {!cleanup && target.kind !== 'all' && <button type="button" className="ui-btn ui-btn--ghost self-start shrink-0" disabled={busy} onClick={() => void choose(target, true)}>
        {target.kind === 'folder' ? t('选择移动后的文件夹') : t('选择原文件')}</button>}
      {busy && <p role="status" className="ui-hint shrink-0">{t('正在核对素材，请稍候…')}</p>}
      {preview && <>
        {preview.truncated && <p className="ui-alert ui-alert--warning shrink-0">{t('扫描达到上限，仅展示本批结果；请按具体目录分批继续，未扫描项状态未知。')}</p>}
        <p className="ui-hint shrink-0">{t('共 {count} 个待处理项，已选择 {selected} 项', { count: items.length, selected: selected.length })}</p>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm self-start shrink-0" disabled={busy}
          onClick={() => setSelected(items.filter((candidate) => cleanup ? candidate.status === 'missing' : candidate.status === 'ready' && candidate.match === 'hash').map((candidate) => candidate.index.assetId))}>
          {cleanup ? t('选择全部缺失项') : t('选择内容摘要一致项')}</button>
        <ul className="ui-scroll min-h-0 min-w-0 flex-1 flex flex-col gap-2">
          {items.map((candidate) => <li key={candidate.index.assetId} className="ui-card shrink-0 p-2">
            <div className="flex min-w-0 items-center gap-2">
              <input id={`${checkboxPrefix}-${candidate.index.assetId}`} type="checkbox" className="ui-checkbox"
                aria-label={cleanup ? t('选择清理 {name}', { name: candidate.index.path.split(/[\\/]/).pop() || '' })
                  : t('确认修复 {name}', { name: candidate.index.path.split(/[\\/]/).pop() || '' })}
                disabled={busy || candidate.status !== (cleanup ? 'missing' : 'ready')} checked={selected.includes(candidate.index.assetId)}
                onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, candidate.index.assetId] : previous.filter((id) => id !== candidate.index.assetId))} />
              <label htmlFor={`${checkboxPrefix}-${candidate.index.assetId}`} className="min-w-0 flex-1">
                <span className="min-w-0 flex-1"><span className="block text-xs text-canvas-text break-words">{candidate.index.path.split(/[\\/]/).pop()}</span>
                  <span className="block text-xs text-canvas-text-muted break-all">{candidate.targetPath || candidate.index.path}</span>
                  <span className="block text-xs text-canvas-text-secondary">
                    {candidate.message ? t(candidate.message) : candidate.status === 'missing'
                      ? cleanup ? t('原文件未找到，可清理该记录') : t('原文件未找到，请选择新位置') : t('无法自动重连，请检查文件')}</span></span>
              </label>
              {!cleanup && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm shrink-0" disabled={busy || candidate.status === 'error' && !candidate.targetPath}
                onClick={() => void choose({ kind: 'file', assetId: candidate.index.assetId, path: candidate.index.path, name: candidate.index.path.split(/[\\/]/).pop() || '' })}>{t('选择文件')}</button>}
            </div>
          </li>)}
        </ul>
        {items.length === 0 && !preview.truncated && <p className="ui-hint shrink-0">{cleanup ? t('未发现可清理的失效记录') : t('未发现可重连的失效索引；未登记的文件请重新导入')}</p>}
        </>}
      {error && <p role="alert" className="ui-alert ui-alert--danger shrink-0">{t(error)}</p>}
    </div>
    <footer className="ui-card__footer min-w-0 shrink-0">
      <div className="ui-card__footer-actions flex-wrap justify-end">
        {busy && <button type="button" className="ui-btn ui-btn--ghost" onClick={() => active.current?.abort()}>{t('取消操作')}</button>}
        <button type="button" className="ui-btn ui-btn--ghost" disabled={busy} onClick={onClose}>{t('关闭')}</button>
        {cleanup ? <button type="button" className="ui-btn ui-btn--danger" disabled={busy || !selected.length} onClick={() => {
          setCleanupTargets(items.filter((candidate) => candidate.status === 'missing' && selected.includes(candidate.index.assetId))
            .map<AssetUsageTarget>(({ index }) => ({ kind: 'file', assetId: index.assetId, path: index.path, name: index.path.split(/[\\/]/).pop() || '' })));
        }}>{t('清理所选失效素材')}</button>
          : <button type="button" className="ui-btn ui-btn--primary" disabled={busy || !selected.length} onClick={() => void apply()}>{t('确认重连所选素材')}</button>}
      </div>
    </footer>
  </ModalOverlay>
    {cleanupTargets && <AssetUsageDialog targets={cleanupTargets} deletionMode="forget" onClose={() => setCleanupTargets(null)} onConfirmDelete={applyCleanup} />}
  </>;
}
