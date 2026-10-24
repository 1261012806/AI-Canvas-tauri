import { useId, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { DRAMA_ASSET_KIND_LABEL } from '../../types/dramaAssets';
import type { DramaAssetIdentity, DramaAssetImportPreview } from '../../services/dramaAssetTransferFormat';
import { formatSize } from '../../utils/assetFormat';
import ModalOverlay from '../shared/ModalOverlay';

export interface DramaAssetImportDialogProps {
  preview: DramaAssetImportPreview;
  onChoose: (assets: DramaAssetIdentity[] | null) => void;
}

export default function DramaAssetImportDialog({ preview, onChoose }: DramaAssetImportDialogProps) {
  const t = useT();
  const checkboxId = useId();
  const [selected, setSelected] = useState(() => new Set(preview.items.map((item) => `${item.kind}:${item.id}`)));
  const summary = useMemo(() => {
    const items = preview.items.filter((item) => selected.has(`${item.kind}:${item.id}`));
    const mediaIds = new Set(items.flatMap((item) => item.mediaIds));
    const media = preview.media.filter((item) => mediaIds.has(item.id));
    return { items, mediaCount: media.length, bytes: media.reduce((total, item) => total + item.bytes, 0) };
  }, [preview, selected]);
  const mediaById = useMemo(() => new Map(preview.media.map((media) => [media.id, media])), [preview]);

  return <ModalOverlay isOpen onClose={() => onChoose(null)} ariaLabel={t('选择要导入的创作资产')}
    zIndex={320} className="mx-3 w-full max-w-2xl max-h-[80vh] gap-3 p-3">
    <header className="min-w-0 shrink-0">
      <h3 className="text-sm font-semibold text-canvas-text">{t('选择要导入的创作资产')}</h3>
      <p className="mt-1 break-words text-xs text-canvas-text-secondary">{preview.name}</p>
      <p className="mt-1 text-xs text-canvas-text-muted">{t('仅导入所选资产及其绑定媒体；同名条目会作为新副本追加。')}</p>
    </header>
    <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-canvas-text-secondary">
      {(['character', 'scene', 'prop'] as const).map((kind) => <span key={kind}>
        {t(DRAMA_ASSET_KIND_LABEL[kind])} {preview.items.filter((item) => item.kind === kind).length}
      </span>)}
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm ml-auto" onClick={() => {
        setSelected(selected.size === preview.items.length ? new Set() : new Set(preview.items.map((item) => `${item.kind}:${item.id}`)));
      }}>{selected.size === preview.items.length ? t('取消全选') : t('全选')}</button>
    </div>
    <div className="ui-list min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label={t('资产包内容')}>
      {preview.items.map((item, index) => {
        const key = `${item.kind}:${item.id}`;
        const bytes = item.mediaIds.reduce((total, mediaId) => total + (mediaById.get(mediaId)?.bytes ?? 0), 0);
        return <div key={key} className="ui-list__item relative">
          <input id={`${checkboxId}-${index}`} type="checkbox" className="ui-checkbox" checked={selected.has(key)}
            onChange={(event) => {
              const checked = event.target.checked;
              setSelected((current) => {
                const next = new Set(current);
                if (checked) next.add(key); else next.delete(key);
                return next;
              });
            }} />
          <label htmlFor={`${checkboxId}-${index}`} className="w-full min-w-0">
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm text-canvas-text">{item.name}</span>
              <span className="block text-xs text-canvas-text-muted">
                {t(DRAMA_ASSET_KIND_LABEL[item.kind])} · {t('{count} 份媒体 · {size}', { count: item.mediaIds.length, size: formatSize(bytes) })}
              </span>
              {item.sameName && <span className="block text-xs text-canvas-text-secondary">{t('存在同名条目，将新增副本')}</span>}
            </span>
          </label>
        </div>;
      })}
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      <p role="status" aria-live="polite" className="mr-auto text-xs text-canvas-text-secondary">
        {t('已选 {count} 项资产，{mediaCount} 份媒体，共 {size}', {
          count: summary.items.length, mediaCount: summary.mediaCount, size: formatSize(summary.bytes),
        })}
      </p>
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => onChoose(null)}>{t('取消')}</button>
      <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!summary.items.length}
        onClick={() => onChoose(summary.items.map(({ kind, id }) => ({ kind, id })))}>{t('导入所选资产')}</button>
    </footer>
  </ModalOverlay>;
}
