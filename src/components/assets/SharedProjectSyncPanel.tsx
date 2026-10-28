import { memo, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, RefreshCw, Pause, AlertTriangle } from 'lucide-react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import type { SharedAssetSyncPreviewItem, SharedAssetSyncStatus, SharedSyncErrorStage, SharedSyncProgress } from '../../types/assetSync';

const STAGES: Record<SharedAssetSyncStatus['stage'], string> = {
  idle: '尚未同步', scanning: '正在扫描并核对资产…', preview: '同步预览', syncing: '正在同步项目资产…',
  paused: '同步已暂停，可恢复核对', completed: '项目资产同步完成', failed: '项目资产同步未完成',
};
const DIRECTIONS: Record<SharedAssetSyncPreviewItem['direction'], string> = {
  upload: '待上传', download: '待下载', conflict: '存在冲突', unchanged: '无变化', blocked: '暂不能同步',
};
const KINDS = { file: '项目文件', character: '人物', scene: '场景', prop: '道具' } as const;
const PROGRESS_STEPS: Record<SharedSyncProgress['phase'], string> = {
  preparing: '本地准备', uploading: '实际上传', downloading: '实际下载',
  publishing: '提交资产版本', cleanup: '清理未完成上传',
};
const ERROR_STAGES: Record<SharedSyncErrorStage, string> = {
  blobCheck: '检查云端素材', stagingVerify: '校验本地副本', multipartCreate: '准备分片上传',
  partUpload: '上传分片', multipartComplete: '完成分片上传', blobVerify: '校验云端素材',
  revisionWrite: '保存资产版本', headRead: '读取云端当前版本', revisionRead: '读取云端资产版本',
  multipartAbort: '清理未完成上传',
};

