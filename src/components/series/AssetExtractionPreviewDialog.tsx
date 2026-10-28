import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';
import type { DramaAsset } from '../../types/dramaAssets';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';

interface AssetExtractionPreviewDialogProps {
  title: string;
  items: readonly Pick<DramaAsset, 'id' | 'kind' | 'name' | 'summary' | 'visualNotes'>[];
  existingItems?: readonly Pick<DramaAsset, 'name' | 'summary'>[];
  confirmLabel?: string;
  onConfirm: (selectedIds: string[]) => Promise<void>;
  onClose: () => void;
}

const nameKey = (name: string) => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();

/** 提取结果只在确认后交给宿主；本弹窗不写项目或资产库。 */
export default function AssetExtractionPreviewDialog({
  title, items, existingItems = [], confirmLabel, onConfirm, onClose,
}: AssetExtractionPreviewDialogProps) {
  const t = useT();
  const checkboxId = useId();
  const existingByName = useMemo(() => new Map(existingItems.map((item) => [nameKey(item.name), item])), [existingItems]);
  const [selectedIds, setSelectedIds] = useState(() => new Set(items
    .filter((item) => !existingByName.has(nameKey(item.name))).map((item) => item.id)));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  const [error, setError] = useState('');
  const term = query.trim().toLocaleLowerCase();
  const filtered = items.filter((item) => !term || `${item.name}\n${item.summary}`.toLocaleLowerCase().includes(term));
  const selectable = filtered.filter((item) => !existingByName.has(nameKey(item.name)));
  const selected = items.filter((item) => selectedIds.has(item.id) && !existingByName.has(nameKey(item.name)));
  const allSelected = selectable.length > 0 && selectable.every((item) => selectedIds.has(item.id));
  const close = () => { if (!busyRef.current) onClose(); };
  const toggle = (id: string) => setSelectedIds((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const submit = async () => {
    if (busyRef.current || !selected.length) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await onConfirm(selected.map((item) => item.id));
      if (aliveRef.current) onClose();
    } catch (cause) {
      if (aliveRef.current) setError(cause instanceof Error ? cause.message : t('保存提取结果失败'));
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  return (
    <ModalOverlay isOpen onClose={close} ariaLabel={title} zIndex={330}
      className="ui-dialog-surface w-[min(720px,calc(100vw-24px))] max-h-[85vh]">
      <div className="flex shrink-0 items-center gap-2 border-b border-canvas-border p-3">
        <Icon icon="lucide:scan-text" className="h-4 w-4 shrink-0 text-canvas-text-secondary" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        <PopupCloseButton onClick={close} disabled={busy} />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 p-3">
        <div className="ui-input-group min-w-0 flex-1">
          <span className="ui-input-affix"><Icon icon="lucide:search" className="h-3.5 w-3.5" /></span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            aria-label={t('搜索提取结果')} placeholder={t('搜索名称、简介…')} className="ui-input ui-input--sm" disabled={busy} />
        </div>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || !selectable.length}
          onClick={() => setSelectedIds((previous) => {
            const next = new Set(previous);
            for (const item of selectable) { if (allSelected) next.delete(item.id); else next.add(item.id); }
            return next;
          })}>{allSelected ? t('取消全选') : t('选择可新增项')}</button>
      </div>
      <p className="shrink-0 px-3 pb-2 text-xs text-canvas-text-muted">
        {t('提取结果尚未入库。同名已有条目仅供比较，原内容与绑定保持不变。')}
      </p>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3" aria-busy={busy}>
        {filtered.map((item, index) => {
          const previous = existingByName.get(nameKey(item.name));
          const id = `${checkboxId}-${index}`;
          return (
            <div key={item.id} className="ui-card p-3">
              <div className="flex items-start gap-2">
                <span className="relative mt-1 shrink-0">
                  <input id={id} type="checkbox" checked={!previous && selectedIds.has(item.id)}
                    disabled={busy || Boolean(previous)} onChange={() => toggle(item.id)} className="ui-checkbox" />
                  <label htmlFor={id}><span className="sr-only">{t('选择{name}', { name: item.name })}</span></label>
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <h3 className="break-words text-sm font-medium text-canvas-text">{item.name}</h3>
                  {item.summary && <p className="whitespace-pre-wrap break-words text-xs text-canvas-text-secondary">{item.summary}</p>}
                  {item.visualNotes && <p className="whitespace-pre-wrap break-words text-xs text-canvas-text-muted">{item.visualNotes}</p>}
                  {previous && <div className="border-t border-canvas-border pt-2 text-xs text-canvas-text-muted">
                    <p className="font-medium">{t('已存在，保留原条目')}</p>
                    {previous.summary && <p className="mt-1 whitespace-pre-wrap break-words">{previous.summary}</p>}
                  </div>}
                </div>
              </div>
            </div>
          );
        })}
        {!filtered.length && <p role="status" className="py-6 text-center text-xs text-canvas-text-muted">
          {items.length ? t('没有匹配的提取结果') : t('没有提取到条目，原清单保持不变')}
        </p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-canvas-border p-3">
        <span className="text-xs text-canvas-text-muted">{t('已选择 {count} 项', { count: selected.length })}</span>
        <div className="flex items-center gap-2">
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={close}>{t('取消')}</button>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !selected.length} onClick={() => { void submit(); }}>
            {busy && <Icon icon="lucide:loader-circle" className="h-3.5 w-3.5 animate-spin" />}
            {busy ? t('正在保存…') : confirmLabel ?? t('确认加入资产库')}
          </button>
        </div>
        {error && <p role="alert" className="ui-error w-full break-words">{error}</p>}
      </div>
    </ModalOverlay>
  );
}
