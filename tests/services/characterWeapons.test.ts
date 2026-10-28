import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import {
  emptyDramaAssetLibrary, MAX_CHARACTER_WEAPONS, normalizeCharacterWeaponIds, normalizeDramaCharacter,
  type DramaCharacter, type DramaProp,
} from '../../src/types/dramaAssets';
import { getDramaAssetCategory, matchesDramaAssetCategory } from '../../src/services/dramaAssetSearch';
import { expandCharacterWeaponDependencies, remapCharacterWeaponIds } from '../../src/services/characterWeapons';
import { matchesAssetUsage } from '../../src/services/assetUsageService';
import {
  deleteGlobalDramaAsset, getAllGlobalCharacters, getAllGlobalDramaAssets,
  putGlobalCharacter, putGlobalCharacterWeapons, putGlobalDramaAsset,
} from '../../src/services/indexedDbService';
import { openDB, STORE_GLOBAL_CHARACTERS, STORE_GLOBAL_DRAMA_ASSETS } from '../../src/services/indexedDb/schema';

const base = (id: string) => ({ id, key: id, name: id, summary: '资产说明', visualNotes: '',
  importance: 'supporting' as const, confirmed: true, createdAt: 1, updatedAt: 1, source: 'manual' as const });
const character = (id = 'hero', weaponIds?: string[]): DramaCharacter => ({ ...base(id), kind: 'character', identity: '角色', weaponIds });
const weapon = (id = 'sword'): DramaProp => ({ ...base(id), kind: 'prop', propType: 'weapon' });
const prop = (id = 'cup'): DramaProp => ({ ...base(id), kind: 'prop', category: '武器' });

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'episode', projectLoadStatus: 'ready', switchingProjectName: null,
    isCreatingProject: false, isReturningToStartPage: false,
    projects: [{ id: 'series', name: '剧集', createdAt: 1, updatedAt: 1 },
      { id: 'episode', parentId: 'series', name: '第一集', createdAt: 1, updatedAt: 1 }],
    dramaAssets: { ...emptyDramaAssetLibrary(), characters: [character()], props: [weapon(), prop()] },
    globalCharacters: [character('global-hero')], globalProps: [weapon('global-sword')],
    showToast: vi.fn(), saveCurrentProjectSilent: vi.fn(async () => 'episode'),
  });
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_GLOBAL_CHARACTERS, STORE_GLOBAL_DRAMA_ASSETS], 'readwrite');
    tx.objectStore(STORE_GLOBAL_CHARACTERS).clear();
    tx.objectStore(STORE_GLOBAL_DRAMA_ASSETS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
});

