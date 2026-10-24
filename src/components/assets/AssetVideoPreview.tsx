import { t, useT } from '../../i18n';
import { useEffect, useState } from 'react';
import { Icon } from '@iconify/react';
import type { HistoryRecord } from '../../services/indexedDbService';
import { describeAssetVideoHistory, loadAssetVideoHistory } from '../../services/assetVideoDetails';
import { copyText } from '../../services/clipboardService';
import { formatSize } from '../../utils/assetFormat';
import VideoPlayer from '../shared/VideoPlayer';
import ModalOverlay from '../shared/ModalOverlay';

/** 与图片预览共用布局样式；只在用户打开时挂载播放器和读取生成历史。 */
export default function AssetVideoPreview({ src, querySrc, filePath, poster, name, size, projectId, historyRecord, unavailable, onClose, onSourceError }: {
  src?: string; querySrc?: string; filePath?: string; poster?: string; name: string; size?: number;
  projectId?: string; historyRecord?: HistoryRecord; unavailable: boolean; onClose: () => void; onSourceError: () => void;
}) {
  useT();
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ src: string; width: number; height: number; duration: number } | null>(null);
  const [metadata, setMetadata] = useState<{ key: string; record: HistoryRecord | null; error: boolean } | null>(null);
  const [copyStatus, setCopyStatus] = useState<{ key: string; message: string } | null>(null);
  const key = JSON.stringify([filePath, querySrc, projectId, historyRecord?.id, retry]);
  const current = metadata?.key === key ? metadata : null;
  const history = historyRecord ?? current?.record;
  const loading = !historyRecord && !current;
  const details = history ? describeAssetVideoHistory(history) : [];
  const mediaInfo = dimensions?.src === src ? dimensions : null;
  useEffect(() => {
    if (historyRecord) return;
    const controller = new AbortController();
    void loadAssetVideoHistory(filePath, querySrc, projectId, controller.signal).then((record) => {
      if (!controller.signal.aborted) setMetadata({ key, record, error: false });
    }, () => { if (!controller.signal.aborted) setMetadata({ key, record: null, error: true }); });
    return () => controller.abort();
  }, [key, filePath, querySrc, projectId, historyRecord]);

  return <ModalOverlay isOpen onClose={onClose} ariaLabel={t("视频与生成信息")} className="asset-image-preview"
    zIndex={360} motionPreset="quick" backdropBlur={false} closeOnBackdrop={false}>
    {poster && <img className="asset-image-preview-backdrop" src={poster} alt="" aria-hidden="true" />}
    <div data-tauri-drag-region className="asset-image-preview-layout">
      <div className="asset-image-preview-stage">
        <VideoPlayer key={src ?? 'unavailable'} src={src} poster={poster} name={name} autoPlay unavailable={unavailable}
          onError={() => { setFailed(src ?? null); onSourceError(); }} onEscape={onClose}
          onMetadata={(metadata) => { setFailed(null); setDimensions({ src: src ?? '', ...metadata }); }} />
      </div>
      <aside className="asset-image-preview-info" aria-label={t("视频提示词和参数")}>
        <header className="flex shrink-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-canvas-hover text-canvas-text-secondary"><Icon icon="lucide:film" className="h-4 w-4" aria-hidden="true" /></div>
          <h1 className="min-w-0 flex-1 break-words text-sm font-semibold text-canvas-text">{name}</h1>
          <button type="button" className="ui-close-btn" aria-label={t("关闭视频预览")} title={t("关闭（Esc）")} onClick={onClose}><Icon icon="lucide:x" aria-hidden="true" /></button>
        </header>
        <div className="asset-image-preview-info-content">
          <section className="ui-card asset-image-preview-section p-3" aria-label={t("提示词")}>
            <div className="flex items-center justify-between gap-2 pb-2"><h2 className="flex items-center gap-2 text-xs font-medium text-canvas-text-secondary"><Icon icon="lucide:sparkles" className="h-3.5 w-3.5" aria-hidden="true" />{t("提示词")}</h2>
              <button type="button" className="ui-btn ui-btn--sm" disabled={!history?.prompt?.trim()} onClick={() => {
                if (!history?.prompt) return;
                void copyText(history.prompt).then((copied) => setCopyStatus({ key, message: copied ? '提示词已复制' : '复制失败，请重试' }));
              }}><Icon icon="lucide:copy" aria-hidden="true" />{t("复制提示词")}</button>
            </div>
            {loading ? <p role="status" className="text-xs text-canvas-text-muted">{t("正在读取生成信息…")}</p>
              : current?.error ? <div role="alert" className="space-y-2 text-xs text-canvas-text-secondary"><p>{t("生成信息读取失败")}</p><button type="button" className="ui-btn ui-btn--sm" onClick={() => setRetry((value) => value + 1)}>{t("重试读取")}</button></div>
                : <p className="asset-image-preview-prompt whitespace-pre-wrap break-words text-sm leading-relaxed text-canvas-text">{history?.prompt?.trim() ? history.prompt : history ? t('此记录未保存提示词') : t('暂无生成信息')}</p>}
            {copyStatus?.key === key && <p role="status" className="pt-2 text-xs text-canvas-text-secondary">{t(copyStatus.message)}</p>}
          </section>
          <section className="asset-image-preview-parameters" aria-label={t("生成参数")}>
            <h2 className="flex items-center gap-2 pb-3 text-xs font-medium text-canvas-text-secondary"><Icon icon="lucide:info" className="h-3.5 w-3.5" aria-hidden="true" />{t("参数与文件信息")}</h2>
            <dl className="ui-card asset-image-preview-section space-y-3 p-3 text-sm">
              {details.map(({ label, value }) => <div className="flex items-start justify-between gap-3" key={label}><dt className="shrink-0 text-canvas-text-muted">{t(label)}</dt><dd className="min-w-0 whitespace-pre-wrap break-words text-right text-canvas-text">{value}</dd></div>)}
              <div className="flex justify-between gap-3"><dt className="text-canvas-text-muted">{t("视频尺寸")}</dt><dd className="text-canvas-text">{mediaInfo && mediaInfo.width > 0 && mediaInfo.height > 0 ? `${mediaInfo.width} × ${mediaInfo.height}` : failed === src || unavailable && !src ? t('无法读取') : t('正在读取…')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-canvas-text-muted">{t("视频时长")}</dt><dd className="text-canvas-text">{mediaInfo && Number.isFinite(mediaInfo.duration) && mediaInfo.duration > 0 ? t('{seconds} 秒', { seconds: Number(mediaInfo.duration.toFixed(2)) }) : t('未知')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-canvas-text-muted">{t("文件大小")}</dt><dd className="text-canvas-text">{size && size > 0 ? formatSize(size) : t('未知')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-canvas-text-muted">{t("来源")}</dt><dd className="text-canvas-text">{filePath ? t('本地文件') : t('媒体资源')}</dd></div>
            </dl>
          </section>
        </div>
        <footer className="asset-image-preview-footer"><p className="text-center text-xs text-canvas-text-muted">{t("Esc 关闭 · 底部可调整进度、速度和声音")}</p></footer>
      </aside>
    </div>
  </ModalOverlay>;
}
