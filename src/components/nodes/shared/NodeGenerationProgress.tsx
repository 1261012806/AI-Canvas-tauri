import { useEffect, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { getGenerationNodeType } from '../../../utils/nodeGeneration';
import { useT } from '../../../i18n';

function formatElapsed(now: number, startedAt: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  return [
    ...(hours > 0 ? [String(hours)] : []),
    String(Math.floor(seconds / 60) % 60).padStart(2, '0'),
    String(seconds % 60).padStart(2, '0'),
  ].join(':');
}

export function GenerationWaitTime({ nodeId, nodeStartedAt, compact = false }: {
  nodeId: string;
  nodeStartedAt?: number;
  compact?: boolean;
}) {
  const t = useT();
  const projectId = useAppStore((state) => state.currentProjectId);
  const startedAt = useAppStore((state) => {
    const data = state.nodes.find((node) => node.id === nodeId)?.data;
    const type = getGenerationNodeType(data?.type);
    if (!data || (type !== 'ai-image' && type !== 'ai-video')
      || (data.status !== 'loading' && !(type === 'ai-video' && data.videoTaskState === 'paused'))) return undefined;
    const value = data.generationStartedAt;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  });
  const [now, setNow] = useState(() => Date.now());
  const timingAnchor = startedAt || nodeStartedAt;

  useEffect(() => {
    // 兼容更新前已经运行的任务，从首次可确认的等待时间开始记录。
    if (startedAt === 0) {
      const state = useAppStore.getState();
      const node = state.nodes.find((item) => item.id === nodeId);
      if (state.currentProjectId === projectId && node
        && (node.data.status === 'loading' || node.data.videoTaskState === 'paused')) {
        state.updateNodeDataTransient(nodeId, { generationStartedAt: Date.now() });
      }
      return;
    }
    if (!timingAnchor) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [nodeId, projectId, startedAt, timingAnchor]);

  if (startedAt === undefined && !nodeStartedAt) return null;

  return (
    <span role="timer" aria-live="off" className={`flex justify-center tabular-nums text-canvas-text-muted ${compact ? 'flex-nowrap gap-x-2 text-[10px]' : 'flex-wrap gap-x-3 gap-y-1 text-[11px]'}`}>
      {startedAt !== undefined && <span className="min-w-0 truncate">{t(compact ? '总计 {duration}' : '已等待 {duration}', { duration: startedAt ? formatElapsed(now, startedAt) : '00:00' })}</span>}
      {nodeStartedAt !== undefined && <span className="min-w-0 truncate">{t(compact ? '节点 {duration}' : '本节点 {duration}', { duration: formatElapsed(now, nodeStartedAt) })}</span>}
    </span>
  );
}

interface NodeGenerationProgressProps {
  nodeId: string;
  fallbackLabel: string;
  overlay?: boolean;
  compactSpinner?: boolean;
}

export default function NodeGenerationProgress({
  nodeId,
  fallbackLabel,
  overlay = false,
  compactSpinner = false,
}: NodeGenerationProgressProps) {
  const t = useT();
  const progress = useAppStore((state) => {
    const candidate = state.comfyNodeProgress[nodeId];
    return candidate?.projectId === state.currentProjectId ? candidate : null;
  });

  if (!progress) {
    if (overlay) {
      // 节点已有内容时以浮层形式保留生成中的可见反馈（含性能模式，仅 spinner 不受降级影响）
      return (
        <div className="generation-progress-overlay">
          <div className="spinner large" />
          <span className="text-xs">{fallbackLabel}</span>
          <GenerationWaitTime nodeId={nodeId} />
        </div>
      );
    }
    return (
      <div className="node-preview-loading">
        <div className={compactSpinner ? 'spinner' : 'spinner large'} />
        <span>{fallbackLabel}</span>
        <GenerationWaitTime nodeId={nodeId} />
      </div>
    );
  }

  const determinate = progress.stage === 'running' && progress.percent !== undefined
    && progress.value !== undefined && progress.max !== undefined;
  const stageLabel = {
    connecting: t('连接进度通道'),
    queued: t('等待执行'),
    running: t('正在执行'),
    finalizing: t('正在读取结果'),
  }[progress.stage];
  const nodeLabel = progress.executingNodeLabel || progress.executingNodeType;
  const nodeDetail = progress.executingNodeId
    ? `#${progress.executingNodeId}${nodeLabel ? ` · ${nodeLabel}` : ''}`
    : undefined;
  const accessIssue = progress.connectionIssue === 'forbidden'
    ? t('进度访问被拒绝（403），仍在查询结果')
    : progress.connectionIssue === 'unauthorized'
      ? t('进度连接未授权（401），仍在查询结果')
      : undefined;
  const statusDetail = accessIssue && progress.stage !== 'finalizing' ? accessIssue : progress.stage === 'queued' && progress.queuePosition !== undefined
    ? t('等待队列第 {position} 位', { position: progress.queuePosition })
    : progress.stage === 'finalizing'
      ? t('执行已结束，等待结果回传')
      : progress.transport === 'reconnecting'
        ? t('重连进度中，仍在查询结果')
        : progress.transport === 'polling'
          ? t('正在查询任务状态')
          : nodeDetail || (progress.stage === 'running' ? t('服务执行中，等待进度更新') : fallbackLabel);
  const statusTitle = progress.stage === 'finalizing' ? statusDetail : accessIssue
    ? `${accessIssue} · ${t('请检查 ComfyUI 服务或网关的访问权限')}`
    : progress.transport === 'polling'
    ? t('正在查询任务状态，步骤进度暂不可用')
    : progress.transport === 'reconnecting'
      ? t('进度连接中断，正在重连；结果查询继续')
      : nodeDetail || statusDetail;

  return (
    <div
      className={overlay
        ? 'generation-progress-overlay'
        : `node-preview-loading px-2${compactSpinner ? '' : ' py-2'}`}
      data-comfy-progress={progress.stage}
    >
      <div className="flex w-full max-w-[280px] flex-col gap-1 text-[11px] leading-normal">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-canvas-text">
            <span className="ui-spinner" aria-hidden="true" />
            <span className="truncate">ComfyUI</span>
          </span>
          <span className="ui-badge ui-badge--primary min-w-0 max-w-[60%] truncate" role="status" title={stageLabel}>{stageLabel}</span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-left text-canvas-text-secondary" title={statusTitle}>{statusDetail}</span>
          {progress.cachedNodeCount !== undefined && progress.cachedNodeCount > 0 && (
            <span className="ui-badge ui-badge--outline max-w-[50%] truncate" title={t('已复用 {count} 个缓存节点', { count: progress.cachedNodeCount })}>
              {t('缓存 {count}', { count: progress.cachedNodeCount })}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2" title={t('当前节点进度')}>
          {determinate && (
            <span className="min-w-0 max-w-[75%] truncate tabular-nums text-canvas-text">
              <span className="mr-1 text-canvas-text-muted">{t('本节点')}</span>
              <span>{`${progress.value} / ${progress.max} · ${progress.percent}%`}</span>
            </span>
          )}
          <div
            className={`ui-progress min-w-0 flex-1${determinate ? '' : ' ui-progress--indeterminate'}`}
            role="progressbar"
            aria-label={t('ComfyUI 当前节点进度')}
            aria-valuetext={determinate ? `${progress.value} / ${progress.max} · ${progress.percent}%` : stageLabel}
            aria-valuemin={determinate ? 0 : undefined}
            aria-valuemax={determinate ? 100 : undefined}
            aria-valuenow={determinate ? progress.percent : undefined}
          >
            <div className="ui-progress__bar" style={determinate ? { width: `${progress.percent}%` } : undefined} />
          </div>
        </div>
        <GenerationWaitTime nodeId={nodeId} nodeStartedAt={progress.stage === 'running' ? progress.nodeStartedAt : undefined} compact />
      </div>
    </div>
  );
}