describe('武器分类、身份与依赖', () => {
  it('固定 propType 决定分类，自由文本不把普通道具变成武器', () => {
    expect(getDramaAssetCategory(weapon())).toBe('weapon');
    expect(getDramaAssetCategory(prop())).toBe('prop');
    expect(matchesDramaAssetCategory(weapon(), 'prop')).toBe(false);
    expect(matchesDramaAssetCategory(weapon(), 'weapon')).toBe(true);
  });

  it('绑定 ID 去重有界，拒绝全局前缀和非身份文本，但保留尚未落地的合法依赖', () => {
    expect(normalizeCharacterWeaponIds(['sword', 'sword', 'global/sword', '../sword', null])).toEqual(['sword']);
    expect(normalizeCharacterWeaponIds(Array.from({ length: 100 }, (_, index) => `weapon-${index}`))).toHaveLength(MAX_CHARACTER_WEAPONS);
    expect(normalizeDramaCharacter(character('hero', ['not-downloaded-yet'])).weaponIds).toEqual(['not-downloaded-yet']);
  });

  it('单角色复制扩出武器，多角色共享依赖只带一份', () => {
    const sword = weapon();
    const heroes = [character('hero-1', ['sword']), character('hero-2', ['sword'])];
    const expanded = expandCharacterWeaponDependencies(heroes, [...heroes, sword, prop()]);
    expect(expanded.map((asset) => asset.id)).toEqual(['hero-1', 'hero-2', 'sword']);
    expect(() => expandCharacterWeaponDependencies(heroes, heroes)).toThrow();
    expect(() => expandCharacterWeaponDependencies(heroes, [...heroes, { ...sword, propType: undefined }])).toThrow();
  });

  it('整批分配目标 ID 后恢复关联，不保留源库 ID 或按名称匹配', () => {
    const result = remapCharacterWeaponIds(character('hero', ['sword']), new Map([['prop:sword', 'target-sword']]));
    expect(result.kind === 'character' && result.weaponIds).toEqual(['target-sword']);
    expect(() => remapCharacterWeaponIds(character('hero', ['sword']), new Map())).toThrow();
  });

  it('使用位置只命中同库同 owner 的真实武器关联', () => {
    const value = character('hero', ['sword']);
    const target = { kind: 'creative' as const, scope: 'project' as const, assetKind: 'prop' as const,
      assetId: 'sword', ownerId: 'series', name: '剑' };
    expect(matchesAssetUsage(value, target, { ownerId: 'series' })).toBe(true);
    expect(matchesAssetUsage(value, target, { ownerId: 'other' })).toBe(false);
    expect(matchesAssetUsage(value, target, { global: true, ownerId: 'series' })).toBe(false);
    expect(matchesAssetUsage(value, { ...target, scope: 'global' }, { global: true })).toBe(true);
    expect(matchesAssetUsage(value, { ...target, scope: 'global' }, { ownerId: 'series' })).toBe(false);
  });
});

