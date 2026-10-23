import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import type { AssetFolderEntry, AssetFolderSelection } from '../../services/fileService';
import type { DramaAssetKind } from '../../types/dramaAssets';

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
  globalRootPath: string | null;
  onCreate?: (selection: AssetFolderSelection, name: string) => Promise<void>;
  onOpen?: (selection: AssetFolderSelection) => void;
  onCopy?: (selection: AssetFolderSelection) => void;
  onPaste?: (selection: AssetFolderSelection) => void;
  dropTarget?: AssetFolderSelection | null;
  creativeKind?: DramaAssetKind | null;
  creativeCounts?: Record<DramaAssetKind, number>;
  onSelectCreative?: (kind: DramaAssetKind) => void;
}

function folderKey(folder: AssetFolderEntry): string {
  return JSON.stringify([folder.rootPath, folder.relativePath]);
}

const folderMotionClass = ' [transition:transform_var(--transition-base)] motion-reduce:transition-none';
const folderDropClass = ' outline outline-1 outline-dashed outline-brand -outline-offset-1 motion-safe:scale-[1.02]';

export default function AssetFolderNavigation({
  folders, selection, totalCount, globalCount, compact, loading, readOnly = false, onSelect, onRemove,
  globalRootPath, onCreate, onOpen, onCopy, onPaste, dropTarget,
  creativeKind, creativeCounts, onSelectCreative,
}: AssetFolderNavigationProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ selection: AssetFolderSelection; label: string; x: number; y: number } | null>(null);
  const [creating, setCreating] = useState<{ selection: AssetFolderSelection; label: string } | null>(null);
  const [name, setName] = useState('新建文件夹');
  const [error, setError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const canManageFolders = !readOnly && !!(onCreate || onOpen || onCopy || onPaste);
  const closeMenu = () => { setMenu(null); triggerRef.current?.focus?.(); };
  useEffect(() => {
    if (!menu || !canManageFolders) return;
    const dismiss = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
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
  }, [menu, canManageFolders]);
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
  const label = selection.kind === 'all' ? '全部资产' : selection.kind === 'global' ? '导入文件' : selectedFolder?.name ?? '文件夹';

  const renderFolder = (folder: AssetFolderEntry) => {
    const key = folderKey(folder);
    const childFolders = children.get(key) ?? [];
    const isExpanded = expanded[key] ?? (folder.parentRelativePath === null
      || selection.kind === 'folder' && selection.rootPath === folder.rootPath
      && selection.relativePath.startsWith(`${folder.relativePath}/`));
    const selected = !creativeKind && selection.kind === 'folder' && selection.rootPath === folder.rootPath
      && selection.relativePath === folder.relativePath;
    const receiving = !readOnly && dropTarget?.kind === 'folder' && dropTarget.rootPath === folder.rootPath && dropTarget.relativePath === folder.relativePath;
    return (
      <li key={key}>
        <div className={`assets-folder-item${folderMotionClass}${selected || receiving ? ' is-active' : ''}${receiving ? folderDropClass : ''}`}
          data-asset-folder-target={!readOnly && !loading && folder.availability === 'online' ? JSON.stringify({ kind: 'folder', rootPath: folder.rootPath, relativePath: folder.relativePath }) : undefined}>
          {childFolders.length > 0 ? (
            <button type="button" className="ui-icon-btn ui-icon-btn--sm assets-folder-toggle"
              aria-label={`${isExpanded ? '收起' : '展开'}文件夹 ${folder.name}`} aria-expanded={isExpanded}
              onClick={() => setExpanded((previous) => ({ ...previous, [key]: !isExpanded }))}>
              <Icon icon={isExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'} aria-hidden="true" />
            </button>
          ) : <span className="assets-folder-toggle" />}
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm assets-folder-select"
            aria-label={`浏览文件夹 ${folder.name}`} aria-pressed={selected}
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
            <span className="ui-list__trailing">{receiving ? '放入' : folder.availability === 'online' ? folder.fileCount : '—'}</span>
          </button>
          {!readOnly && onRemove && folder.parentRelativePath === null && folder.rootPath !== globalRootPath && (
            <button type="button" className="ui-icon-btn ui-icon-btn--sm ui-icon-btn--danger assets-folder-remove"
              aria-label={`移除文件夹引用 ${folder.name}`} title="取消引用，保留本地文件" disabled={loading}
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
    <h4 className="px-2 pb-1 pt-3 text-xs text-canvas-text-muted">创作分类</h4>
    {([{ kind: 'character', label: '人物', icon: 'lucide:contact-round' },
      { kind: 'scene', label: '场景', icon: 'lucide:landmark' },
      { kind: 'prop', label: '道具', icon: 'lucide:box' }] as const).map((item) => (
      <div key={item.kind} className={`assets-folder-item${creativeKind === item.kind ? ' is-active' : ''}`}>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm assets-folder-select" aria-pressed={creativeKind === item.kind}
          onClick={() => onSelectCreative(item.kind)}>
          <Icon icon={item.icon} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
          <span className="ui-list__trailing">{creativeCounts?.[item.kind] ?? 0}</span>
        </button>
      </div>
    ))}
    <h4 className="px-2 pb-1 pt-3 text-xs text-canvas-text-muted">文件夹</h4>
  </>;
  const navigation = (
    <nav aria-label="全局资产分类与文件夹" className="assets-folder-navigation">
      {!compact && <h3 className="px-2 pb-2 text-xs font-medium text-canvas-text-secondary">全局资产</h3>}
      {[{ kind: 'all' as const, label: '全部资产', count: totalCount, icon: 'lucide:folders' },
        { kind: 'global' as const, label: '导入文件', count: globalCount, icon: 'lucide:folder-down' }].map((item) => (
        <div key={item.kind}>
        {item.kind === 'global' && creativeNavigation}
        <div className={`assets-folder-item${folderMotionClass}${(!creativeKind && selection.kind === item.kind) || (!readOnly && dropTarget?.kind === item.kind) ? ' is-active' : ''}${!readOnly && dropTarget?.kind === item.kind ? folderDropClass : ''}`}
          data-asset-folder-target={!readOnly && !loading && item.kind === 'global' && globalRootPath ? JSON.stringify({ kind: 'global' }) : undefined}>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm assets-folder-select"
            aria-label={item.label} aria-pressed={!creativeKind && selection.kind === item.kind} disabled={loading}
            aria-haspopup={canManageFolders && item.kind === 'global' ? 'menu' : undefined}
            onContextMenu={canManageFolders ? (event) => openMenu(event, { kind: item.kind }, item.label) : undefined}
            onClick={() => onSelect({ kind: item.kind })}>
            <Icon icon={item.icon} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
            <span className="ui-list__trailing">{item.count}</span>
          </button>
        </div>
        </div>
      ))}
      {globalRootPath && <ul className="assets-folder-children">
        {(children.get(JSON.stringify([globalRootPath, ''])) ?? []).map(renderFolder)}
      </ul>}
      <h4 className="px-2 pb-1 pt-3 text-xs text-canvas-text-muted">外部文件夹</h4>
      <ul className="assets-folder-roots">{folders.filter((folder) => folder.parentRelativePath === null && folder.rootPath !== globalRootPath).map(renderFolder)}</ul>
      {!loading && !folders.some((folder) => folder.rootPath !== globalRootPath) && <p className="p-2 text-xs text-canvas-text-muted">{readOnly ? '暂无外部文件夹' : '从“添加”中选择本地文件夹'}</p>}
      {!readOnly && onCreate && creating && <form className="flex flex-col gap-2 p-2" aria-label="新建子文件夹" onSubmit={(event) => {
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
        <label className="text-xs text-canvas-text-secondary" htmlFor="asset-subfolder-name">在 {creating.label} 中新建</label>
        <input id="asset-subfolder-name" className="ui-input ui-input--sm" aria-label="子文件夹名称" autoFocus
          value={name} disabled={loading} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setName(event.target.value)} />
        {error && <p role="alert" className="text-xs text-canvas-text-secondary">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={loading} onClick={() => setCreating(null)}>取消</button>
          <button type="submit" className="ui-btn ui-btn--primary ui-btn--sm" disabled={loading || !name.trim()}>创建</button></div>
      </form>}
      {canManageFolders && menu && createPortal(<div ref={menuRef} role="menu" aria-label={`${menu.label} 文件夹操作`}
        className="ui-menu w-44" style={{ position: 'fixed', zIndex: 320, left: menu.x, top: menu.y }}
        onKeyDown={(event) => {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
          } else if (event.key === 'Tab') closeMenu();
        }}>
        {onOpen && <button type="button" role="menuitem" autoFocus className="ui-menu__item" onClick={() => { onOpen(menu.selection); closeMenu(); }}><Icon icon="lucide:folder-open" aria-hidden="true" />打开文件夹位置</button>}
        {onCreate && <button type="button" role="menuitem" autoFocus={!onOpen} className="ui-menu__item" onClick={() => {
          setCreating({ selection: menu.selection, label: menu.label }); setName('新建文件夹'); setError(''); closeMenu();
        }}><Icon icon="lucide:folder-plus" aria-hidden="true" />新建子文件夹</button>}
        {onCopy && <button type="button" role="menuitem" autoFocus={!onOpen && !onCreate} className="ui-menu__item" onClick={() => { onCopy(menu.selection); closeMenu(); }}><Icon icon="lucide:copy" aria-hidden="true" />复制文件夹</button>}
        {onPaste && <button type="button" role="menuitem" autoFocus={!onOpen && !onCreate && !onCopy} className="ui-menu__item" onClick={() => { onPaste(menu.selection); closeMenu(); }}><Icon icon="lucide:clipboard-paste" aria-hidden="true" />粘贴</button>}
      </div>, document.body)}
    </nav>
  );
  return compact ? (
    <details className="assets-folder-picker">
      <summary className="ui-btn ui-btn--ghost ui-btn--sm">
        <Icon icon="lucide:folder" aria-hidden="true" />{creativeKind ? `创作分类 · ${{ character: '人物', scene: '场景', prop: '道具' }[creativeKind]}` : `文件夹 · ${label}`}
        <Icon icon="lucide:chevron-down" className="ml-auto" aria-hidden="true" />
      </summary>
      {navigation}
    </details>
  ) : navigation;
}
