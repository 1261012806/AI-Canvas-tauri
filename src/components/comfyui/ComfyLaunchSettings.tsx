import { useEffect, useState } from 'react';
import { Icon } from '@iconify/react';
import Select from '../shared/Select';
import { useT } from '../../i18n';
import type { ComfyUILaunchSettings } from '../../types/comfyLaunch';
import { DEFAULT_COMFY_LAUNCH_SETTINGS, isValidComfyLaunchSettings } from '../../types/comfyLaunch';
import { getComfyLaunchSettings, saveComfyLaunchSettings } from '../../services/comfyLaunchSettingsService';
import ComfyH3MemoryFields from './ComfyH3MemoryFields';

interface Props {
  busy: boolean;
  run: (label: string, operation: () => Promise<string>) => Promise<boolean>;
}

export default function ComfyLaunchSettings({ busy, run }: Props) {
  const t = useT();
  const [settings, setSettings] = useState<ComfyUILaunchSettings | null>(null);
  const [saved, setSaved] = useState<ComfyUILaunchSettings | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    void getComfyLaunchSettings().then((next) => {
      if (!disposed) { setSettings(next); setSaved(next); setError(''); }
    }, (cause: unknown) => {
      if (!disposed) setError(String(cause));
    });
    return () => { disposed = true; };
  }, [reload]);

  if (error) return <div className="ui-alert ui-alert--danger" role="alert">
    <div className="ui-alert__body"><p>{error}</p><div className="ui-row mt-2"><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" onClick={() => setReload((value) => value + 1)}>{t('重试')}</button><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy} onClick={() => { setSettings({ ...DEFAULT_COMFY_LAUNCH_SETTINGS, h3Memory: { ...DEFAULT_COMFY_LAUNCH_SETTINGS.h3Memory } }); setSaved(null); setError(''); }}>{t('使用默认设置重新保存')}</button></div></div>
  </div>;
  if (!settings) return <p className="ui-hint" role="status">{t('正在读取启动设置…')}</p>;
  const patch = <K extends keyof ComfyUILaunchSettings>(key: K, value: ComfyUILaunchSettings[K]) =>
    setSettings((current) => current ? { ...current, [key]: value } : current);
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);
  const valid = isValidComfyLaunchSettings(settings);
  const dynamicConflict = settings.dynamicVram === 'enabled' && ['high', 'no', 'cpu'].includes(settings.vramMode);
  const fieldClass = 'ui-field min-w-0';
  const memoryRowClass = 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6';
  const memoryControlClass = 'w-full shrink-0 sm:w-64';
  const memorySwitchOptions = [
    { value: 'auto' as const, label: t('自动（推荐）') },
    { value: 'enabled' as const, label: t('开启') }, { value: 'disabled' as const, label: t('关闭') },
  ];

  return <section className="space-y-3">
    <div className="ui-alert ui-alert--info"><Icon icon="lucide:info" width={16} className="ui-alert__icon" /><div className="ui-alert__body">{t('设置在下次通过本应用启动 ComfyUI 时生效。请先在运行控制台停止服务，再重新启动；外部启动的服务需在原启动器中停止。服务只监听本机。')}</div></div>
    <div className="ui-card">
      <div className="ui-card__header"><h2 className="ui-card__title">{t('基础启动设置')}</h2></div>
      <div className="ui-card__body grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className={fieldClass}>
        <label className="ui-label" htmlFor="comfy-launch-port">{t('服务端口')}</label>
        <input id="comfy-launch-port" className="ui-input" type="number" min={1024} max={65535} step={1} value={Number.isFinite(settings.port) ? settings.port : ''} disabled={busy} onChange={(event) => patch('port', event.target.valueAsNumber)} />
        <p className="ui-hint">{t('启动时同步本应用默认服务地址，默认端口 8188。')}</p>
      </div>
      <div className={fieldClass}>
        <label className="ui-label" htmlFor="comfy-launch-vram">{t('显存模式')}</label>
        <Select id="comfy-launch-vram" value={settings.vramMode} disabled={busy} onChange={(value) => patch('vramMode', value)} options={[
          { value: 'auto', label: t('自动（推荐）') }, { value: 'high', label: t('高显存') },
          { value: 'normal', label: t('标准显存（旧版支持）') }, { value: 'low', label: t('低显存') },
          { value: 'no', label: t('最小显存') }, { value: 'cpu', label: 'CPU' },
        ]} />
        <p className="ui-hint">{t('具体效果由安装版本决定；新版动态显存可能忽略低显存模式。')}</p>
      </div>
      <div className={fieldClass}>
        <label className="ui-label" htmlFor="comfy-launch-precision">{t('扩散模型精度')}</label>
        <Select id="comfy-launch-precision" value={settings.precision} disabled={busy} onChange={(value) => patch('precision', value)} options={[
          { value: 'auto', label: t('自动（推荐）') }, { value: 'fp16', label: 'FP16' }, { value: 'bf16', label: 'BF16' }, { value: 'fp32', label: 'FP32' },
        ]} />
      </div>
      <div className={fieldClass}>
        <label className="ui-label" htmlFor="comfy-launch-attention">{t('注意力算法')}</label>
        <Select id="comfy-launch-attention" value={settings.attention} disabled={busy} onChange={(value) => patch('attention', value)} options={[
          { value: 'auto', label: t('自动（推荐）') }, { value: 'pytorch', label: 'PyTorch' }, { value: 'split', label: t('Split（节省显存）') }, { value: 'quad', label: 'Quad' },
        ]} />
      </div>
      <div className={fieldClass}>
        <label className="ui-label" htmlFor="comfy-launch-preview">{t('生成预览')}</label>
        <Select id="comfy-launch-preview" value={settings.previewMethod} disabled={busy} onChange={(value) => patch('previewMethod', value)} options={[
          { value: 'auto', label: t('沿用安装版本默认值') }, { value: 'none', label: t('关闭预览') },
          { value: 'latent2rgb', label: 'Latent2RGB' }, { value: 'taesd', label: 'TAESD' },
        ]} />
        <p className="ui-hint">{t('TAESD 需要对应的预览模型。')}</p>
      </div>
      </div>
    </div>
    <div className="ui-card">
      <div className="ui-card__header flex-wrap">
        <h2 className="ui-card__title">{t('显存优化启动设置')}</h2>
        <span className="ui-card__desc ml-auto">{t('重启后生效')}</span>
      </div>
      <div className="ui-card__body divide-y divide-canvas-border">
        <div className="pb-3">
          <div className={memoryRowClass}>
            <div className="min-w-0 flex-1 space-y-1">
              <label className="ui-label block" htmlFor="comfy-launch-dynamic-vram">{t('动态显存管理')}</label>
              <p id="comfy-dynamic-hint" className="ui-hint">{t('自动适配安装版本；手动开关需版本支持。')}</p>
            </div>
            <div className={memoryControlClass}>
              <Select id="comfy-launch-dynamic-vram" value={settings.dynamicVram} disabled={busy}
                aria-describedby={dynamicConflict ? 'comfy-dynamic-hint comfy-dynamic-conflict' : 'comfy-dynamic-hint'}
                options={memorySwitchOptions} onChange={(value) => patch('dynamicVram', value)} />
            </div>
          </div>
          {dynamicConflict && <p id="comfy-dynamic-conflict" className="ui-error mt-2" role="alert">{t('动态显存不能与高显存、最小显存或 CPU 模式同时开启。')}</p>}
        </div>
        <div className={`${memoryRowClass} py-3`}>
          <div className="min-w-0 flex-1 space-y-1">
            <span className="ui-label block" id="comfy-smart-memory-label">{t('智能显存管理（推荐）')}</span>
            <p id="comfy-smart-memory-hint" className="ui-hint">{t('按需保留模型缓存，通常保持开启。')}</p>
          </div>
          <div className={`${memoryControlClass} flex items-center gap-3 sm:justify-end`}>
            <span className="ui-hint" aria-hidden="true">{settings.disableSmartMemory ? t('关闭') : t('开启')}</span>
            <button type="button" className="ui-switch" role="switch" aria-checked={!settings.disableSmartMemory}
              aria-labelledby="comfy-smart-memory-label" aria-describedby="comfy-smart-memory-hint" disabled={busy}
              onClick={() => patch('disableSmartMemory', !settings.disableSmartMemory)} />
          </div>
        </div>
        <div className={`${memoryRowClass} py-3`}>
          <div className="min-w-0 flex-1 space-y-1">
            <label className="ui-label block" htmlFor="comfy-launch-reserve-mode">{t('预留显存（GB）')}</label>
            <p id="comfy-reserve-hint" className="ui-hint">{t('自动分配，或手动为桌面和其他应用预留显存。')}</p>
          </div>
          <div className={`${memoryControlClass} space-y-2`}>
            <Select id="comfy-launch-reserve-mode" value={settings.reserveVramGb === null ? 'auto' : 'manual'} disabled={busy}
              aria-describedby="comfy-reserve-hint" options={[
                { value: 'auto', label: t('自动（推荐）') }, { value: 'manual', label: t('手动设置') },
              ]} onChange={(value) => patch('reserveVramGb', value === 'auto' ? null : settings.reserveVramGb ?? 1)} />
            {settings.reserveVramGb !== null && <div className="ui-input-group">
              <input id="comfy-launch-reserve-vram" className="ui-input" type="number" min={0} max={64} step={1}
                value={Number.isFinite(settings.reserveVramGb) ? settings.reserveVramGb : ''} disabled={busy}
                aria-label={t('预留显存（GB）')} aria-describedby="comfy-reserve-range"
                aria-invalid={!Number.isInteger(settings.reserveVramGb) || settings.reserveVramGb < 0 || settings.reserveVramGb > 64}
                onChange={(event) => patch('reserveVramGb', event.target.valueAsNumber)} />
              <span className="ui-input-affix ui-input-affix--trailing" aria-hidden="true">GB</span>
            </div>}
            <span id="comfy-reserve-range" className="sr-only">{t('范围 0–64 GB。')}</span>
          </div>
        </div>
        <div className={`${memoryRowClass} pt-3`}>
          <div className="min-w-0 flex-1 space-y-1">
            <label className="ui-label block" htmlFor="comfy-launch-async-offload">{t('异步权重卸载')}</label>
            <p id="comfy-offload-hint" className="ui-hint">{t('让权重传输与计算重叠，建议保持自动。')}</p>
          </div>
          <div className={`${memoryControlClass} space-y-2`}>
            <Select id="comfy-launch-async-offload" value={settings.asyncOffload} disabled={busy} options={memorySwitchOptions}
              aria-describedby="comfy-offload-hint" onChange={(value) => {
                setSettings((current) => current ? { ...current, asyncOffload: value,
                  asyncOffloadStreams: value === 'enabled' || (Number.isInteger(current.asyncOffloadStreams) && current.asyncOffloadStreams >= 1 && current.asyncOffloadStreams <= 4)
                    ? current.asyncOffloadStreams : DEFAULT_COMFY_LAUNCH_SETTINGS.asyncOffloadStreams } : current);
              }} />
            {settings.asyncOffload === 'enabled' && <div className="flex items-center gap-3">
              <label className="ui-label shrink-0" htmlFor="comfy-launch-offload-streams">{t('异步卸载流数')}</label>
              <input id="comfy-launch-offload-streams" className="ui-input" type="number" min={1} max={4} step={1}
                value={Number.isFinite(settings.asyncOffloadStreams) ? settings.asyncOffloadStreams : ''} disabled={busy}
                aria-describedby="comfy-offload-streams-hint"
                aria-invalid={!Number.isInteger(settings.asyncOffloadStreams) || settings.asyncOffloadStreams < 1 || settings.asyncOffloadStreams > 4}
                onChange={(event) => patch('asyncOffloadStreams', event.target.valueAsNumber)} />
            </div>}
            {settings.asyncOffload === 'enabled' && <p id="comfy-offload-streams-hint" className="ui-hint">{t('范围 1–4；建议先用 2。')}</p>}
          </div>
        </div>
      </div>
    </div>
    <ComfyH3MemoryFields value={settings.h3Memory} disabled={busy} onChange={(value) => patch('h3Memory', value)} />
    {!valid && <p className="ui-error" role="alert">{t('请检查数值范围、步长和启动选项冲突后再保存。')}</p>}
    <div className="ui-row ui-row--between">
      <p className="ui-hint">{dirty ? t('有未保存的设置') : t('启动设置已保存')}</p>
      <button type="button" className="ui-btn ui-btn--primary" disabled={busy || !dirty || !valid} onClick={() => void run(t('保存启动设置'), async () => {
        const next = await saveComfyLaunchSettings(settings);
        setSettings(next); setSaved(next);
        return t('设置已保存：启动项下次启动生效，H3 优化下次生成生效。');
      })}><Icon icon="lucide:save" width={14} />{t('保存设置')}</button>
    </div>
  </section>;
}