describe('角色武器 Store 操作', () => {
  it('无图武器可以绑定，同剧共享库校验后等待保存且去重', async () => {
    const state = useAppStore.getState();
    await expect(state.setCharacterWeapons('project', 'hero', ['sword', 'sword'])).resolves.toBe(true);
    expect(useAppStore.getState().dramaAssets.characters[0].weaponIds).toEqual(['sword']);
    expect(state.saveCurrentProjectSilent).toHaveBeenCalledOnce();
    expect(useAppStore.getState().nodes).toEqual([]);
  });

  it('普通道具、缺失武器与跨库 ID 均拒绝，不写入角色或触发保存', async () => {
    const initial = useAppStore.getState();
    for (const id of ['cup', 'missing', 'global-sword', 'global/sword']) {
      await expect(initial.setCharacterWeapons('project', 'hero', [id])).resolves.toBe(false);
    }
    await expect(initial.setCharacterWeapons('global', 'global-hero', ['sword'])).resolves.toBe(false);
    expect(initial.saveCurrentProjectSilent).not.toHaveBeenCalled();
    expect(useAppStore.getState().dramaAssets.characters[0].weaponIds).toBeUndefined();
  });

  it('弹窗已取消时不接受绑定', async () => {
    const controller = new AbortController();
    controller.abort();
    const state = useAppStore.getState();
    await expect(state.setCharacterWeapons('project', 'hero', ['sword'], { signal: controller.signal })).resolves.toBe(false);
    expect(state.saveCurrentProjectSilent).not.toHaveBeenCalled();
  });

  it('保存期间切项目不向新项目投影，也不报告旧弹窗成功', async () => {
    let finish!: (id: string) => void;
    useAppStore.setState({ saveCurrentProjectSilent: () => new Promise<string>((resolve) => { finish = resolve; }) });
    const pending = useAppStore.getState().setCharacterWeapons('project', 'hero', ['sword']);
    const other = { ...emptyDramaAssetLibrary(), characters: [character('other-hero')], props: [] };
    useAppStore.setState({ currentProjectId: 'other', dramaAssets: other });
    finish('episode');
    await expect(pending).resolves.toBe(false);
    expect(useAppStore.getState().dramaAssets).toBe(other);
  });

  it('保存失败只回滚关联，保留期间其他角色字段的修改', async () => {
    let finish!: (id: undefined) => void;
    useAppStore.setState({ saveCurrentProjectSilent: () => new Promise<undefined>((resolve) => { finish = resolve; }) });
    const pending = useAppStore.getState().setCharacterWeapons('project', 'hero', ['sword']);
    useAppStore.setState((state) => ({ dramaAssets: { ...state.dramaAssets,
      characters: state.dramaAssets.characters.map((item) => ({ ...item, summary: '后来修改的角色说明' })) } }));
    finish(undefined);
    await expect(pending).resolves.toBe(false);
    expect(useAppStore.getState().dramaAssets.characters[0]).toMatchObject({ summary: '后来修改的角色说明', weaponIds: undefined });
  });

  it('切走再切回仍拒绝旧弹窗的成功结果', async () => {
    let finish!: (id: string) => void;
    useAppStore.setState({ saveCurrentProjectSilent: () => new Promise<string>((resolve) => { finish = resolve; }) });
    const pending = useAppStore.getState().setCharacterWeapons('project', 'hero', ['sword']);
    useAppStore.setState({ currentProjectId: 'other' });
    useAppStore.setState({ currentProjectId: 'episode' });
    finish('episode');
    await expect(pending).resolves.toBe(false);
  });

  it('删除武器清理所有同库角色关联，保留人物与其他道具', () => {
    useAppStore.setState((state) => ({ dramaAssets: { ...state.dramaAssets,
      characters: [character('hero-1', ['sword']), character('hero-2', ['sword'])] } }));
    useAppStore.getState().deleteDramaAsset('prop', 'sword');
    expect(useAppStore.getState().dramaAssets.characters.map((item) => item.weaponIds)).toEqual([[], []]);
    expect(useAppStore.getState().dramaAssets.props.map((item) => item.id)).toEqual(['cup']);
  });

  it('普通道具清空与武器清空互不影响，武器清空同步解绑', () => {
    useAppStore.setState((state) => ({ dramaAssets: { ...state.dramaAssets, characters: [character('hero', ['sword'])] } }));
    useAppStore.getState().clearDramaAssetsByKind('prop');
    expect(useAppStore.getState().dramaAssets.props.map((item) => item.id)).toEqual(['sword']);
    expect(useAppStore.getState().dramaAssets.characters[0].weaponIds).toEqual(['sword']);
    useAppStore.getState().clearDramaAssetsByKind('weapon');
    expect(useAppStore.getState().dramaAssets.props).toEqual([]);
    expect(useAppStore.getState().dramaAssets.characters[0].weaponIds).toEqual([]);
  });

  it('所有项目保存入口拒绝将仍被绑定的武器降为普通道具', async () => {
    useAppStore.setState((state) => ({ dramaAssets: { ...state.dramaAssets, characters: [character('hero', ['sword'])] } }));
    const state = useAppStore.getState();
    expect(state.updateDramaAssetFields('prop', 'sword', { propType: undefined })).toBe(false);
    expect(state.upsertDramaAsset({ ...weapon(), propType: undefined })).toBe(false);
    await expect(state.saveDramaVisualAsset('project', { ...weapon(), propType: undefined })).resolves.toBe(false);
    expect(useAppStore.getState().dramaAssets.props[0].propType).toBe('weapon');
  });

  it('通用角色保存也校验武器，缺省字段保留绑定，明确空数组才解绑', async () => {
    const state = useAppStore.getState();
    await expect(state.saveCharacterCard('project', character('hero', ['cup']))).resolves.toBe(false);
    await expect(state.setCharacterWeapons('project', 'hero', ['sword'])).resolves.toBe(true);
    await expect(state.saveCharacterCard('project', { ...character(), summary: '新说明' })).resolves.toBe(true);
    expect(useAppStore.getState().dramaAssets.characters[0].weaponIds).toEqual(['sword']);
    await expect(state.setCharacterWeapons('project', 'hero', [])).resolves.toBe(true);
    expect(useAppStore.getState().dramaAssets.characters[0].weaponIds).toEqual([]);
  });
});

