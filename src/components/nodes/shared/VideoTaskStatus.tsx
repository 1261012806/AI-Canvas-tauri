import { memo, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { getPendingTasksForProject, resumeVideoNodeTask } from '../../../services/pollManager';
import { useT } from '../../../i18n';
import { GenerationWaitTime } from './NodeGenerationProgress';

/** 节点与提示词窗口共用的续查入口，不提交新的生成请求。 */
function VideoTaskStatus({ nodeId, overlay = false }: { nodeId: string; overlay?: boolean }) {
  const t = useT();
  const projectId = useAppStore((state) => state.currentProjectId);
  const paused = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data.videoTaskState === 'paused');
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const task = projectId ? getPendingTasksForProject(projectId).find((item) => item.nodeId === nodeId
    && item.nodeType === 'ai-video' && item.submitted && !!item.taskId && item.videoRecoveryState === 'paused') : undefined;
  if (!paused || !task) return null;

  const message = task.videoRecoveryMessage || t('查询已暂停，任务已保留');
  return <div className={overlay ? 'generation-progress-overlay generation-progress-overlay--interactive nodrag nopan text-center'
    : 'ui-card nodrag nopan flex items-center gap-2 p-2'} role="status"
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}>
    <div className={`flex min-w-0 flex-col gap-1${overlay ? ' max-w-full items-center' : ' flex-1'}`}>
      <span className={`break-words text-canvas-text-secondary${overlay ? ' line-clamp-2 text-[11px]' : ' text-xs'}`} title={message}>{message}</span>
      <GenerationWaitTime nodeId={nodeId} />
    </div>
    <button type="button" className="ui-btn ui-btn--sm ui-btn--node-video shrink-0" disabled={busy}
      aria-label={t('重试查询视频任务')}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void resumeVideoNodeTask(nodeId).catch(() => {
          showToast(t('暂时无法继续查询，请检查连接配置'), 'error');
        }).finally(() => setBusy(false));
      }}>
      <RotateCw size={14} aria-hidden="true" />{t('重试')}
    </button>
  </div>;
}

export default memo(VideoTaskStatus);
