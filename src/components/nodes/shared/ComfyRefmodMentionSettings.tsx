import { useMemo, useState } from 'react';
import type { WorkflowDefinition } from '../../../types';
import type { ComfyRefmodAsset, ComfyRefmodCatalog, ComfyRefmodSelection } from '../../../types/comfyRefmod';
import { getComfyRefmodLoaders, isComfyRefmodSlotEmpty, isComfyRefmodSlotLinked } from '../../../services/comfyRefmodWorkflow';
import ModalOverlay from '../../shared/ModalOverlay';
import PopupCloseButton from '../../shared/PopupCloseButton';
import Select from '../../shared/Select';

interface Props {
  workflow: WorkflowDefinition;
  catalog?: ComfyRefmodCatalog;
  asset: ComfyRefmodAsset;
  initial?: ComfyRefmodSelection;
  existing: ComfyRefmodSelection[];
  manual: ComfyRefmodSelection[];
  loading: boolean;
  error?: string;
  refresh: () => void;
  onClose: () => void;
  onApply: (selection: ComfyRefmodSelection) => Promise<void>;
}

/** 只编辑一个引用，目标槽位与原值仍交给 fresh prepare 最终复核。 */
export default function ComfyRefmodMentionSettings({ workflow, catalog, asset, initial, existing, manual, loading, error, refresh, onClose, onApply }: Props) {
  const graph = useMemo(() => {
    if (!catalog) return { loaders: [], error: '' };
    try { return { loaders: getComfyRefmodLoaders(workflow, catalog).filter((loader) => loader.loaderType === asset.loaderType), error: '' }; }
    catch (cause) { return { loaders: [], error: cause instanceof Error ? cause.message : '无法读取工作流槽位' }; }
  }, [catalog, workflow, asset.loaderType]);
  const slots = graph.loaders.flatMap((loader) => loader.slots.map((slot) => ({
    key: `${loader.nodeId}:${slot.slot}`, loader, slot,
    linked: isComfyRefmodSlotLinked(loader, slot),
    occupied: existing.some((item) => item.loaderNodeId === loader.nodeId && item.slot === slot.slot),
  })));
  const initialKey = initial?.loaderNodeId && initial.slot !== undefined ? `${initial.loaderNodeId}:${initial.slot}` : '';
  const automatic = graph.loaders.length === 1 ? slots.find((item) => !item.linked && !item.occupied && item.slot.allowedNames.includes(asset.fileName)
    && item.loader.inputs[item.slot.fileField] === asset.fileName)
    ?? slots.find((item) => !item.linked && !item.occupied && item.slot.allowedNames.includes(asset.fileName) && isComfyRefmodSlotEmpty(item.loader, item.slot)) : undefined;
  const [targetKey, setTargetKey] = useState(initialKey || automatic?.key || '');
  const [explicit, setExplicit] = useState(initial?.replaceExisting === true);
  const target = slots.find((item) => item.key === targetKey);
  const [strength, setStrength] = useState(initial?.strength ?? automatic?.slot.strengthDefault ?? 1);
  const [applying, setApplying] = useState(false);
  const [issue, setIssue] = useState('');
  const original = target ? target.loader.inputs[target.slot.fileField] : undefined;
  const serverMismatch = !!catalog && (asset.serverId !== catalog.serverId || asset.endpointFingerprint !== catalog.endpointFingerprint);
  const occupiedMessage = target?.occupied ? manual.some((item) => item.loaderNodeId === target.loader.nodeId && item.slot === target.slot.slot)
    ? '该槽位已有手工绑定，请先在 ComfyUI 角色的“已绑定”列表移除，再调整提示词引用。'
    : '该槽位已有另一角色胶囊，请先删除冲突胶囊或选择其他槽位。' : '';
  const canApply = !!catalog && !!target && !target.linked && !target.occupied && target.slot.allowedNames.includes(asset.fileName)
    && !catalog.failedLoaderTypes?.includes(asset.loaderType) && !serverMismatch && !loading && !applying;

  return <ModalOverlay isOpen onClose={onClose} ariaLabel="ComfyUI 角色设置" className="w-[min(92vw,26rem)]" zIndex={10100} closeOnBackdrop={false} motionPreset="quick">
    <div className="flex items-start justify-between gap-2 border-b border-canvas-border p-3" data-reference-preview-open="">
      <div className="min-w-0"><h3 className="ui-title">ComfyUI 角色设置</h3><p className="mt-1 break-words text-xs text-canvas-text-secondary">{asset.name}</p></div>
      <PopupCloseButton onClick={onClose} ariaLabel="关闭角色设置" />
    </div>
    <div className="space-y-3 p-3">
      <p className="break-all text-xs text-canvas-text-muted">{asset.fileName}</p>
      <label className="ui-field"><span className="ui-label">工作流加载槽位</span>
        <Select aria-label="RefMod 目标槽位" value={targetKey} disabled={loading || applying}
          options={[{ value: '', label: graph.loaders.length > 1 ? '有多个加载节点，请明确选择槽位' : '请选择可用槽位' }, ...slots.map((item) => ({
            value: item.key,
            label: `${item.loader.label} / 槽位 ${item.slot.slot}${item.linked ? ' · 上游连线' : item.occupied ? ' · 已被引用占用' : ''}`,
            disabled: item.linked || item.occupied || !item.slot.allowedNames.includes(asset.fileName),
          }))]}
          onChange={(key) => {
            const next = slots.find((item) => item.key === key);
            setTargetKey(key); setExplicit(true); setIssue('');
            if (next) setStrength((value) => Math.min(next.slot.strengthMax ?? 10, Math.max(next.slot.strengthMin ?? 0, value)));
          }} />
      </label>
      {target && <p className="break-all text-xs text-canvas-text-muted">原值：{typeof original === 'string' && original ? original : '空槽'}{explicit && !isComfyRefmodSlotEmpty(target.loader, target.slot) && original !== asset.fileName ? '；本引用将替换该槽位原模型。' : ''}</p>}
      {target?.slot.strengthField ? <label className="ui-field"><span className="ui-label">参考强度</span>
        <input type="number" className="ui-input" aria-label="RefMod 参考强度" value={strength} disabled={applying}
          min={target.slot.strengthMin ?? 0} max={target.slot.strengthMax ?? 10} step={target.slot.strengthStep ?? 0.01}
          onChange={(event) => { if (event.target.value !== '') setStrength(Number(event.target.value)); }} />
      </label> : asset.loaderType === 'refmods-lab' && <p className="text-xs text-canvas-text-muted">Lab 参考强度沿用工作流内的 Combine 设置。</p>}
      {(issue || occupiedMessage || serverMismatch || error || graph.error) && <p className="ui-alert ui-alert--warning text-xs" role="alert">{issue || occupiedMessage || (serverMismatch ? '参考包所属服务器已改变，请删除后在当前服务器重新选择' : error || graph.error)}</p>}
      <p className="text-xs text-canvas-text-muted">只修改本次执行副本。删除提示词中的角色胶囊即可取消引用；连线控制的槽位请在 ComfyUI 中调整。</p>
    </div>
    <div className="flex items-center justify-end gap-2 border-t border-canvas-border p-3">
      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost mr-auto" disabled={loading || applying} onClick={refresh}>{loading ? '读取中…' : '刷新目录'}</button>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--secondary" onClick={onClose}>取消</button>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={!canApply} onClick={() => {
        if (!target || !canApply) return;
        const minimum = target.slot.strengthMin ?? 0;
        const maximum = target.slot.strengthMax ?? 10;
        if (!Number.isFinite(strength) || strength < minimum || strength > maximum) { setIssue(`强度必须在 ${minimum} 至 ${maximum} 之间`); return; }
        if (original !== undefined && typeof original !== 'string') { setIssue('原槽位不是文件名，请在 ComfyUI 中检查'); return; }
        setApplying(true); setIssue('');
        void onApply({ serverId: asset.serverId, endpointFingerprint: asset.endpointFingerprint, loaderType: asset.loaderType,
          fileName: asset.fileName, strength, loaderNodeId: target.loader.nodeId, slot: target.slot.slot,
          workflowId: workflow.id, originalFileName: typeof original === 'string' ? original : '',
          ...(explicit ? { replaceExisting: true } : {}),
        }).catch((cause) => setIssue(cause instanceof Error ? cause.message : '设置角色引用失败'))
          .finally(() => setApplying(false));
      }}>{applying ? '校验中…' : initial ? '更新引用' : '插入引用'}</button>
    </div>
  </ModalOverlay>;
}
