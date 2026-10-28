import { useId } from 'react';
import { useT } from '../../../i18n';
import { useAppStore } from '../../../store/useAppStore';
import { isComfyH3Workflow } from '../../../services/comfyH3Memory';
import { videoInputData } from '../../../services/videoBatchPlanning';
import Select from '../../shared/Select';
import type { ComfyH3MemoryOverride } from '../../../types/comfyLaunch';
import { isValidComfyH3MemoryApplication } from '../../../types/comfyLaunch';

/** 独立订阅当前节点，覆盖值沿现有 Store Action、历史与项目持久化保存。 */
export default function ComfyH3MemorySelector({ nodeId, disabled }: { nodeId?: string; disabled?: boolean }) {
  const t = useT();
  const id = useId();
  const node = useAppStore((state) => state.nodes.find((item) => item.id === nodeId));
  const workflowId = useAppStore((state) => {
    const current = state.nodes.find((item) => item.id === nodeId);
    return current ? videoInputData(current, state).workflowId : undefined;
  });
  const provider = useAppStore((state) => {
    const current = state.nodes.find((item) => item.id === nodeId);
    return current ? videoInputData(current, state).provider : undefined;
  });
  const workflow = useAppStore((state) => state.workflows.find((item) => item.id === workflowId));
  if (!node || node.type !== 'ai-video' || provider !== 'comfyui'
    || !workflow || (workflow.adapterType && workflow.adapterType !== 'comfyui')
    || !isComfyH3Workflow(workflow.fileContent)) return null;

  const rawReceipt = node.data.comfyH3MemoryApplied;
  const applied = isValidComfyH3MemoryApplication(rawReceipt) && rawReceipt.workflowId === workflow.id ? rawReceipt : undefined;
  const appliedLabels = applied ? {
    attention: t('Attention 分块：{value}', { value: applied.settings.attentionHeadChunks }),
    feedForward: t('FFN 分块：{value}', { value: applied.settings.feedForwardChunks }),
    textEncoderCpu: t('文本编码器使用 CPU'),
    referenceImages: t('参考图片长边：{value}px', { value: applied.settings.referenceImageMaxSize }),
    vaeTiling: t('已请求 VAE 分块解码；实际块大小由后端实现决定'),
  } : null;

  return <div className="ui-field">
    <label htmlFor={id} className="ui-label">{t('H3 低显存预设')}</label>
    <Select<ComfyH3MemoryOverride> id={id} value={node.data.comfyH3MemoryPreset ?? 'inherit'}
      disabled={disabled || node.data.status === 'loading'}
      options={[
        { value: 'inherit', label: t('跟随常用设置') },
        { value: 'off', label: t('关闭 H3 优化') },
        { value: 'safe12', label: t('12GB 保守') },
      ]}
      onChange={(value) => useAppStore.getState().updateNodeData(node.id, { comfyH3MemoryPreset: value, comfyH3MemoryApplied: undefined })} />
    <p className="ui-hint">{t('仅影响下次生成；输出分辨率与时长保持节点设置。')}</p>
    {applied && appliedLabels && <div className="ui-alert ui-alert--info" role="status">
      <div className="ui-alert__body">
        <p className="font-medium">{t('上次提交的 H3 优化')}</p>
        <ul className="mt-1 space-y-1">{applied.applied.map((key) => <li key={key}>{appliedLabels[key]}</li>)}</ul>
      </div>
    </div>}
  </div>;
}
