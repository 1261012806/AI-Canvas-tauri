import { t, useT } from '../../i18n';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import type { AssetFolderEntry, AssetFolderSelection } from '../../services/fileService';
import type { DramaAssetCategory } from '../../types/dramaAssets';
import { DRAMA_ASSET_CATEGORY_LABEL } from '../../types/dramaAssets';

export interface AssetFolderNavigationProps {
  folders: AssetFolderEntry[];
  selection: AssetFolderSelection;
  totalCount: number;
  globalCount: number;
  compact: boolean;
  loading: boolean;
  readOnly?: boolean;
  onSelect: (selection: AssetFolderSelection) => void;
  onRemove?: (rootPath: string) => void;
  onRepair?: (rootPath: string) => void;
  globalRootPath: string | null;
  onCreate?: (selection: AssetFolderSelection, name: string) => Promise<void>;
  onOpen?: (selection: AssetFolderSelection) => void;
  onCopy?: (selection: AssetFolderSelection) => void;
  onPaste?: (selection: AssetFolderSelection) => void;
  dropTarget?: AssetFolderSelection | null;
  creativeKind?: DramaAssetCategory | null;
  creativeCounts?: Partial<Record<DramaAssetCategory, number>>;
  onSelectCreative?: (kind: DramaAssetCategory) => void;
}

function folderKey(folder: AssetFolderEntry): string {
  return JSON.stringify([folder.rootPath, folder.relativePath]);
}

const folderMotionClass = ' [transition:transform_var(--transition-base)] motion-reduce:transition-none';
const folderDropClass = ' outline outline-1 outline-dashed outline-brand -outline-offset-1 motion-safe:scale-[1.02]';

