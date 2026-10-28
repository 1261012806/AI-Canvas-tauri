import { memo, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { discardMediaTask, getPendingTasksForProject, resumeMediaNodeTask } from '../../../services/pollManager';
import { getComfyQueryAuthorizationMessage } from '../../../services/comfyPolling';
import { useT } from '../../../i18n';
import { GenerationWaitTime } from './NodeGenerationProgress';

/** 节点和提示词窗口共用；继续查询只读取原任务，不重新提交生成。 */
function MediaTaskStatus({ nodeId, overlay = false }: { nodeId: string; overlay?: boolean }) {
  const t = useT();
  const projectId = useAppStore((state) => state.currentProjectId);
  const taskState = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.mediaTaskState);
  const videoPaused = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.videoTaskState === 'paused');
  const loading = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.status === 'loading');
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const [confirmedIdentity, setConfirmedIdentity] = useState<string>();
  const task = projectId && (taskState || videoPaused) ? getPendingTasksForProject(projectId).find((item) => item.nodeId === nodeId
    || item.mediaContext?.canvasNodeId === nodeId) : undefined;
  if (!task || loading || (!taskState && !videoPaused)) return null;

  const canQuery = task.submitted && !!task.taskId && !task.mediaSubmissionUncertain && task.mediaRecoveryState !== 'submit_unknown';
  const deliveryPending = taskState === 'delivery_pending' || task.mediaRecoveryState === 'delivery_pending';
  const authorizationMessage = getComfyQueryAuthorizationMessage(task.comfyQueryHttpStatus);
  const message = !canQuery
    ? t('提交状态未知，请到对应平台核对；应用不会自动重新生成。')
    : (authorizationMessage ? t(authorizationMessage) : task.videoRecoveryMessage) || (deliveryPending
      ? t('媒体已生成，保存或回填尚未完成；可继续取回原结果。')
      : t('查询已暂停，任务已保留'));
  const kind = task.nodeType === 'ai-audio' ? 'audio' : task.nodeType === 'ai-video' ? 'video' : 'image';
  const identity = JSON.stringify([task.projectId, task.nodeId, task.taskId, task.attemptId]);
  return <div className={overlay ? 'generation-progress-overlay generation-progress-overlay--interactive nodrag nopan text-center'
    : 'ui-card nodrag nopan flex items-center gap-2 p-2'} role="status"
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}>
    <div className={`flex min-w-0 flex-col gap-1${overlay ? ' max-w-full items-center' : ' flex-1'}`}>
      <span className={`break-words text-canvas-text-secondary${overlay ? ' line-clamp-3 text-[11px]' : ' text-xs'}`} title={message}>{message}</span>
      <GenerationWaitTime nodeId={nodeId} />
      {!canQuery && !overlay && <details className="text-xs text-canvas-text-secondary">
        <summary className="cursor-pointer">{t('在平台确认任务结束后解除限制')}</summary>
        <p className="my-2">{t('解除本地记录不会取消平台任务。')}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmedIdentity === identity}
          onChange={(event) => setConfirmedIdentity(event.target.checked ? identity : undefined)} />
          {t('我已在平台确认任务未提交或已经结束')}</label>
        <button type="button" className="ui-btn ui-btn--sm mt-2" disabled={confirmedIdentity !== identity || busy}
          onClick={() => discardMediaTask({ projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId })}>
          {t('清除本地恢复记录')}
        </button>
      </details>}
    </div>
    {!canQuery && overlay && <button type="button" className={`ui-btn ui-btn--sm ui-btn--node-${kind} shrink-0`}
      onClick={() => useAppStore.getState().openNodeDialog(nodeId)}>{t('查看任务详情')}</button>}
    {canQuery && <button type="button" className={`ui-btn ui-btn--sm ui-btn--node-${kind} shrink-0`} disabled={busy}
      aria-label={t('继续查询 / 保存')}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void resumeMediaNodeTask(task.nodeId).catch(() => {
          showToast(t('暂时无法继续查询，请检查连接配置'), 'error');
        }).finally(() => setBusy(false));
      }}>
      <RotateCw size={14} aria-hidden="true" />{t('继续查询 / 保存')}
    </button>}
  </div>;
}

export default memo(MediaTaskStatus);
