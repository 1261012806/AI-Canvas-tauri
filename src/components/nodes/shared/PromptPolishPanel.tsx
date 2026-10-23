import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { createPromptPolishSession, enablePromptPolishPackage, isPromptPolishPackageSupported } from '../../../services/promptPolishService';
import { isSkillUserInvocable } from '../../../services/skillPromptService';
import { mergeSubAgentProfiles } from '../../../services/chat/subAgentProfileService';
import { resolveAssistantModel } from '../../../services/ai/assistantStream';
import { useT } from '../../../i18n';
import Select from '../../shared/Select';
import PopupCloseButton from '../../shared/PopupCloseButton';
import MentionEditor from './MentionEditor';
import ModelSelector from './ModelSelector';

export default function PromptPolishPanel({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const t = useT();
  const id = useId();
  const userSkills = useAppStore((state) => state.userSkills);
  const packageSkills = useAppStore((state) => state.agentPackageSkills);
  const customProfiles = useAppStore((state) => state.subAgentProfiles);
  const agentPackages = useAppStore((state) => state.agentPackages);
  const profiles = mergeSubAgentProfiles(customProfiles);
  const selectablePackages = agentPackages.filter(isPromptPolishPackageSupported);
  const skills = [...userSkills, ...packageSkills].filter(isSkillUserInvocable);
  const [instruction, setInstruction] = useState('');
  const [modelId, setModelId] = useState(() => {
    const selected = resolveAssistantModel()?.selectionId ?? '';
    const generalModels = useAppStore.getState().config.generalModels ?? [];
    return generalModels.some((model) => model.id === selected && model.category === 'text')
      ? `general/${selected}` : selected;
  });
  const [skillId, setSkillId] = useState('');
  const [agentChoice, setAgentChoice] = useState('');
  const [enablingPackageId, setEnablingPackageId] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'ready' | 'applied'>('idle');
  const [error, setError] = useState('');
  const session = useRef<ReturnType<typeof createPromptPolishSession> | null>(null);
  const input = useRef<HTMLDivElement>(null);
  useEffect(() => {
    input.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
    return () => { session.current?.cancel(); session.current = null; };
  }, []);

  const stop = () => {
    session.current?.cancel();
    session.current = null;
    setStatus('idle');
  };
  const selectAgent = async (value: string) => {
    if (!value.startsWith('package:')) {
      setAgentChoice(value);
      if (value) setSkillId('');
      return;
    }
    const installationId = value.slice('package:'.length);
    setAgentChoice(value);
    setSkillId('');
    setEnablingPackageId(installationId);
    setError('');
    try {
      await enablePromptPolishPackage(installationId);
    } catch (reason) {
      setAgentChoice('');
      setError(reason instanceof Error ? reason.message : t('智能体状态保存失败'));
    } finally {
      setEnablingPackageId(null);
    }
  };
  const start = async () => {
    if (status === 'running' || enablingPackageId || !modelId) return;
    session.current?.cancel();
    setError('');
    setPreview('');
    setStatus('running');
    let request: ReturnType<typeof createPromptPolishSession>;
    try {
      request = createPromptPolishSession(nodeId);
      session.current = request;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('无法开始润色'));
      setStatus('idle');
      return;
    }
    try {
      await request.run({
        instruction,
        modelId,
        skillId: skillId || undefined,
        profileId: agentChoice.startsWith('profile:') ? agentChoice.slice('profile:'.length) : undefined,
        agentPackageId: agentChoice.startsWith('package:') ? agentChoice.slice('package:'.length) : undefined,
        onPreview: (text) => { if (session.current === request) setPreview(text); },
      });
      if (session.current === request) setStatus('ready');
    } catch (reason) {
      if (session.current !== request) return;
      setError(reason instanceof Error ? reason.message : t('润色失败，请重试'));
      setStatus('idle');
    }
  };
  const apply = () => {
    try {
      session.current?.apply();
      setStatus('applied');
      setError('');
      useAppStore.getState().showToast(t('已应用，可在润色面板撤销本次修改'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('应用失败，请重新润色'));
      setStatus('idle');
    }
  };
  const undo = () => {
    try {
      session.current?.undo();
      setStatus('idle');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('无法撤销本次润色'));
    }
  };
  const running = status === 'running';
  return (
    <aside className="prompt-polish-panel" aria-label={t('AI 润色')} onKeyDown={(event) => event.stopPropagation()}>
      <header className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-canvas-text"><Sparkles size={16} aria-hidden="true" />{t('AI 润色')}</h2>
        <PopupCloseButton ariaLabel={t('关闭润色')} onClick={onClose} />
      </header>
      <p className="text-xs leading-relaxed text-canvas-text-muted">{t('描述你想怎么改，预览满意后再应用。')}</p>
      <span id={`${id}-instruction-label`} className="text-xs text-canvas-text-secondary">{t('润色要求')}</span>
      <div ref={input} className="ui-textarea prompt-polish-instruction shrink-0 focus-within:border-[var(--border-focus)] focus-within:ring-2 focus-within:ring-[var(--brand-alpha-12)]" role="group" aria-labelledby={`${id}-instruction-label`}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
            && !event.defaultPrevented && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            void start();
          }
        }}>
        <MentionEditor nodeId={nodeId} value={instruction} onChange={setInstruction}
          ariaLabel={t('润色要求')} placeholder={t('例如：保留主体，补充镜头和光线，让表达更自然…')}
          portalDropdown disabled={running} canSubmit={!running && !enablingPackageId && !!modelId}
          submitShortcut="ctrl-enter" onSubmit={() => { void start(); }} />
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-2">
        <label className="min-w-0 text-xs text-canvas-text-secondary"><span className="mb-1.5 block">Skill</span>
          <Select fixedMenu className="w-full" value={skillId} disabled={running} onChange={(value) => { setSkillId(value); if (value) setAgentChoice(''); }}>
            <option value="">{t('不使用 Skill')}</option>
            {skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
          </Select>
        </label>
        <label className="min-w-0 text-xs text-canvas-text-secondary"><span className="mb-1.5 block">{t('智能体')}</span>
          <Select fixedMenu className="w-full" value={agentChoice} disabled={running || !!enablingPackageId} onChange={(value) => { void selectAgent(value); }}>
            <option value="">{t('默认助手')}</option>
            <optgroup label={t('子智能体')}>
              {profiles.map((profile) => <option key={profile.id} value={`profile:${profile.id}`}>{profile.name}</option>)}
            </optgroup>
            {selectablePackages.length > 0 && <optgroup label={t('智能体中心')}>
              {selectablePackages.map((installation) => <option key={installation.id} value={`package:${installation.id}`}>{installation.enabled ? installation.manifest.name : t('启用智能体 {name}', { name: installation.manifest.name })}</option>)}
            </optgroup>}
          </Select>
        </label>
      </div>
      {enablingPackageId && <p className="text-[11px] text-canvas-text-muted" role="status">{t('启用智能体 {name}', { name: agentPackages.find((item) => item.id === enablingPackageId)?.manifest.name ?? '' })}</p>}
      <div className="prompt-polish-model-row flex min-w-0 shrink-0 items-center justify-between gap-2" role="group" aria-label={t('文本模型')}>
        <ModelSelector nodeType="ai-text" appearance="pill" selectedModel={modelId}
          disabled={running || !!enablingPackageId} persistPreference={false} onSelect={(model) => setModelId(model.value)} />
        <button type="button" className="ui-btn ui-btn--sm ui-btn--primary shrink-0" disabled={!!enablingPackageId || (!running && !modelId)} onClick={running ? stop : () => { void start(); }}>{running ? t('停止') : preview ? t('重新润色') : t('开始润色')}</button>
      </div>
      <div className="prompt-polish-result" aria-busy={running}>
        {preview ? <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-canvas-text">{preview}</div> : <div className="flex h-full min-h-24 flex-col items-center justify-center gap-3 text-center text-xs text-canvas-text-muted">{running ? <LoaderCircle className="motion-safe:animate-spin" size={20} /> : <Sparkles size={22} strokeWidth={1.2} />}<span role="status">{running ? agentChoice ? t('智能体正在润色…') : t('正在润色…') : t('润色结果会显示在这里')}</span></div>}
      </div>
      {error && <p role="alert" className="text-xs leading-relaxed text-canvas-text-secondary">{error}</p>}
      <footer className="flex shrink-0 items-center justify-between gap-2">
        <span role="status" className="text-[11px] text-canvas-text-muted">{status === 'applied' ? t('已应用，可撤销') : t('应用前保留原文')}</span>
        {status === 'applied' ? <button type="button" className="ui-btn ui-btn--sm" onClick={undo}>{t('撤销本次润色')}</button> : <button type="button" className="ui-btn ui-btn--sm ui-btn--primary" disabled={status !== 'ready'} onClick={apply}>{t('应用到提示词')}</button>}
      </footer>
    </aside>
  );
}
