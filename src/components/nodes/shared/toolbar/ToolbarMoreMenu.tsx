/**
 * ToolbarMoreMenu — 收纳用户从节点工具栏隐藏的内置按钮。
 */
import { useT } from '../../../../i18n';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@iconify/react';
import type { ToolbarButtonDef } from '../../../../types';
import AnimatedButton from '../../../shared/AnimatedButton';

interface ToolbarMoreMenuProps {
  items: ToolbarButtonDef[];
  renderItem: (key: string) => ReactNode;
}

function ToolbarMoreMenu({ items, renderItem }: ToolbarMoreMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const toggleMenu = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setOpen((current) => !current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as globalThis.Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="toolbar-more-wrap nodrag">
      <AnimatedButton
        type="button"
        className={`ftb-btn icon-only act-more${open ? ' is-active' : ''}`}
        data-tooltip={t('更多')}
        aria-label={t('更多')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleMenu}
      >
        <Icon icon="mdi:dots-horizontal" width={14} height={14} />
      </AnimatedButton>

      {open && (
        <div
          className="toolbar-more-menu nodrag"
          role="menu"
          aria-label={t('已隐藏的工具栏按钮')}
          onClick={(event) => {
            event.stopPropagation();
            const target = event.target as HTMLElement;
            if (!target.closest('.act-multigrid')) setOpen(false);
          }}
        >
          {items.length > 0 ? (
            items.map((item) => (
              <div key={item.key} className="toolbar-more-menu-item">
                {renderItem(item.key)}
              </div>
            ))
          ) : (
            <div className="toolbar-more-menu-empty">{t('暂无隐藏按钮')}</div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(ToolbarMoreMenu);
