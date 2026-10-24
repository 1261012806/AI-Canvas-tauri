import { useMemo, useState } from 'react';
import type { DramaAsset } from '../types/dramaAssets';
import { dramaAssetIdentityKey, matchesDramaAssetQuery, sortDramaAssets, type DramaAssetSortBy } from '../services/dramaAssetSearch';
import { useAppStore } from '../store/useAppStore';

/** 选择只作用于当前可见卡片；切换筛选后不会暗中导出隐藏项。 */
export function useDramaAssetList(source: readonly DramaAsset[], search: string, scopeKey: string) {
  const configuredBy = useAppStore((state) => state.config.creativeAssetSortBy);
  const configuredOrder = useAppStore((state) => state.config.creativeAssetSortOrder);
  const updateConfig = useAppStore((state) => state.updateConfig);
  const sortBy: DramaAssetSortBy = configuredBy === 'name' || configuredBy === 'createdAt' ? configuredBy : 'updatedAt';
  const sortOrder = configuredOrder === 'asc' ? 'asc' : 'desc';
  const [selecting, setSelecting] = useState(false);
  const selectionScope = `${scopeKey}\u0000${search}`;
  const [selection, setSelection] = useState<{ scope: string; keys: Set<string> }>(() => ({ scope: selectionScope, keys: new Set() }));
  if (selection.scope !== selectionScope) setSelection({ scope: selectionScope, keys: new Set() });
  const items = useMemo(() => sortDramaAssets(source.filter((asset) => matchesDramaAssetQuery(asset, search)), sortBy, sortOrder),
    [source, search, sortBy, sortOrder]);
  const selected = useMemo(() => selection.scope === selectionScope
    ? items.filter((asset) => selection.keys.has(dramaAssetIdentityKey(asset))) : [], [items, selection, selectionScope]);
  const selectedKeys = useMemo(() => new Set(selected.map(dramaAssetIdentityKey)), [selected]);
  const toggle = (asset: DramaAsset) => setSelection((previous) => {
    const keys = previous.scope === selectionScope ? new Set(previous.keys) : new Set<string>();
    const key = dramaAssetIdentityKey(asset);
    if (keys.has(key)) keys.delete(key); else keys.add(key);
    return { scope: selectionScope, keys };
  });
  return { items, sortBy, sortOrder, selecting, selected, selectedKeys, toggle,
    changeSort: (by: DramaAssetSortBy, order: 'asc' | 'desc') => { updateConfig({ creativeAssetSortBy: by, creativeAssetSortOrder: order }); },
    clearSelection: () => setSelection({ scope: selectionScope, keys: new Set() }),
    toggleSelecting: () => { setSelecting((value) => !value); setSelection({ scope: selectionScope, keys: new Set() }); },
    selectAll: () => setSelection({ scope: selectionScope,
      keys: selected.length === items.length ? new Set() : new Set(items.map(dramaAssetIdentityKey)) }),
  };
}
