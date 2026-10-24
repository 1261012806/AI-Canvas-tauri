import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ReferencePreviewContent, ReferencePreviewSource } from '../../types/referencePreview';
import { parseShotlistRowMentionId } from '../../types/shotlist';
import { cropImageByRanges } from '../nodes/shared/image/imageUtils';
import ModalOverlay from './ModalOverlay';
import ZoomableImage from './ZoomableImage';
import VideoPlayer from './VideoPlayer';
import MarkdownEditor from './MarkdownEditor';
import { AudioTrackPlayer } from './CanvasAudioPreview';
import ReferencePreviewBody from './ReferencePreviewBody';
import { useT } from '../../i18n';

const KIND_LABELS: Record<ReferencePreviewContent['kind'], string> = {
  text: '文本', markdown: 'Markdown', image: '图片', video: '视频', audio: '音频',
};
const KIND_ICONS: Record<ReferencePreviewContent['kind'], string> = {
  text: 'lucide:file-text', markdown: 'lucide:file-code', image: 'lucide:image', video: 'lucide:video', audio: 'lucide:music',
};
const ignoreChange = () => undefined;
const renderReferenceBody = (value: string, markdown: boolean) => <ReferencePreviewBody value={value} markdown={markdown} />;

function PreviewMessage({ message, loading = false }: { message: string; loading?: boolean }) {
  const t = useT();
  return <div role={loading ? 'status' : 'alert'} className="flex h-full flex-col items-center justify-center gap-3 p-3 text-sm text-canvas-text-secondary">
    <Icon icon={loading ? 'lucide:loader-circle' : 'lucide:file-question'} className={`h-8 w-8${loading ? ' animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
    <p className="max-w-lg whitespace-pre-wrap break-words text-center">{t(message)}</p>
  </div>;
}

function ReferenceImage({ src, label, crop }: { src: string; label: string; crop?: ReferencePreviewContent['imageCrop'] }) {
  const t = useT();
  const [retry, setRetry] = useState(0);
  const cropKey = crop ? `${crop.x}:${crop.y}:${crop.width}:${crop.height}` : '';
  const key = `${src}:${cropKey}:${retry}`;
  const [cropped, setCropped] = useState<{ key: string; url?: string; failed?: boolean } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const x = crop?.x; const y = crop?.y; const width = crop?.width; const height = crop?.height;
  useEffect(() => {
    if (x === undefined || y === undefined || width === undefined || height === undefined) return;
    let cancelled = false;
    const valid = [x, y, width, height].every(Number.isFinite)
      && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 100.000001 && y + height <= 100.000001;
    const resolveCrop = async () => {
      try {
        if (!valid) throw new Error('invalid crop');
        const result = await cropImageByRanges(src, [y, y + height], [x, x + width], 0, 0);
        if (!cancelled) setCropped({ key, url: result.dataUrl });
      } catch {
        if (!cancelled) setCropped({ key, failed: true });
      }
    };
    void resolveCrop();
    return () => { cancelled = true; };
  }, [height, key, src, width, x, y]);
  const currentCrop = cropped?.key === key ? cropped : null;
  if (failedKey === key || currentCrop?.failed) return <div className="flex h-full flex-col items-center justify-center gap-3 p-3">
    <p role="alert" className="text-sm text-canvas-text-secondary">{crop ? t('裁片读取失败，未显示整张图片') : t('图片加载失败')}</p>
    <button type="button" className="ui-btn ui-btn--sm" onClick={() => setRetry((value) => value + 1)}>{t('重新加载')}</button>
  </div>;
  if (crop && !currentCrop?.url) return <PreviewMessage message="正在读取图片裁片…" loading />;
  return <ZoomableImage key={key} src={currentCrop?.url || src} alt={label} className="fullscreen-img-view" onError={() => setFailedKey(key)} />;
}

function ReferenceAudio({ src }: { src: string }) {
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [session, setSession] = useState({ time: 0, autoPlay: false, analysis: true });
  const unavailable = useCallback((time: number, playing: boolean) => {
    setSession({ time, autoPlay: playing, analysis: false });
  }, []);
  return <div className="flex h-full items-center justify-center overflow-y-auto p-3">
    <div className="w-full max-w-3xl space-y-3">
      <AudioTrackPlayer key={`${src}:${session.analysis}`} src={src} initialTime={session.time} autoPlay={session.autoPlay}
        analysis={session.analysis} volume={volume} muted={muted} onVolume={setVolume} onMuted={setMuted}
        hasPrevious={false} hasNext={false} onNavigate={ignoreChange} onAnalysisUnavailable={unavailable} />
    </div>
  </div>;
}

/** 仅展示宿主已解析的内容；不写资产、节点、提示词或项目历史。宿主关闭时卸载。 */
export default function ReferenceContentPreview({ content, source, onBack, onClose, loading = false }: {
  content: ReferencePreviewContent;
  source?: ReferencePreviewSource;
  onBack?: () => void;
  onClose: () => void;
  loading?: boolean;
}) {
  const t = useT();
  const [selection, setSelection] = useState<{ content: ReferencePreviewContent; index: number } | null>(null);
  const images = content.images?.length ? content.images : content.mediaUrl ? [{ url: content.mediaUrl, label: content.title }] : [];
  const index = selection?.content === content ? Math.min(selection.index, Math.max(0, images.length - 1)) : 0;
  const image = images[index];
  const ownerNodeId = source?.kind === 'node'
    ? parseShotlistRowMentionId(source.id)?.nodeId || /^(.*)\/cell\/\d+$/.exec(source.id)?.[1] || source.id
    : source?.ownerNodeId;
  const unavailable = content.unavailable || (content.kind === 'image' && !image ? '此引用暂无可用图片'
    : (content.kind === 'video' || content.kind === 'audio') && !content.mediaUrl ? '此引用暂无可播放内容' : undefined);
  return <ModalOverlay isOpen onClose={onClose} ariaLabel={t('引用内容：{title}', { title: content.title })} className="asset-image-preview reference-content-preview"
    zIndex={420} motionPreset="quick" backdropBlur={false} closeOnBackdrop={false}>
    <div data-reference-preview-open="" data-reference-owner-node-id={ownerNodeId} className="asset-image-preview-layout">
      <div className="asset-image-preview-stage">
        {loading ? <PreviewMessage message="正在读取引用内容…" loading />
          : unavailable ? <PreviewMessage message={unavailable} />
          : content.kind === 'image' && image ? <ReferenceImage key={image.url} src={image.url} label={image.label} crop={index === 0 ? content.imageCrop : undefined} />
          : content.kind === 'video' ? <VideoPlayer key={content.mediaUrl} src={content.mediaUrl} name={content.title} onEscape={onClose} />
          : content.kind === 'audio' && content.mediaUrl ? <ReferenceAudio key={content.mediaUrl} src={content.mediaUrl} />
          : <MarkdownEditor key={`${content.kind}:${content.title}`} value={content.text || ''} onChange={ignoreChange}
            readOnly markdown={content.kind === 'markdown'} initialMode="preview" renderPreview={renderReferenceBody}
            label={content.title} status={t('引用内容 · 只读')} />}
      </div>
      <aside className="asset-image-preview-info" aria-label={t('引用详情')}>
        <header className="flex shrink-0 items-start gap-3">
          {onBack && <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost shrink-0" aria-label={t('返回上一个引用')} title={t('返回上一个引用（Esc）')} onClick={onBack}>
            <Icon icon="lucide:arrow-left" aria-hidden="true" />
          </button>}
          <Icon icon={KIND_ICONS[content.kind]} className="mt-1 h-5 w-5 shrink-0 text-canvas-text-secondary" aria-hidden="true" />
          <div className="min-w-0 flex-1"><h1 className="break-words text-sm font-semibold text-canvas-text">{content.title}</h1>
            <p className="pt-1 text-xs text-canvas-text-muted">{t(KIND_LABELS[content.kind])}{content.kind === 'image' && images.length > 1 ? ` · ${index + 1} / ${images.length}` : ''}</p></div>
          <button type="button" className="ui-close-btn" aria-label={t('关闭引用预览')} title={t('关闭（Esc）')} onClick={onClose}><Icon icon="lucide:x" aria-hidden="true" /></button>
        </header>
        <div className="asset-image-preview-info-content space-y-3">
          {content.description && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-canvas-text-secondary">{content.description}</p>}
          {!!content.details?.length && <section className="ui-card asset-image-preview-section p-3" aria-label={t('内容信息')}>
            <h2 className="pb-2 text-xs font-medium text-canvas-text-secondary">{t('相关信息')}</h2>
            <dl className="space-y-3">{content.details.map((detail, position) => <div key={`${position}:${detail.label}`}>
              <dt className="text-xs text-canvas-text-muted">{t(detail.label)}</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-canvas-text">{detail.value}</dd>
            </div>)}</dl>
          </section>}
          {content.text && ['image', 'video', 'audio'].includes(content.kind) && <section className="ui-card asset-image-preview-section p-3" aria-label={t('引用正文')}>
            <h2 className="pb-2 text-xs font-medium text-canvas-text-secondary">{content.kind === 'audio' ? t('正文与台词') : t('正文与简介')}</h2>
            <ReferencePreviewBody value={content.text} />
          </section>}
          {!loading && !unavailable && content.kind === 'image' && images.length > 1 && <div className="asset-image-preview-references" aria-label={t('全部参考图')}>
            {images.map((item, position) => <div className="asset-image-preview-reference" key={`${position}:${item.url}`}>
              <button type="button" aria-label={t('查看{label}', { label: item.label })} aria-pressed={index === position} title={item.label}
                onClick={() => setSelection({ content, index: position })}><img src={item.url} alt={item.label} loading="lazy" /></button>
            </div>)}
          </div>}
          {content.prompt && <section className="ui-card asset-image-preview-section p-3" aria-label={t('提示词')}>
            <h2 className="pb-2 text-xs font-medium text-canvas-text-secondary">{t('提示词')}</h2>
            <ReferencePreviewBody value={content.prompt} />
          </section>}
        </div>
      </aside>
    </div>
  </ModalOverlay>;
}
