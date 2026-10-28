import { useT } from '../../i18n';
import type { ComfyH3MemorySettings } from '../../types/comfyLaunch';
import { DEFAULT_COMFY_H3_MEMORY_SETTINGS, isValidComfyH3MemorySettings } from '../../types/comfyLaunch';
import Select from '../shared/Select';

interface Props {
  value: ComfyH3MemorySettings;
  disabled: boolean;
  onChange: (value: ComfyH3MemorySettings) => void;
}

export default function ComfyH3MemoryFields({ value, disabled, onChange }: Props) {
  const t = useT();
  const patch = <K extends keyof ComfyH3MemorySettings>(key: K, next: ComfyH3MemorySettings[K]) =>
    onChange({ ...value, [key]: next });
  const numbers = [
    { key: 'attentionHeadChunks', label: '注意力头分块', min: 1, max: 56, step: 1, hint: '范围 1–56；1 不按注意力头分组。' },
    { key: 'feedForwardChunks', label: '前馈网络分块', min: 1, max: 64, step: 1, hint: '范围 1–64；1 保持原工作流。' },
    { key: 'feedForwardThreshold', label: '前馈分块阈值', min: 256, max: 262144, step: 256, hint: '范围 256–262144，步长 256。' },
    { key: 'referenceImageMaxSize', label: '参考图片长边上限（px）', min: 0, max: 2048, step: 64, hint: '0 保持原工作流；其余范围 64–2048，步长 64。' },
  ] as const;

  return <div className="ui-card">
    <div className="ui-card__header"><h2 className="ui-card__title">{t('H3 工作流优化')}</h2></div>
    <div className="ui-card__body space-y-3">
      <div className="ui-field">
        <label className="ui-label" htmlFor="comfy-h3-memory-preset">{t('H3 低显存预设')}</label>
        <Select id="comfy-h3-memory-preset" value={value.preset} disabled={disabled} onChange={(next) => {
          const settings = { ...value, preset: next };
          onChange(next !== 'safe12' && (next === 'custom' || isValidComfyH3MemorySettings(settings)) ? settings : { ...DEFAULT_COMFY_H3_MEMORY_SETTINGS, preset: next });
        }} options={[
          { value: 'off', label: t('关闭 H3 优化') },
          { value: 'safe12', label: t('12GB 保守') },
          { value: 'custom', label: t('自定义 H3 优化') },
        ]} />
        <p className="ui-hint">{t('仅影响下次生成；输出分辨率与时长保持节点设置。')}</p>
      </div>
      {value.preset === 'safe12' && <div className="rounded-md border border-canvas-border p-2 space-y-1">
        <p className="text-sm font-medium text-canvas-text">{t('12GB 保守参数')}</p>
        <p className="ui-hint">{t('注意力头分 4 块；前馈分 2 块，阈值 4096；文本编码器使用 CPU。')}</p>
        <p className="ui-hint">{t('参考图片长边上限 512px；请求 VAE 空间块 256px、时间块 16 帧。')}</p>
        <p className="ui-hint">{t('减少显存峰值可能增加耗时与内存占用，仍受模型、素材和片长影响。')}</p>
      </div>}
      {value.preset === 'custom' && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {numbers.map((field) => <div key={field.key} className="ui-field">
          <label className="ui-label" htmlFor={`comfy-h3-${field.key}`}>{t(field.label)}</label>
          <input id={`comfy-h3-${field.key}`} className="ui-input" type="number" min={field.min} max={field.max} step={field.step} disabled={disabled}
            value={Number.isFinite(value[field.key]) ? value[field.key] : ''} onChange={(event) => patch(field.key, event.target.valueAsNumber)} />
          <p className="ui-hint">{t(field.hint)}</p>
        </div>)}
        <div className="ui-field">
          <label className="ui-label" htmlFor="comfy-h3-text-device">{t('H3 文本编码器设备')}</label>
          <Select id="comfy-h3-text-device" value={value.textEncoderDevice} disabled={disabled} onChange={(next) => patch('textEncoderDevice', next)} options={[
            { value: 'auto', label: t('保持原工作流') }, { value: 'cpu', label: 'CPU' },
          ]} />
        </div>
        <div className="ui-field">
          <span className="ui-label" id="comfy-h3-vae-label">{t('H3 VAE 分块解码')}</span>
          <button type="button" className="ui-switch" role="switch" aria-checked={value.vaeTiling} aria-labelledby="comfy-h3-vae-label" disabled={disabled} onClick={() => patch('vaeTiling', !value.vaeTiling)} />
          <p className="ui-hint">{t('关闭时保持原工作流中的 VAE 节点。')}</p>
        </div>
        {value.vaeTiling && <>
          <div className="ui-field">
            <label className="ui-label" htmlFor="comfy-h3-vae-tile">{t('VAE 空间块请求值（px）')}</label>
            <input id="comfy-h3-vae-tile" className="ui-input" type="number" min={128} max={2048} step={64} disabled={disabled} value={Number.isFinite(value.vaeTileSize) ? value.vaeTileSize : ''} onChange={(event) => patch('vaeTileSize', event.target.valueAsNumber)} />
            <p className="ui-hint">{t('范围 128–2048，步长 64。')}</p>
          </div>
          <div className="ui-field">
            <label className="ui-label" htmlFor="comfy-h3-vae-temporal">{t('VAE 时间块请求值（帧）')}</label>
            <input id="comfy-h3-vae-temporal" className="ui-input" type="number" min={8} max={128} step={4} disabled={disabled} value={Number.isFinite(value.vaeTemporalSize) ? value.vaeTemporalSize : ''} onChange={(event) => patch('vaeTemporalSize', event.target.valueAsNumber)} />
            <p className="ui-hint">{t('范围 8–128，步长 4。')}</p>
          </div>
        </>}
      </div>}
      {value.preset !== 'off' && value.vaeTiling && <div className="ui-alert ui-alert--warning"><p className="ui-alert__body">{t('H3 VAE 的部分版本使用内部固定分块，会忽略外部块参数；实际大小由后端实现决定。')}</p></div>}
      <p className="ui-hint">{t('常用设置仅自动应用于本机服务；远程服务需在节点中单独选择。节点设置可以覆盖此处。')}</p>
      {value.preset !== 'off' && <div className="ui-alert ui-alert--info"><div className="ui-alert__body space-y-1">
        <p>{t('仅处理可识别的 H3 工作流；需要的 KJNodes 等节点缺失或不兼容时会明确提示，不会自动安装。')}</p>
        <p>{t('不替换量化模型，也不调整输出分辨率与时长；封装节点内部的图无法保证覆盖。')}</p>
      </div></div>}
    </div>
  </div>;
}
