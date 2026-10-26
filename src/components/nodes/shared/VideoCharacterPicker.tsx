import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import MentionPicker, { type MentionPickerItem } from '../../shared/MentionPicker';
import { AVATAR_ASPECT } from '../../character/characterReferencePresentation';
import { calcAnchoredPosition } from '../../../utils/popupPosition';
import { useT } from '../../../i18n';

interface VideoCharacterPickerProps {
  anchorRef: RefObject<HTMLButtonElement | null>;
  projectItems: MentionPickerItem[];
  globalItems: MentionPickerItem[];
  globalLoading?: boolean;
  onReloadGlobal: () => void;
  onClose: () => void;
}

/** 视频参数的独立角色浮层；来源与写入仍由宿主提供。 */
export default function VideoCharacterPicker({
  anchorRef, projectItems, globalItems, globalLoading = false, onReloadGlobal, onClose,
}: VideoCharacterPickerProps) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [query, setQuery] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [highlightedKey, setHighlightedKey] = useState<string>();
  const sourceItems = scope === 'project' ? projectItems : globalItems;
  const searchTerm = query.trim().toLocaleLowerCase();
  const filteredItems = sourceItems.filter((item) => !searchTerm
    || `${item.label}\n${item.title ?? ''}`.toLocaleLowerCase().includes(searchTerm));
  const enabledItems = filteredItems.filter((item) => !item.disabled);
  const activeKey = enabledItems.find((item) => item.key === highlightedKey)?.key ?? enabledItems[0]?.key;

  const selectItem = (item: MentionPickerItem) => {
    if (item.disabled) return;
    item.onSelect();
    anchorRef.current?.focus({ preventScroll: true });
  };
  const items = filteredItems.map((item, index) => ({
    ...item,
    domId: `${listId}-${scope}-${index}`,
    onSelect: () => selectItem(item),
  }));
  const changeScope = (next: string) => {
    if (next !== 'project' && next !== 'global') return;
    setScope(next);
    setHighlightedKey(undefined);
  };

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = anchorRef.current;
    if (!menu || !anchor) return;
    const position = () => {
      const next = calcAnchoredPosition(anchor.getBoundingClientRect(), menu.offsetWidth, menu.offsetHeight, 6, 12);
      menu.style.left = `${next.left}px`;
      menu.style.top = `${next.top}px`;
    };
    position();
    menu.focus({ preventScroll: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    observer?.observe(menu);
    observer?.observe(anchor);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
      // 保留用户点击其它输入或按钮的焦点意图；点击空白则交回触发按钮。
      const focusTarget = target instanceof Element && target.closest('button, a[href], input, select, textarea, [contenteditable], [tabindex]');
      if (!focusTarget) anchorRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', outside, true);
    return () => document.removeEventListener('mousedown', outside, true);
  }, [anchorRef, onClose]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (searchExpanded) {
        setQuery('');
        setSearchExpanded(false);
        menuRef.current?.focus({ preventScroll: true });
      } else {
        onClose();
        anchorRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('button');
    if (button?.disabled) return;
    const tab = target?.closest('[role="tab"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      const tabs = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
      const current = tabs.indexOf(tab as HTMLButtonElement);
      const next = (current + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0) + 2) % 2;
      changeScope(next === 0 ? 'project' : 'global');
      tabs[next]?.focus({ preventScroll: true });
      return;
    }
    const input = target?.closest('input, textarea, [contenteditable]');
    const option = target?.closest('[role="option"]');
    if (event.key === 'Enter' || (event.key === ' ' && !input)) {
      // 重试和搜索按钮保留原生 click；卡片由这里补齐键盘选择。
      if (button && !option) return;
      event.preventDefault();
      const item = option ? items.find((entry) => entry.domId === option.id)
        : items.find((entry) => entry.key === activeKey);
      if (item) item.onSelect();
      return;
    }
    const direction = event.key === 'ArrowDown' || (!input && event.key === 'ArrowRight') ? 1
      : event.key === 'ArrowUp' || (!input && event.key === 'ArrowLeft') ? -1 : 0;
    const edge = !input && (event.key === 'Home' || event.key === 'End');
    if (!direction && !edge) return;
    event.preventDefault();
    if (!enabledItems.length) return;
    const current = enabledItems.findIndex((item) => item.key === activeKey);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabledItems.length - 1
      : (current + direction + enabledItems.length) % enabledItems.length;
    const key = enabledItems[next].key;
    setHighlightedKey(key);
    if (!input) {
      const id = items.find((item) => item.key === key)?.domId;
      const options = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      Array.from(options ?? []).find((item) => item.id === id)?.focus({ preventScroll: true });
    }
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={menuRef} role="dialog" aria-label={t(scope === 'project' ? '本项目角色' : '全局角色')} tabIndex={-1}
      data-ui-select-portal="" className="fixed z-[10000] w-[336px] max-w-[calc(100vw-24px)] nodrag nopan nowheel"
      onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        // 指针已在卡片 mousedown 选择；纯 click 补齐辅助技术的激活入口。
        if (event.detail !== 0 || !(event.target instanceof Element)) return;
        const target = event.target;
        if (target.closest('button')?.disabled) return;
        const tab = target.closest('[role="tab"]');
        if (tab) {
          const tabs = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
          const index = tabs.indexOf(tab as HTMLButtonElement);
          if (index >= 0) changeScope(index === 0 ? 'project' : 'global');
          return;
        }
        const option = target.closest('[role="option"]');
        items.find((item) => item.domId === option?.id)?.onSelect();
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) onClose();
      }}
      onWheel={(event) => event.stopPropagation()}
      onKeyDownCapture={(event) => { if (event.key === 'Escape') handleKeyDown(event); }} onKeyDown={handleKeyDown}>
      <MentionPicker
        tabs={[{ id: 'project', label: t('本项目角色') }, { id: 'global', label: t('全局角色') }]}
        activeTab={scope} onTabChange={changeScope} items={items} activeKey={activeKey}
        onItemHover={setHighlightedKey} listId={listId} ariaLabel={t(scope === 'project' ? '本项目角色' : '全局角色')}
        mediaAspectRatio={AVATAR_ASPECT}
        emptyText={scope === 'global' && globalLoading ? t('正在读取全局角色…')
          : searchTerm ? t('没有匹配的角色') : t('当前范围暂无角色，请先在角色库新建')}
        search={{ expanded: searchExpanded, onExpandedChange: setSearchExpanded, value: query,
          onChange: (value) => { setQuery(value); setHighlightedKey(undefined); },
          label: t('搜索资源'), placeholder: t('搜索角色、身份或简介'), onKeyDown: handleKeyDown,
          onCollapse: () => menuRef.current?.focus({ preventScroll: true }) }}
        footer={scope === 'global' && globalItems.length === 0
          ? <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={globalLoading} onClick={onReloadGlobal}>{t('重试')}</button>
          : undefined}
      />
    </div>, document.body,
  );
}
