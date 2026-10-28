import { useT } from '../../i18n';
import type { ComfyDependencyProgress as Progress } from '../../types/comfyManagement';

const LABELS = {
  waiting: '等待其他管理操作完成…',
  confirming: '等待确认依赖安装…',
  checking: '正在检查安装环境…',
  resolving: '正在解析依赖…',
  downloading: '正在下载依赖…',
  building: '正在构建依赖…',
  installing: '正在安装依赖…',
  completed: '依赖安装完成',
  cancelled: '依赖安装已取消',
  failed: '依赖安装失败',
} as const;

export default function ComfyDependencyProgress({ title, progress, cancelling, onCancel }: {
  title: string;
  progress: Progress;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const t = useT();
  const terminal = ['completed', 'cancelled', 'failed'].includes(progress.stage);
  const label = t(cancelling ? '正在取消，等待安装进程退出…' : LABELS[progress.stage]);
  return <section className="ui-card p-3 space-y-2" aria-label={t('依赖安装进度')} aria-busy={!terminal}>
    <div className="ui-row ui-row--between flex-wrap gap-2">
      <span className="text-xs font-medium">{title}</span>
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm"
        disabled={cancelling || terminal} onClick={onCancel}>{t(cancelling ? '正在取消…' : '取消安装')}</button>
    </div>
    <div className="text-xs text-canvas-text-secondary" role="status">
      {label}{progress.packageName && <span className="ml-2 font-mono break-all">{progress.packageName}</span>}
    </div>
    {!terminal && <div className="ui-progress ui-progress--indeterminate" role="progressbar" aria-label={label}>
      <div className="ui-progress__bar" />
    </div>}
    <p className="ui-hint">{t('取消不会回滚已安装的软件包。')}</p>
  </section>;
}
