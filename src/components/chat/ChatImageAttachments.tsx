import { useState } from 'react';
import { Icon } from '@iconify/react';
import type { ChatImageReference } from '../../types/chat';
import { useT } from '../../i18n';
import ViewportImage from '../shared/ViewportImage';

function ImageAttachment({ image, url, onRemove }: {
  image: ChatImageReference; url?: string; onRemove?: (fileName: string) => void;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  return (
    <div className="ui-card relative w-24 shrink-0 overflow-hidden p-2" title={image.label}>
      {url && !failed ? <ViewportImage src={url} alt={image.label} previewMaxEdge={160}
        className="h-16 w-full rounded object-contain" onError={() => setFailed(true)} />
        : <div className="flex h-16 items-center justify-center text-canvas-text-muted" role="img" aria-label={t('参考图预览不可用')}>
          <Icon icon="mdi:image-outline" width="24" />
        </div>}
      <p className="mt-1 truncate text-[11px] text-canvas-text-secondary">{image.label}</p>
      {onRemove && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm absolute right-0 top-0"
        aria-label={t('移除参考图 {name}', { name: image.label })} title={t('移除参考图')}
        onClick={() => onRemove(image.fileName)}><Icon icon="mdi:close" width="14" /></button>}
    </div>
  );
}

export default function ChatImageAttachments({ images, previews = {}, onRemove }: {
  images: ChatImageReference[]; previews?: Record<string, string>; onRemove?: (fileName: string) => void;
}) {
  const t = useT();
  if (!images.length) return null;
  return <div className="mb-2 flex gap-2 overflow-x-auto py-1" aria-label={t('参考图附件')}>
    {images.map((image) => <ImageAttachment key={`${image.fileName}:${previews[image.fileName] ?? ''}`}
      image={image} url={previews[image.fileName]} onRemove={onRemove} />)}
  </div>;
}