export default function AssetFolderNavigation({
  folders, selection, totalCount, globalCount, compact, loading, readOnly = false, onSelect, onRemove, onRepair,
  globalRootPath, onCreate, onOpen, onCopy, onPaste, dropTarget,
  creativeKind, creativeCounts, onSelectCreative,
}: AssetFolderNavigationProps) {
  useT();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ selection: AssetFolderSelection; label: string; x: number; y: number; repair?: boolean } | null>(null);
  const [creating, setCreating] = useState<{ selection: AssetFolderSelection; label: string } | null>(null);
  const [name, setName] = useState('新建文件夹');
  const [error, setError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const canManageFolders = !readOnly && !!(onCreate || onOpen || onCopy || onPaste);
  const canRepairFolders = !readOnly && !!onRepair;
  const externalRoots = folders.filter((folder) => folder.parentRelativePath === null && folder.rootPath !== globalRootPath);
  const closeMenu = () => { setMenu(null); triggerRef.current?.focus?.(); };
  useEffect(() => {
    if (!menu || !(menu.repair ? canRepairFolders : canManageFolders)) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      if (menu.repair && event.target instanceof Node && triggerRef.current?.contains(event.target)) return;
      setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setMenu(null); triggerRef.current?.focus?.();
    };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [menu, canManageFolders, canRepairFolders]);
  const openMenu = (event: MouseEvent<HTMLElement>, target: AssetFolderSelection, label: string) => {
    event.preventDefault(); event.stopPropagation();
    if (!canManageFolders || loading || target.kind === 'all') return;
    triggerRef.current = event.currentTarget;
    setMenu({ selection: target, label, x: Math.max(4, Math.min(event.clientX, (window.innerWidth || 1280) - 188)),
      y: Math.max(4, Math.min(event.clientY, (window.innerHeight || 720) - 176)) });
  };
  const children = useMemo(() => {
    const map = new Map<string, AssetFolderEntry[]>();
    for (const folder of folders) {
      const key = JSON.stringify([folder.rootPath, folder.parentRelativePath]);
      const group = map.get(key) ?? [];
      group.push(folder);
      map.set(key, group);
    }
    for (const group of map.values()) group.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    return map;
  }, [folders]);
  const selectedFolder = selection.kind === 'folder'
    ? folders.find((folder) => folder.rootPath === selection.rootPath && folder.relativePath === selection.relativePath)
    : undefined;
  const label = selection.kind === 'all' ? t('全部资产') : selection.kind === 'global' ? t('导入文件') : selectedFolder?.name ?? t('文件夹');

  const renderFolder = (folder: AssetFolderEntry) => {
    const key = folderKey(folder);
    const childFolders = children.get(key) ?? [];
    const isExpanded = expanded[key] ?? (folder.parentRelativePath === null
      || selection.kind === 'folder' && selection.rootPath === folder.rootPath
      && selection.relativePath.startsWith(`${folder.relativePath}/`));
    const selected = !creativeKind && selection.kind === 'folder' && selection.rootPath === folder.rootPath
      && selection.relativePath === folder.relativePath;
    const receiving = !readOnly && dropTarget?.kind === 'folder' && dropTarget.rootPath === folder.rootPath && dropTarget.relativePath === folder.relativePath;
    const removable = !readOnly && !!onRemove && folder.parentRelativePath === null && folder.rootPath !== globalRootPath;
    return (
      <li key={key}>
        <div className={`assets-folder-item${removable ? ' assets-folder-item--removable' : ''}${folderMotionClass}${selected || receiving ? ' is-active' : ''}${receiving ? folderDropClass : ''}`}
          data-asset-folder-target={!readOnly && !loading && folder.availability === 'online' ? JSON.stringify({ kind: 'folder', rootPath: folder.rootPath, relativePath: folder.relativePath }) : undefined}>
          {childFolders.length > 0 ? (
            <button type="button" className="ui-icon-btn ui-icon-btn--sm assets-folder-toggle"
              aria-label={t('{action}文件夹 {name}', { action: isExpanded ? t('收起') : t('展开'), name: folder.name })} aria-expanded={isExpanded}
              onClick={() => setExpanded((previous) => ({ ...previous, [key]: !isExpanded }))}>
              <Icon icon={isExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'} aria-hidden="true" />
            </button>
          ) : <span className="assets-folder-toggle" />}
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm assets-folder-select"
            aria-label={t('浏览文件夹 {name}', { name: folder.name })} aria-pressed={selected}
            title={folder.relativePath || folder.name} disabled={loading || folder.availability === 'unscanned'}
            aria-haspopup={canManageFolders ? 'menu' : undefined}
            onContextMenu={canManageFolders ? (event) => {
              if (folder.availability === 'online') openMenu(event, { kind: 'folder', rootPath: folder.rootPath, relativePath: folder.relativePath }, folder.name);
              else event.preventDefault();
            } : undefined}
            onClick={() => {
              onSelect({ kind: 'folder', rootPath: folder.rootPath, relativePath: folder.relativePath });
              if (childFolders.length > 0) setExpanded((previous) => ({ ...previous, [key]: true }));
            }}>
            <Icon icon={folder.availability === 'offline' ? 'lucide:folder-x' : selected ? 'lucide:folder-open' : 'lucide:folder'}
              className="shrink-0 text-canvas-text-secondary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left">{folder.name}</span>
            <span className="ui-list__trailing">{receiving ? t('放入') : folder.availability === 'online' ? folder.fileCount : '—'}</span>
          </button>
          {!readOnly && onRemove && folder.parentRelativePath === null && folder.rootPath !== globalRootPath && (
            <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--danger assets-folder-remove"
              aria-label={t('移除文件夹引用 {name}', { name: folder.name })} title={t("取消引用，保留本地文件")} disabled={loading}
              onClick={() => onRemove(folder.rootPath)}>
              <Icon icon="lucide:x" aria-hidden="true" />
            </button>
          )}
        </div>
        {isExpanded && childFolders.length > 0 && (
          <ul className="assets-folder-children">{childFolders.map(renderFolder)}</ul>
        )}
      </li>
    );
  };
  const creativeNavigation = onSelectCreative && <>
    <h4 className="px-2 pb-1 pt-3 text-xs text-canvas-text-muted">{t("创作分类")}</h4>
    {([{ kind: 'character', label: t('人物'), icon: 'lucide:contact-round' },
      { kind: 'scene', label: t('场景'), icon: 'lucide:landmark' },
      { kind: 'prop', label: t('道具'), icon: 'lucide:box' },
      { kind: 'weapon', label: t('武器'), icon: 'lucide:swords' }] as const).map((item) => (
      <div key={item.kind} className={`assets-folder-item${creativeKind === item.kind ? ' is-active' : ''}`}>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm assets-folder-select" aria-pressed={creativeKind === item.kind}
          onClick={() => onSelectCreative(item.kind)}>
          <Icon icon={item.icon} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">{t(item.label)}</span>
          <span className="ui-list__trailing">{creativeCounts?.[item.kind] ?? 0}</span>
        </button>
      </div>
    ))}
    <h4 className="px-2 pb-1 pt-3 text-xs text-canvas-text-muted">{t("文件夹")}</h4>
  </>;
  const navigation = (
    <nav aria-label={t("全局资产分类与文件夹")} className="assets-folder-navigation">
      {!compact && <h3 className="px-2 pb-2 text-xs font-medium text-canvas-text-secondary">{t("全局资产")}</h3>}
      {[{ kind: 'all' as const, label: t('全部资产'), count: totalCount, icon: 'lucide:folders' },
        { kind: 'global' as const, label: t('导入文件'), count: globalCount, icon: 'lucide:folder-down' }].map((item) => (
        <div key={item.kind}>
        {item.kind === 'global' && creativeNavigation}
        <div className={`assets-folder-item${folderMotionClass}${(!creativeKind && selection.kind === item.kind) || (!readOnly && dropTarget?.kind === item.kind) ? ' is-active' : ''}${!readOnly && dropTarget?.kind === item.kind ? folderDropClass : ''}`}
          data-asset-folder-target={!readOnly && !loading && item.kind === 'global' && globalRootPath ? JSON.stringify({ kind: 'global' }) : undefined}>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm assets-folder-select"
            aria-label={t(item.label)} aria-pressed={!creativeKind && selection.kind === item.kind} disabled={loading}
            aria-haspopup={canManageFolders && item.kind === 'global' ? 'menu' : undefined}
            onContextMenu={canManageFolders ? (event) => openMenu(event, { kind: item.kind }, t(item.label)) : undefined}
            onClick={() => onSelect({ kind: item.kind })}>
            <Icon icon={item.icon} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left">{t(item.label)}</span>
            <span className="ui-list__trailing">{item.count}</span>
          </button>
        </div>
        </div>
      ))}
      {globalRootPath && <ul className="assets-folder-children">
        {(children.get(JSON.stringify([globalRootPath, ''])) ?? []).map(renderFolder)}
      </ul>}
      <div className="assets-folder-section-header">
        <h4 className="min-w-0 text-xs text-canvas-text-muted">{t("外部文件夹")}</h4>
        {canRepairFolders && externalRoots.length > 0 && <button type="button"
          className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--ghost assets-folder-repair" disabled={loading}
          aria-label={t('重新定位文件夹')} title={t('重新定位文件夹')}
          aria-haspopup={externalRoots.length > 1 ? 'menu' : undefined}
          aria-expanded={externalRoots.length > 1 ? !!menu?.repair : undefined}
          onClick={(event) => {
            if (!onRepair) return;
            if (externalRoots.length === 1) { onRepair(externalRoots[0].rootPath); return; }
            if (menu?.repair) { closeMenu(); return; }
            triggerRef.current = event.currentTarget;
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ selection: { kind: 'all' }, label: t('外部文件夹'), repair: true,
              x: Math.max(4, Math.min(rect.right - 176, (window.innerWidth || 1280) - 188)),
              y: Math.max(4, Math.min(rect.bottom + 4, (window.innerHeight || 720) - 176)) });
          }}><Icon icon="lucide:folder-search" aria-hidden="true" /></button>}
      </div>
      <ul className="assets-folder-roots">{externalRoots.map(renderFolder)}</ul>
      {!loading && !folders.some((folder) => folder.rootPath !== globalRootPath) && <p className="p-2 text-xs text-canvas-text-muted">{readOnly ? t('暂无外部文件夹') : t('从“添加”中选择本地文件夹')}</p>}
      {!readOnly && onCreate && creating && <form className="flex flex-col gap-2 p-2" aria-label={t("新建子文件夹")} onSubmit={(event) => {
        event.preventDefault();
        if (readOnly || loading || !onCreate) return;
        setError('');
        void onCreate(creating.selection, name).then(() => {
          const parent = creating.selection;
          if (parent.kind === 'folder') setExpanded((previous) => ({ ...previous, [JSON.stringify([parent.rootPath, parent.relativePath])]: true }));
          setCreating(null);
        }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '创建失败，请检查目录权限'));
      }} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCreating(null); }
      }}>
        <label className="text-xs text-canvas-text-secondary" htmlFor="asset-subfolder-name">{t('在 {name} 中新建', { name: creating.label })}</label>
        <input id="asset-subfolder-name" className="ui-input ui-input--sm" aria-label={t("子文件夹名称")} autoFocus
          value={name} disabled={loading} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setName(event.target.value)} />
        {error && <p role="alert" className="text-xs text-canvas-text-secondary">{t(error)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={loading} onClick={() => setCreating(null)}>{t("取消")}</button>
          <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={loading || !name.trim()}>{t("创建")}</button></div>
      </form>}
      {menu && (menu.repair ? canRepairFolders : canManageFolders) && createPortal(<div ref={menuRef} role="menu" aria-label={t('{name} 文件夹操作', { name: menu.label })}
        className={`ui-menu w-44${menu.repair ? ' ui-scroll' : ''}`} style={{ position: 'fixed', zIndex: 320, left: menu.x, top: menu.y,
          maxHeight: menu.repair ? Math.max(48, Math.min(320, (window.innerHeight || 720) - menu.y - 8)) : undefined }}
        onKeyDown={(event) => {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
          } else if (event.key === 'Tab') closeMenu();
        }}>
        {menu.repair ? externalRoots.map((folder, index) => <button key={folder.rootPath} type="button" role="menuitem" autoFocus={index === 0}
          className="ui-menu__item" disabled={loading} title={folder.rootPath}
          aria-label={t('重新定位文件夹 {name}', { name: folder.name })} onClick={() => { closeMenu(); onRepair?.(folder.rootPath); }}>
          <Icon icon="lucide:folder-search" className="shrink-0" aria-hidden="true" /><span className="min-w-0 truncate">{folder.name}</span>
        </button>) : <>
        {onOpen && <button type="button" role="menuitem" autoFocus className="ui-menu__item" onClick={() => { onOpen(menu.selection); closeMenu(); }}><Icon icon="lucide:folder-open" aria-hidden="true" />{t("打开文件夹位置")}</button>}
        {onCreate && <button type="button" role="menuitem" autoFocus={!onOpen} className="ui-menu__item" onClick={() => {
          setCreating({ selection: menu.selection, label: menu.label }); setName('新建文件夹'); setError(''); closeMenu();
        }}><Icon icon="lucide:folder-plus" aria-hidden="true" />{t("新建子文件夹")}</button>}
        {onCopy && <button type="button" role="menuitem" autoFocus={!onOpen && !onCreate} className="ui-menu__item" onClick={() => { onCopy(menu.selection); closeMenu(); }}><Icon icon="lucide:copy" aria-hidden="true" />{t("复制文件夹")}</button>}
        {onPaste && <button type="button" role="menuitem" autoFocus={!onOpen && !onCreate && !onCopy} className="ui-menu__item" onClick={() => { onPaste(menu.selection); closeMenu(); }}><Icon icon="lucide:clipboard-paste" aria-hidden="true" />{t("粘贴")}</button>}
        </>}
      </div>, document.body)}
    </nav>
  );
  return compact ? (
    <details className="assets-folder-picker">
      <summary className="ui-btn ui-btn--ghost ui-btn--sm">
        <Icon icon="lucide:folder" aria-hidden="true" />{creativeKind ? t('创作分类 · {kind}', { kind: t(DRAMA_ASSET_CATEGORY_LABEL[creativeKind]) }) : t('文件夹 · {name}', { name: label })}
        <Icon icon="lucide:chevron-down" className="ml-auto" aria-hidden="true" />
      </summary>
      {navigation}
    </details>
  ) : navigation;
}
