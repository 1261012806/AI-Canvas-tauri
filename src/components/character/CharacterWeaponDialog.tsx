import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { Sword, Swords } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import { MAX_CHARACTER_WEAPONS } from '../../types/dramaAssets';
import { resolveDramaAssetImageRef } from '../../services/dramaAssetPrompt';
import { configValuesEqual } from '../../services/configPatch';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import ViewportImage from '../shared/ViewportImage';

/** 仅管理同库业务关联，不为生成节点自动追加武器参考。 */
export default function CharacterWeaponDialog({ scope, characterId, onClose }: {
  scope: 'project' | 'global'; characterId: string; onClose: () => void;
}) {
  const t = useT();
  const listId = useId();
  const { character, props, nodes, projectId, loading, loadError, loadGlobalDramaAssets, setCharacterWeapons } = useAppStore(useShallow((state) => ({
    character: (scope === 'project' ? state.dramaAssets.characters : state.globalCharacters).find((item) => item.id === characterId),
    props: scope === 'project' ? state.dramaAssets.props : state.globalProps,
    nodes: state.nodes, projectId: state.currentProjectId,
    loading: scope === 'global' && state.globalDramaAssetsLoading,
    loadError: scope === 'global' ? state.globalDramaAssetsError : null,
    loadGlobalDramaAssets: state.loadGlobalDramaAssets, setCharacterWeapons: state.setCharacterWeapons,
  })));
  const origin = useRef({ character, projectId });
  const alive = useRef(true);
  const controller = useRef(new AbortController());
  const busyRef = useRef(false);
  const [selected, setSelected] = useState(() => new Set(character?.weaponIds ?? []));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    if (scope === 'global') void loadGlobalDramaAssets().catch(() => undefined);
    return () => { alive.current = false; controller.current.abort(); };
  }, [loadGlobalDramaAssets, scope]);
  const weapons = props.filter((item) => item.propType === 'weapon');
  const term = query.trim().toLocaleLowerCase();
  const visible = weapons.filter((item) => !term || `${item.name}\n${item.summary}\n${item.visualNotes}`.toLocaleLowerCase().includes(term));
  const unavailable = [...selected].filter((id) => !weapons.some((item) => item.id === id));
  const close = () => { if (!busyRef.current) onClose(); };
  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_CHARACTER_WEAPONS) next.add(id);
      return next;
    });
  };
  const save = async () => {
    if (busyRef.current || loading || loadError) return;
    const assertCurrent = () => {
      const state = useAppStore.getState();
      const current = (scope === 'project' ? state.dramaAssets.characters : state.globalCharacters)
        .find((item) => item.id === characterId);
      const previous = origin.current.character;
      const unchanged = current && previous && Object.keys({ ...previous, ...current }).every((key) =>
        key === 'weaponIds' || key === 'updatedAt'
          || configValuesEqual(current[key as keyof typeof current], previous[key as keyof typeof previous]));
      if (!alive.current || state.currentProjectId !== origin.current.projectId || !unchanged) {
        throw new Error(t('角色或项目已变化，请重新选择武器'));
      }
    };
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      assertCurrent();
      const latest = useAppStore.getState();
      const current = (scope === 'project' ? latest.dramaAssets.characters : latest.globalCharacters).find((item) => item.id === characterId);
      if (!configValuesEqual(current, origin.current.character)) throw new Error(t('角色或项目已变化，请重新选择武器'));
      if (!await setCharacterWeapons(scope, characterId, [...selected], { assertCurrent, signal: controller.current.signal })) throw new Error(t('角色武器保存失败，请重试'));
      if (alive.current) onClose();
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : t('角色武器保存失败，请重试'));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <ModalOverlay isOpen onClose={close} ariaLabel={t('绑定角色武器')} zIndex={320}
      className="ui-dialog-surface w-[min(640px,calc(100vw-24px))] max-h-[85vh]">
      <div className="flex shrink-0 items-center gap-2 border-b border-canvas-border p-3">
        <Swords className="h-4 w-4 shrink-0" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('绑定角色武器')} · {character?.name}</h2>
        <PopupCloseButton onClick={close} disabled={busy} />
      </div>
      <div className="shrink-0 space-y-2 p-3">
        <p className="text-xs text-canvas-text-muted">{t('仅显示同一资产库的武器；绑定不会自动加入生成参考。')}</p>
        <div className="ui-input-group">
          <span className="ui-input-affix"><Icon icon="lucide:search" className="h-3.5 w-3.5" /></span>
          <input type="search" className="ui-input ui-input--sm" value={query} disabled={busy}
            aria-label={t('搜索武器')} placeholder={t('搜索武器名称、简介…')} onChange={(event) => setQuery(event.target.value)} />
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3" aria-busy={loading || busy}>
        {unavailable.map((id) => <div key={id} className="ui-card flex-row items-center gap-2 p-2">
          <Icon icon="lucide:triangle-alert" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 break-all text-xs text-canvas-text-muted">{t('失效武器绑定')} · {id}</span>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || loading} onClick={() => toggle(id)}>{t('移除绑定')}</button>
        </div>)}
        {visible.map((weapon, index) => {
          const image = resolveDramaAssetImageRef(weapon, scope === 'project' ? nodes : [])?.imageUrl;
          const id = `${listId}-${index}`;
          return <div key={weapon.id} className="ui-card flex flex-row items-center gap-2 p-2">
            <input id={id} type="checkbox" className="ui-checkbox"
              checked={selected.has(weapon.id)} disabled={busy || loading || (!selected.has(weapon.id) && selected.size >= MAX_CHARACTER_WEAPONS)}
              onChange={() => toggle(weapon.id)} />
            <label htmlFor={id} className="flex min-w-0 flex-1 items-center gap-2">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-canvas-border bg-canvas-surface">
              {image ? <ViewportImage src={image} alt="" className="h-full w-full object-contain" />
                : <Sword className="h-5 w-5 text-canvas-text-muted" />}
            </span>
            <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{weapon.name}</span>
              <span className="block break-words text-xs text-canvas-text-muted">{weapon.summary}</span></span>
            </label>
          </div>;
        })}
        {!visible.length && <p className="p-3 text-center text-xs text-canvas-text-muted">
          {loading ? t('正在加载武器…') : term ? t('没有匹配的武器') : t('当前资产库还没有武器')}
        </p>}
        {loadError && <div role="alert" className="space-y-2"><p className="ui-error">{t('武器加载失败，请重试')}</p>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy || loading} onClick={() => void loadGlobalDramaAssets().catch(() => undefined)}>{t('重试')}</button></div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-canvas-border p-3">
        <span className="text-xs text-canvas-text-muted">{t('已选武器 {count}/{max}', { count: selected.size, max: MAX_CHARACTER_WEAPONS })}</span>
        <div className="flex items-center gap-2"><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={close}>{t('取消')}</button>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || loading || !!loadError || !character || unavailable.length > 0}
            onClick={() => void save()}>{busy ? t('正在保存…') : t('保存武器绑定')}</button></div>
        {error && <p role="alert" className="ui-error w-full break-words">{error}</p>}
      </div>
    </ModalOverlay>
  );
}