/** 同步运行期在 Store 中；此处仅展示结果及发起显式操作。 */
export default memo(function SharedProjectSyncPanel({ ownerId, enabled, autoPreview = false }: { ownerId: string; enabled: boolean; autoPreview?: boolean }) {
  const t = useT();
  const status = useAppStore((state) => state.sharedAssetSyncStatus[ownerId]);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(100);
  const previewRequested = useRef(false);
  const stage = status?.stage ?? 'idle';
  const busy = stage === 'scanning' || stage === 'syncing';
  const items = status?.items ?? [];
  const uploads = items.filter((item) => item.direction === 'upload').length;
  const downloads = items.filter((item) => item.direction === 'download').length;
  const conflicts = items.filter((item) => item.direction === 'conflict' || item.direction === 'blocked').length;

  useEffect(() => {
    let current = true;
    if (enabled) void (async () => {
      const existing = useAppStore.getState().sharedAssetSyncStatus[ownerId];
      // Store owns the session; reopening a view must not reset its progress or result.
      if (!existing || existing.stage === 'idle') {
        await useAppStore.getState().loadSharedProjectSyncState(ownerId).catch(() => undefined);
      }
      if (current && autoPreview && !previewRequested.current) {
        previewRequested.current = true;
        const latest = useAppStore.getState().sharedAssetSyncStatus[ownerId]?.stage;
        if (latest === 'scanning' || latest === 'syncing' || latest === 'preview') return;
        await useAppStore.getState().previewSharedProjectSync(ownerId).catch(() => undefined);
      }
    })();
    return () => { current = false; };
  }, [ownerId, enabled, autoPreview]);

  const run = async (apply: boolean) => {
    setError(''); setLimit(100);
    try {
      if (apply) await useAppStore.getState().syncSharedProjectNow(ownerId);
      else await useAppStore.getState().previewSharedProjectSync(ownerId);
    } catch { setError(t('无法开始同步，请重新打开项目共享并检查连接状态。')); }
  };

  return <section className="ui-card" aria-label={t('项目资产同步')}>
    <header className="ui-card__header flex-wrap gap-2">
      <div className="min-w-0 flex-1"><h4 className="ui-card__title">{t('项目资产同步')}</h4>
        <p className="ui-card__desc">{t('同步当前项目文件及创作资产；更新会先显示预览。')}</p></div>
      <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!enabled || busy}
        onClick={() => void run(false)}><RefreshCw size={14} aria-hidden="true" />
        {t(stage === 'paused' || stage === 'failed' ? '恢复并核对' : stage === 'preview' ? '重新预览' : '立即同步')}</button>
    </header>
    <div className="ui-card__body space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
        {busy && <span className="ui-spinner" aria-hidden="true" />}
        <span className="text-xs text-canvas-text-secondary">{t(STAGES[stage])}</span>
        {busy && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm ml-auto"
          onClick={() => void useAppStore.getState().cancelSharedProjectSync(ownerId)}><Pause size={14} aria-hidden="true" />{t('暂停同步')}</button>}
      </div>
      {busy && <p className="ui-hint">{t('关闭弹窗后继续后台同步，重新打开可查看进度或暂停。')}</p>}
      {status?.lastSyncedAt && <p className="ui-hint">{t('最近同步：{time}', { time: new Date(status.lastSyncedAt).toLocaleString() })}</p>}
      {stage === 'preview' && <p className="ui-alert ui-alert--info">
        {t('待上传 {uploads} 项，待下载 {downloads} 项，冲突或受阻 {conflicts} 项。', { uploads, downloads, conflicts })}
      </p>}
      {busy && status?.progress && <p className="ui-hint tabular-nums">
        {t('{stage}：{done} / {total} MB', {
          stage: t(PROGRESS_STEPS[status.progress.phase]),
          done: (status.progress.transferredBytes / 1024 / 1024).toFixed(1), total: (status.progress.totalBytes / 1024 / 1024).toFixed(1),
        })}
      </p>}
      {!!status?.total && <p className="ui-hint tabular-nums">{t(
        stage === 'scanning' || stage === 'paused' || stage === 'failed'
          ? '已保存进度：已完成 {done} / {total} 项' : '已完成 {done} / {total} 项',
        { done: status.completed, total: status.total },
      )}</p>}
      {!!items.length && <ul className="ui-list max-h-64 overflow-y-auto" aria-label={t('本次同步条目')}>
        {items.slice(0, limit).map((item) => <li key={item.id} className="ui-list__item min-w-0 p-2">
          <div className="flex min-w-0 items-center gap-2 text-xs">
            {item.direction === 'upload' ? <ArrowUpFromLine size={13} className="shrink-0" aria-hidden="true" />
              : item.direction === 'download' ? <ArrowDownToLine size={13} className="shrink-0" aria-hidden="true" />
                : item.direction === 'blocked' || item.direction === 'conflict' ? <AlertTriangle size={13} className="shrink-0" aria-hidden="true" /> : null}
            <span className="min-w-0 flex-1 truncate" title={item.name}>{item.name}</span>
            <span className="text-canvas-text-muted">{t(KINDS[item.kind])}</span>
            <span className="shrink-0 text-canvas-text-secondary">{t(stage === 'completed'
              && (item.direction === 'upload' || item.direction === 'download') ? '已同步' : DIRECTIONS[item.direction])}</span>
          </div>
          {item.message && <p className="ui-hint mt-1 break-words">{t(item.message)}</p>}
        </li>)}
      </ul>}
      {items.length > limit && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setLimit((value) => value + 100)}>{t('显示更多')}</button>}
      {stage === 'preview' && (uploads > 0 || downloads > 0) && <div className="space-y-2">
        <p className="ui-hint">{t('应用更新后，资产引用沿用当前素材；冲突条目会保留并停止覆盖。')}</p>
        <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!enabled}
          onClick={() => void run(true)}>{t('应用同步（{count} 项）', { count: uploads + downloads })}</button>
      </div>}
      {stage === 'preview' && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm"
        onClick={() => void useAppStore.getState().cancelSharedProjectSync(ownerId)}>{t('取消预览')}</button>}
      {(error || status?.error) && <p role="alert" className="ui-alert ui-alert--danger">{error || t(status?.error ?? '')}</p>}
      {!error && status?.error && status.errorStage && <p className="ui-hint">
        {t('失败阶段：{stage}', { stage: t(ERROR_STAGES[status.errorStage]) })}
      </p>}
    </div>
  </section>;
});
