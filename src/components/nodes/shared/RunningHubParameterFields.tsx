import type { RunningHubParameter } from '../../../types/runninghub';
import { resolveRunningHubParameters, runningHubParameterKey } from '../../../services/runninghubWorkflowService';
import { runningHubFrameRole, type RunningHubModelDefinition } from '../../../services/ai/providers/runninghubModelManifest';
import Select from '../../shared/Select';
import CloudWorkflowParameterField from './CloudWorkflowParameterField';

function frameBindingLabel(field: RunningHubModelDefinition['parameters'][number]): string | undefined {
  const role = runningHubFrameRole(field);
  if (role === 'last_frame') return '已设置的尾帧';
  if (role === 'first_frame') return '已设置的首帧';
  return undefined;
}

export function RunningHubModelParameterFields({ model, values = {}, onChange, disabled = false }: {
  model: RunningHubModelDefinition; values?: Record<string, string>;
  onChange: (values: Record<string, string>) => void; disabled?: boolean;
}) {
  return <div className="flex min-w-0 flex-col gap-3 text-xs text-canvas-text-secondary">
    <p className="break-all">{model.id} · <a className="underline" href={model.source} target="_blank" rel="noreferrer">官方参数说明</a></p>
    {model.parameters.map((field) => {
      const schema = field.schema;
      const value = values[field.name] ?? '';
      const omitted = values[field.name] === '';
      const frameBinding = frameBindingLabel(field);
      const defaultLabel = omitted ? '本次不传' : field.defaultValue === undefined
        ? frameBinding ? `使用${frameBinding}` : '自动填入引用或使用平台默认'
        : `默认：${String(field.defaultValue)}`;
      const options = schema.enum?.map(String) ?? (schema.type === 'boolean' ? ['true', 'false'] : undefined);
      const fixed = ['stream', 'enable_base64_output'].includes(field.name);
      const update = (next: string) => {
        const copy = { ...values };
        if (next === '') delete copy[field.name]; else copy[field.name] = next;
        onChange(copy);
      };
      return <label key={field.name} className="flex min-w-0 flex-col gap-1">
        <span className="break-words text-canvas-text">{field.label}{field.required ? ' *' : ''} {field.label !== field.name && <span className="text-canvas-text-muted">{field.name}</span>}</span>
        {field.binding === 'prompt' ? <span>使用上方提示词</span>
          : fixed ? <span>使用异步 URL 产物（false）</span>
            : options ? <Select className="w-full" fixedMenu aria-label={field.label} value={value} disabled={disabled} onChange={update}
              options={[{ value: '', label: defaultLabel }, ...options.map((option) => ({ value: option, label: option }))]} />
              : schema.type === 'number' || schema.type === 'integer' ? <input className="ui-input w-full" type="number" min={schema.minimum} max={schema.maximum} step={schema.multipleOf ?? (schema.type === 'integer' ? 1 : 'any')} placeholder={defaultLabel} value={value} disabled={disabled} onChange={(event) => update(event.target.value)} />
                : <textarea className="ui-textarea w-full" rows={2} placeholder={schema.type === 'array' ? `${defaultLabel}；手动填写 JSON 字符串数组` : defaultLabel} value={value} disabled={disabled} onChange={(event) => update(event.target.value)} />}
        {field.binding && field.binding !== 'prompt' && <span>{frameBinding
          ? `仅使用用户${frameBinding}；普通参考图不会自动代填。`
          : `自动使用${schema.type === 'array' ? '全部' : `第 ${(field.referenceIndex ?? 0) + 1} 个`}${({ image: '图片', video: '视频', audio: '音频' })[field.binding]}引用；填写后覆盖自动引用。`}</span>}
        {!field.required && field.defaultValue !== undefined && !fixed && <button type="button" className="ui-btn ui-btn--sm self-start" disabled={disabled} onClick={() => {
          if (omitted) update(''); else onChange({ ...values, [field.name]: '' });
        }}>{omitted ? '本次不传 · 点击恢复默认' : '本次不传此参数'}</button>}
        <span className="break-words text-canvas-text-muted">{[
          schema.minimum !== undefined || schema.maximum !== undefined ? `范围 ${schema.minimum ?? '不限'}–${schema.maximum ?? '不限'}` : '',
          schema.maxLength !== undefined ? `最多 ${schema.maxLength} 字符` : '',
          schema.maxItems !== undefined ? `最多 ${schema.maxItems} 项` : '',
        ].filter(Boolean).join(' · ')}</span>
        {field.hint && <details><summary className="cursor-pointer">参数说明</summary><p className="mt-1 whitespace-pre-wrap break-words">{field.hint}</p></details>}
      </label>;
    })}
  </div>;
}

export default function RunningHubParameterFields({ parameters, values = {}, onChange, disabled = false, appearance = 'form' }: {
  parameters: RunningHubParameter[];
  values?: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  disabled?: boolean;
  appearance?: 'form' | 'popover';
}) {
  if (appearance === 'popover') return <div className="flex min-w-0 flex-col gap-3">
    {resolveRunningHubParameters(parameters).filter((field) => field.source === 'value').map((field) => {
      const key = runningHubParameterKey(field);
      return <CloudWorkflowParameterField key={key} name={field.fieldName} label={field.label} type={field.type}
        value={values[key] ?? String(field.defaultValue)} defaultValue={field.defaultValue} options={field.options}
        min={field.min} max={field.max} step={field.step} multiline={field.multiline}
        required={field.required} disabled={disabled} onChange={(next) => onChange({ ...values, [key]: next })}
        onReset={values[key] === undefined ? undefined : () => {
          const next = { ...values }; delete next[key]; onChange(next);
        }} />;
    })}
  </div>;
  return <div className="flex min-w-0 flex-col gap-2">
    {parameters.map((field) => {
      const key = runningHubParameterKey(field);
      const value = values[key] ?? String(field.defaultValue);
      const options = field.options?.map(String) ?? (field.type === 'boolean' ? ['true', 'false'] : undefined);
      return <label key={key} className="flex min-w-0 flex-col gap-1 text-xs text-canvas-text-secondary">
        <span className="break-words">{field.label}{field.required ? ' *' : ''}</span>
        {field.source === 'prompt' ? <span>使用本次提示词</span>
          : field.source !== 'value' ? <span>使用第 {(field.referenceIndex ?? 0) + 1} 个{({ image: '图片', video: '视频', audio: '音频' })[field.source]}参考素材</span>
            : options?.length ? <Select className="w-full" fixedMenu aria-label={field.label} value={value} disabled={disabled}
              onChange={(next) => onChange({ ...values, [key]: next })}
              options={options.map((option) => ({ value: option, label: option }))} />
              : field.type === 'number' ? <input className="ui-input w-full" type="number" step="any" value={value} disabled={disabled} onChange={(event) => onChange({ ...values, [key]: event.target.value })} />
                : <textarea className="ui-textarea w-full" rows={2} value={value} disabled={disabled} onChange={(event) => onChange({ ...values, [key]: event.target.value })} />}
      </label>;
    })}
  </div>;
}
