/** 图片能力声明；候选按钮只用于编辑，不会自动成为模型支持的参数。 */
import { useState } from 'react';
import type { ProviderModelSelection } from '../../../types';
import type { ImageModelCapability } from '../../../types/aiTypes';
import { assertModelCapabilityProtocol, describeModelParameterGaps } from '../../../services/ai/modelCapabilityValidation';
import Select from '../../shared/Select';

interface Props {
  model: ProviderModelSelection;
  onChange: (capability: ImageModelCapability) => void;
  onClose: () => void;
}

export default function ImageCapabilityEditor({ model, onChange, onClose }: Props) {
  const capability = model.imageCapability ?? {};
  const [customResolution, setCustomResolution] = useState('');
  const [customRatio, setCustomRatio] = useState('');
  let error = '';
  try { assertModelCapabilityProtocol(model); } catch (reason) {
    error = reason instanceof Error ? reason.message : '图片参数声明无效';
  }
  const choose = (field: 'resolutions' | 'ratios', fallback: 'defaultResolution' | 'defaultRatio', value: string) => {
    const current = capability[field] ?? [];
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    onChange({ ...capability, [field]: next.length ? next : undefined,
      [fallback]: next.includes(capability[fallback] ?? '') ? capability[fallback] : undefined });
  };
  const booleanFields = [
    ['supportsBatch', '批量生成'], ['supportsImageReference', '参考图'],
    ['supportsDataUrlReference', 'Base64 参考图'],
  ] as const;
  return (
    <section className="ui-card p-3 space-y-3" aria-label={`${model.name} 图片参数能力`}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-canvas-text">{model.name} · 图片参数能力</h4>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onClose}>关闭</button>
      </div>
      <p className="text-xs text-canvas-text-secondary">按该渠道文档勾选。留空表示未声明；多选参数还须在调用协议中映射对应变量。</p>
      {([
        ['resolutions', 'defaultResolution', '分辨率', ['720p', '1K', '2K', '4K'], customResolution, setCustomResolution],
        ['ratios', 'defaultRatio', '比例', ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', 'auto'], customRatio, setCustomRatio],
      ] as const).map(([field, fallback, label, presets, custom, setCustom]) => (
        <div key={field} className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-canvas-text">{label}（可多选）</span>
            <label className="flex items-center gap-2 text-xs text-canvas-text-secondary">默认
              <Select fixedMenu size="sm" value={capability[fallback] ?? ''}
                onChange={(value) => onChange({ ...capability, [fallback]: value || undefined })}>
                <option value="">模型默认（未声明）</option>
                {capability[field]?.map((value) => <option key={value} value={value}>{value}</option>)}
              </Select>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {[...new Set([...presets, ...(capability[field] ?? [])])].map((value) => (
              <button key={value} type="button" aria-pressed={capability[field]?.includes(value) ?? false}
                className={`ui-btn ui-btn--sm ${capability[field]?.includes(value) ? 'is-active' : ''}`}
                onClick={() => choose(field, fallback, value)}>{value === 'auto' ? '自适应' : value}</button>
            ))}
            <input className="ui-input w-24" aria-label={`自定义${label}`} placeholder="自定义" value={custom}
              onChange={(event) => setCustom(event.target.value)} />
            <button type="button" className="ui-btn ui-btn--sm" aria-label={`添加自定义${label}`} onClick={() => {
              const value = custom.trim();
              if (value && !capability[field]?.includes(value)) choose(field, fallback, value);
              setCustom('');
            }}>+</button>
          </div>
        </div>
      ))}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {booleanFields.map(([field, label]) => (
          <label key={field} className="space-y-1 text-xs text-canvas-text-secondary">
            <span>{label}</span>
            <Select fixedMenu size="sm" value={capability[field] === undefined ? '' : String(capability[field])}
              onChange={(value) => onChange({ ...capability, [field]: value === '' ? undefined : value === 'true',
                ...(field === 'supportsBatch' && value === 'false' ? { maxBatchCount: 1 } : {}),
                ...(field === 'supportsImageReference' && value === 'false' ? { maxImageReferences: 0, supportsDataUrlReference: false } : {}),
              })}>
              <option value="">未声明</option><option value="true">支持</option><option value="false">不支持</option>
            </Select>
          </label>
        ))}
        {([['maxBatchCount', '单次生成上限'], ['maxImageReferences', '参考图数量上限']] as const).map(([field, label]) => (
          <label key={field} className="space-y-1 text-xs text-canvas-text-secondary">
            <span>{label}</span>
            <input className="ui-input w-full" type="number" min={field === 'maxBatchCount' ? 1 : 0}
              aria-label={label} placeholder="未声明" value={capability[field] ?? ''}
              onChange={(event) => onChange({ ...capability,
                [field]: event.target.value === '' ? undefined : Number(event.target.value) })} />
          </label>
        ))}
      </div>
      {describeModelParameterGaps(model) && <p className="text-xs text-canvas-text-muted">{describeModelParameterGaps(model)}</p>}
      {error && <p role="alert" className="text-xs text-canvas-text">{error}</p>}
    </section>
  );
}