describe('全局武器关联的原子持久化', () => {
  it('全局 Store 绑定等待事务完成，并同时更新本库角色而不影响项目角色', async () => {
    await putGlobalDramaAsset(weapon('global-sword'));
    await putGlobalCharacter(character('global-hero'));
    await expect(useAppStore.getState().setCharacterWeapons('global', 'global-hero', ['global-sword'])).resolves.toBe(true);
    expect(useAppStore.getState().globalCharacters[0].weaponIds).toEqual(['global-sword']);
    expect((await getAllGlobalCharacters())[0].weaponIds).toEqual(['global-sword']);
    expect(useAppStore.getState().dramaAssets.characters[0].weaponIds).toBeUndefined();
  });

  it('等值重载换对象引用不被误认成并发角色编辑', async () => {
    await putGlobalDramaAsset(weapon('global-sword'));
    await putGlobalCharacter(character('global-hero'));
    const pending = useAppStore.getState().setCharacterWeapons('global', 'global-hero', ['global-sword']);
    useAppStore.setState((state) => ({ globalCharacters: structuredClone(state.globalCharacters) }));
    await expect(pending).resolves.toBe(true);
    expect(useAppStore.getState().globalCharacters[0].weaponIds).toEqual(['global-sword']);
  });

  it('绑定事务拒绝缺失或非武器目标，只 patch 关联字段', async () => {
    await putGlobalDramaAsset(weapon('global-sword'));
    await putGlobalDramaAsset(prop('global-cup'));
    await putGlobalCharacter(character('global-hero'));
    await expect(putGlobalCharacterWeapons('global-hero', ['global-cup'])).rejects.toThrow();
    await expect(putGlobalCharacterWeapons('global-hero', ['missing'])).rejects.toThrow();
    await putGlobalCharacterWeapons('global-hero', ['global-sword', 'global-sword']);
    expect((await getAllGlobalCharacters())[0]).toMatchObject({ summary: '资产说明', weaponIds: ['global-sword'] });
  });

  it('普通角色保存和武器降级在两表事务中复核，解绑后才允许转换', async () => {
    await putGlobalDramaAsset(weapon('global-sword'));
    await putGlobalCharacter(character('global-hero', ['global-sword']));
    await expect(putGlobalCharacter(character('other-hero', ['missing']))).rejects.toThrow();
    await expect(putGlobalDramaAsset({ ...weapon('global-sword'), propType: undefined })).rejects.toThrow();
    expect((await getAllGlobalDramaAssets())[0]).toMatchObject({ kind: 'prop', propType: 'weapon' });
    await putGlobalCharacterWeapons('global-hero', []);
    await expect(putGlobalDramaAsset({ ...weapon('global-sword'), propType: undefined })).resolves.toBeUndefined();
  });

  it('全局删除武器同时解绑角色，Store 同轮刷新并保留其他角色内容', async () => {
    await putGlobalDramaAsset(weapon('global-sword'));
    const hero = { ...character('global-hero', ['global-sword']), voiceNotes: '声音设定保留' };
    await putGlobalCharacter(hero);
    useAppStore.setState({ globalCharacters: [hero] });
    await expect(useAppStore.getState().deleteGlobalDramaAsset('prop', 'global-sword')).resolves.toBe(true);
    expect((await getAllGlobalCharacters())[0]).toMatchObject({ voiceNotes: '声音设定保留', weaponIds: [] });
    expect(useAppStore.getState().globalCharacters[0].weaponIds).toEqual([]);
    expect(await getAllGlobalDramaAssets()).toEqual([]);
  });

  it('删除事务取消时武器和角色关联都保留', async () => {
    await putGlobalDramaAsset(weapon('global-sword'));
    await putGlobalCharacter(character('global-hero', ['global-sword']));
    let calls = 0;
    await expect(deleteGlobalDramaAsset('global-sword', { assertCurrent: () => {
      if (++calls >= 3) throw new Error('取消删除');
    } })).rejects.toThrow();
    expect((await getAllGlobalCharacters())[0].weaponIds).toEqual(['global-sword']);
    expect(await getAllGlobalDramaAssets()).toHaveLength(1);
  });
});
