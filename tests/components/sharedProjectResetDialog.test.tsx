import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { SharedAssetSyncStatus, SharedProjectResetPreview } from '../../src/types/assetSync';

const driver = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  memos: [] as Array<{ deps: readonly unknown[]; value: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>,
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0,
  state: {} as AppState, preview: vi.fn(), apply: vi.fn(), cancel: vi.fn(), cancelPreview: vi.fn(), recover: vi.fn(),
  release: vi.fn(), confirm: vi.fn(), onClose: vi.fn(),
  syncLoad: vi.fn(), syncPreview: vi.fn(), syncApply: vi.fn(), syncCancel: vi.fn(),
}));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  return {
    ...actual,
    memo: <T,>(component: T) => component,
    useState: <T,>(initial: T | (() => T)) => {
      const index = driver.stateIndex++;
      if (!(index in driver.states)) driver.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [driver.states[index], (next: T | ((old: T) => T)) => {
        driver.states[index] = typeof next === 'function' ? (next as (old: T) => T)(driver.states[index] as T) : next;
      }];
    },
    useRef: <T,>(initial?: T) => (driver.refs[driver.refIndex++] ??= { current: initial }),
    useCallback: <T,>(value: T, deps: readonly unknown[]) => {
      const index = driver.memoIndex++;
      if (!same(driver.memos[index]?.deps, deps)) driver.memos[index] = { deps, value };
      return driver.memos[index].value;
    },
    useMemo: <T,>(factory: () => T, deps: readonly unknown[]) => {
      const index = driver.memoIndex++;
      if (!same(driver.memos[index]?.deps, deps)) driver.memos[index] = { deps, value: factory() };
      return driver.memos[index].value;
    },
    useEffect: (effect: () => (() => void) | void, deps?: readonly unknown[]) => {
      const index = driver.effectIndex++;
      if (!same(driver.effects[index]?.deps, deps)) {
        driver.effects[index]?.cleanup?.();
        driver.effects[index] = { deps, cleanup: effect() || undefined };
      }
    },
  };
});
vi.mock('../../src/i18n', () => ({ useT: () => (key: string, params?: Record<string, string | number>) =>
  Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), key) }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: Object.assign(
  <T,>(selector: (state: AppState) => T) => selector(driver.state), { getState: () => driver.state },
) }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => true }));
vi.mock('../../src/services/fs/sharedAssetStorage', () => ({
  getSharedProjectPrefix: () => 'safe-prefix', parseSharedProjectCode: vi.fn(), sharedStorageErrorMessage: (code: string) => code,
}));
vi.mock('../../src/services/confirmDialog', () => ({ confirmAction: driver.confirm }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: 'modal' }));
vi.mock('../../src/components/shared/Select', () => ({ default: 'select-control' }));
vi.mock('../../src/components/assets/SharedProjectSyncPanel', () => ({ default: 'sync-panel' }));

import SharedProjectBindingDialog from '../../src/components/assets/SharedProjectBindingDialog';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value && typeof value === 'object' && 'props' in value ? text((value as Element).props.children) : '';
}
function render() {
  driver.stateIndex = driver.refIndex = driver.memoIndex = driver.effectIndex = 0;
  return SharedProjectBindingDialog({ localOwnerId: 'owner', ownerName: '测试项目', onClose: driver.onClose });
}
function unmountView() {
  driver.effects.forEach((effect) => effect?.cleanup?.());
  driver.states = []; driver.refs = []; driver.effects = []; driver.memos = [];
}
async function renderSyncPanel(autoPreview = false, enabled = true) {
  const { default: SharedProjectSyncPanel } = await vi.importActual<
    typeof import('../../src/components/assets/SharedProjectSyncPanel')
  >('../../src/components/assets/SharedProjectSyncPanel');
  driver.stateIndex = driver.refIndex = driver.memoIndex = driver.effectIndex = 0;
  const Panel = SharedProjectSyncPanel as unknown as (props: { ownerId: string; enabled: boolean; autoPreview: boolean }) => unknown;
  return Panel({ ownerId: 'owner', enabled, autoPreview });
}
function syncStatus(stage: SharedAssetSyncStatus['stage']) {
  const value: SharedAssetSyncStatus = {
    ownerId: 'owner', stage, items: [{ id: 'asset', name: '后台素材.png', kind: 'file', direction: 'upload' }],
    completed: 1, total: 3,
    ...(stage === 'syncing' ? { progress: { ownerId: 'owner', taskId: 'task', operationId: 'operation',
      phase: 'uploading' as const, transferredBytes: 1024 * 1024, totalBytes: 3 * 1024 * 1024 } } : {}),
    ...(stage === 'completed' ? { lastSyncedAt: 1700000000000 } : {}),
    ...(stage === 'paused' || stage === 'failed' ? { error: '待恢复的同步说明' } : {}),
  };
  driver.state.sharedAssetSyncStatus = { owner: value };
  return value;
}
function button(tree: unknown, label: string) {
  const found = elements(tree).find((element) => element.type === 'button' && text(element.props.children) === label);
  expect(found, `missing button: ${label}`).toBeDefined();
  return found!;
}
function click(tree: unknown, label: string) { (button(tree, label).props.onClick as () => void)(); }
function confirmMembers() {
  const tree = render();
  const input = elements(tree).find((element) => element.type === 'input' && element.props.type === 'checkbox')!;
  (input.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
  return render();
}
function status(stage: 'idle' | 'previewing' | 'preview' | 'applying') {
  driver.state.sharedProjectResetStatus = { owner: { stage } };
}
const preview: SharedProjectResetPreview = { mode: 'clear', objectCount: 4, bytes: 1024, previewToken: 'opaque-token' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  driver.states = []; driver.refs = []; driver.effects = []; driver.memos = [];
  for (const mock of [driver.preview, driver.apply, driver.cancel, driver.cancelPreview, driver.recover, driver.release,
    driver.confirm, driver.onClose, driver.syncLoad, driver.syncPreview, driver.syncApply, driver.syncCancel]) mock.mockReset();
  driver.state = {
    currentProjectId: 'owner', projectInitialized: true, projectLoadStatus: 'ready',
    projects: [{ id: 'owner' }], sharedAssetSyncStatus: {}, sharedProjectResetStatus: {},
    sharedAssetStorage: { bindings: [{ ownerId: 'owner', connectionId: 'connection', connectionRevision: 'v1',
      libraryId: 'library', sharedProjectId: 'project', capabilities: { multiplayerWritable: true, checks: [] } }],
      connections: [{ id: 'connection', revision: 'v1', credentialsSaved: true }] },
    loadSharedAssetStorage: vi.fn(async () => undefined), cancelSharedProjectSync: driver.syncCancel,
    loadSharedProjectSyncState: driver.syncLoad, previewSharedProjectSync: driver.syncPreview,
    syncSharedProjectNow: driver.syncApply, releaseSharedProjectSyncConflict: driver.release,
    cancelSharedStorageOperation: vi.fn(async () => undefined),
    previewSharedProjectReset: driver.preview, applySharedProjectReset: driver.apply,
    cancelSharedProjectReset: driver.cancel, cancelSharedProjectResetPreview: driver.cancelPreview, recoverSharedProjectReset: driver.recover,
  } as unknown as AppState;
  driver.recover.mockImplementation(async () => { status('idle'); return { state: 'none' }; });
  driver.preview.mockImplementation(async (_owner: string, mode: 'clear' | 'delete') => {
    status('preview'); return { ...preview, mode };
  });
  driver.apply.mockImplementation(async () => { status('idle'); return { status: 'completed', deletedCount: 4, totalCount: 4 }; });
  driver.cancelPreview.mockImplementation(async () => { status('idle'); });
  driver.confirm.mockResolvedValue(false);
  driver.release.mockResolvedValue(undefined);
  for (const mock of [driver.syncLoad, driver.syncPreview, driver.syncApply, driver.syncCancel]) mock.mockResolvedValue(undefined);
});
afterEach(() => driver.effects.forEach((effect) => effect?.cleanup?.()));

describe('shared cloud cleanup', () => {
  it('closes the sharing dialog without pausing an ongoing sync', () => {
    const running = syncStatus('syncing');
    const tree = render();
    click(tree, '关闭');
    expect(driver.onClose).toHaveBeenCalledOnce();
    expect(driver.syncCancel).not.toHaveBeenCalled();
    unmountView();
    expect(driver.syncCancel).not.toHaveBeenCalled();
    expect(driver.state.sharedAssetSyncStatus.owner).toBe(running);
  });

  it('requires member confirmation again after switching away and back', () => {
    render(); expect(button(confirmMembers(), '清空共享资产库').props.disabled).toBe(false);
    driver.state.projects = [{ id: 'owner' }, { id: 'other' }] as AppState['projects'];
    driver.state.currentProjectId = 'other'; render();
    driver.state.currentProjectId = 'owner';
    expect(button(render(), '清空共享资产库').props.disabled).toBe(true);
  });

  it('requires members paused and the project name before deleting', async () => {
    let tree = render(); expect(button(tree, '清空共享资产库').props.disabled).toBe(true);
    click(confirmMembers(), '清空共享资产库');
    await vi.waitFor(() => expect(driver.preview).toHaveBeenCalledWith('owner', 'clear'));
    tree = render();
    expect(text(tree)).toContain('预览时快照：4 个云对象，约 1.0 KB。');
    expect(text(tree)).toContain('本地资产不变');
    expect(button(tree, '确认清空共享资产库').props.disabled).toBe(true);
    const input = elements(tree).find((element) => element.type === 'input' && element.props.autoComplete === 'off')!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '测试项目' } });
    click(render(), '确认清空共享资产库');
    await vi.waitFor(() => expect(driver.apply).toHaveBeenCalledWith('owner', 'clear', 'opaque-token'));
    expect(text(render())).toContain('云端项目资产已清空，共享标识已保留。');
  });

  it('reports partial deletion and requires a new preview', async () => {
    render(); click(confirmMembers(), '删除共享资产库');
    await vi.waitFor(() => expect(driver.preview).toHaveBeenCalledWith('owner', 'delete'));
    let tree = render(); expect(text(tree)).toContain('本地绑定和资产不变');
    const input = elements(tree).find((element) => element.type === 'input' && element.props.autoComplete === 'off')!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '测试项目' } });
    driver.apply.mockImplementation(async () => { status('idle'); return { status: 'failed', deletedCount: 2, totalCount: 4 }; });
    click(render(), '确认删除共享资产库');
    await vi.waitFor(() => expect(driver.apply).toHaveBeenCalledOnce());
    tree = render(); expect(text(tree)).toContain('操作未完成，已确认删除 2 / 4 个对象；实际结果请重新预览核对');
    expect(text(tree)).not.toContain('云端共享资产库已删除');
    expect(button(tree, '删除共享资产库').props.disabled).toBe(true);
  });

  it('shows real deletion progress and delegates cancellation', async () => {
    render(); click(confirmMembers(), '清空共享资产库');
    await vi.waitFor(() => expect(driver.preview).toHaveBeenCalled());
    let tree = render();
    const input = elements(tree).find((element) => element.type === 'input' && element.props.autoComplete === 'off')!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '测试项目' } });
    const pending = deferred();
    driver.apply.mockImplementation(async () => {
      driver.state.sharedProjectResetStatus = { owner: { stage: 'applying', progress: { deletedCount: 2, totalCount: 4 } } };
      await pending.promise; status('idle'); return { status: 'cancelled', deletedCount: 2, totalCount: 4 };
    });
    click(render(), '确认清空共享资产库'); tree = render();
    expect(text(tree)).toContain('已确认删除 2 / 4 个对象');
    click(tree, '取消'); await vi.waitFor(() => expect(driver.cancelPreview).toHaveBeenCalledWith('owner'));
    pending.resolve(); await vi.waitFor(() => expect(text(render())).toContain('操作未完成，已确认删除 2 / 4 个对象'));
  });

  it('does not report success when the cloud snapshot changes', async () => {
    render(); click(confirmMembers(), '清空共享资产库');
    await vi.waitFor(() => expect(driver.preview).toHaveBeenCalled());
    const tree = render();
    const input = elements(tree).find((element) => element.type === 'input' && element.props.autoComplete === 'off')!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '测试项目' } });
    driver.apply.mockImplementation(async () => { status('idle'); return { status: 'changed', deletedCount: 0, totalCount: 4 }; });
    click(render(), '确认清空共享资产库');
    await vi.waitFor(() => expect(text(render())).toContain('云端内容已变化，未执行删除，请重新预览。'));
    expect(text(render())).not.toContain('云端项目资产已清空');
  });

  it('requests cancellation when the dialog is forcibly unmounted during deletion', async () => {
    render(); status('applying');
    driver.effects.forEach((effect) => effect?.cleanup?.());
    await vi.waitFor(() => expect(driver.cancelPreview).toHaveBeenCalledWith('owner'));
    expect(driver.apply).not.toHaveBeenCalled();
  });

  it('shows how to handle an incompatible shared project', async () => {
    driver.preview.mockRejectedValue(new Error('该共享项目状态不兼容，请选择删除共享项目后重新创建'));
    render(); click(confirmMembers(), '清空共享资产库');
    await vi.waitFor(() => expect(text(render())).toContain('该共享项目状态不兼容，请选择删除共享项目后重新创建'));
    expect(driver.apply).not.toHaveBeenCalled();
  });

  it.each(['en-US', 'ja-JP', 'ko-KR'])('translates cloud object counts in %s', async (locale) => {
    const i18n = await vi.importActual<typeof import('../../src/i18n')>('../../src/i18n');
    const key = '预览时快照：{objects} 个云对象，约 {size}。';
    try {
      i18n.setLocale(locale); const translated = i18n.t(key, { objects: 4, size: '1 KB' });
      expect(translated).not.toBe(key); expect(translated).toContain('4'); expect(translated).toContain('1 KB');
      expect(i18n.t('该共享项目状态不兼容，请选择删除共享项目后重新创建')).not.toContain('该共享项目状态不兼容');
    } finally { i18n.setLocale('zh-CN'); }
  });
});

describe('shared project sync view lifecycle', () => {
  it.each(['paused', 'scanning'] as const)('shows saved progress while %s instead of restarting at zero', async (stage) => {
    const saved = syncStatus(stage);
    saved.completed = 4; saved.total = 5;
    const tree = await renderSyncPanel();
    expect(text(tree)).toContain('已保存进度：已完成 4 / 5 项');
    expect(driver.syncLoad).not.toHaveBeenCalled();
    expect(driver.syncPreview).not.toHaveBeenCalled();
  });

  it.each([
    { phase: 'preparing' as const, label: '本地准备' },
    { phase: 'uploading' as const, label: '实际上传' },
    { phase: 'downloading' as const, label: '实际下载' },
  ])('labels $phase byte progress accurately', async ({ phase, label }) => {
    const running = syncStatus('syncing');
    running.progress!.phase = phase;
    const tree = await renderSyncPanel();
    expect(text(tree)).toContain(`${label}：1.0 / 3.0 MB`);
    if (phase === 'preparing') expect(text(tree)).not.toContain('实际上传：');
  });

  it.each(['scanning', 'syncing', 'preview'] as const)(
    'reconnects to %s on reopen without resetting or restarting the Store task', async (stage) => {
      const existing = syncStatus(stage);
      const first = await renderSyncPanel(true);
      expect(text(first)).toContain('后台素材.png');
      unmountView();
      const reopened = await renderSyncPanel(true);
      expect(driver.syncLoad).not.toHaveBeenCalled();
      expect(driver.syncPreview).not.toHaveBeenCalled();
      expect(driver.syncApply).not.toHaveBeenCalled();
      expect(driver.syncCancel).not.toHaveBeenCalled();
      expect(driver.state.sharedAssetSyncStatus.owner).toBe(existing);
      expect(text(reopened)).toContain('后台素材.png');
      if (stage === 'syncing') {
        expect(text(reopened)).toContain('实际上传：1.0 / 3.0 MB');
        expect(text(reopened)).toContain('已完成 1 / 3 项');
      }
    },
  );

  it.each(['completed', 'paused', 'failed'] as const)(
    'keeps the %s result when the sharing view is reopened normally', async (stage) => {
      const existing = syncStatus(stage);
      await renderSyncPanel();
      unmountView();
      const reopened = await renderSyncPanel();
      expect(driver.syncLoad).not.toHaveBeenCalled();
      expect(driver.syncPreview).not.toHaveBeenCalled();
      expect(driver.syncCancel).not.toHaveBeenCalled();
      expect(driver.state.sharedAssetSyncStatus.owner).toBe(existing);
      expect(text(reopened)).toContain(stage === 'completed' ? '项目资产同步完成' : '待恢复的同步说明');
    },
  );

  it.each(['completed', 'paused', 'failed'] as const)(
    'allows an explicit sync request to preview again after %s', async (stage) => {
      syncStatus(stage);
      await renderSyncPanel(true);
      expect(driver.syncLoad).not.toHaveBeenCalled();
      expect(driver.syncPreview).toHaveBeenCalledExactlyOnceWith('owner');
      expect(driver.syncApply).not.toHaveBeenCalled();
      expect(driver.syncCancel).not.toHaveBeenCalled();
    },
  );

  it.each(['scanning', 'syncing', 'preview'] as const)(
    'does not auto-preview over %s started while saved state is loading', async (stage) => {
      const pending = deferred();
      driver.syncLoad.mockReturnValueOnce(pending.promise);
      await renderSyncPanel(true);
      expect(driver.syncLoad).toHaveBeenCalledExactlyOnceWith('owner');
      const existing = syncStatus(stage);
      pending.resolve();
      await pending.promise;
      await Promise.resolve();
      expect(driver.syncPreview).not.toHaveBeenCalled();
      expect(driver.syncCancel).not.toHaveBeenCalled();
      expect(driver.state.sharedAssetSyncStatus.owner).toBe(existing);
    },
  );

  it('does not start an automatic preview after the view closes during saved-state loading', async () => {
    const pending = deferred();
    driver.syncLoad.mockReturnValueOnce(pending.promise);
    await renderSyncPanel(true);
    expect(driver.syncLoad).toHaveBeenCalledExactlyOnceWith('owner');
    unmountView();
    pending.resolve();
    await pending.promise;
    await Promise.resolve();
    expect(driver.syncPreview).not.toHaveBeenCalled();
    expect(driver.syncApply).not.toHaveBeenCalled();
    expect(driver.syncCancel).not.toHaveBeenCalled();
  });

  it.each([
    { stage: 'syncing' as const, action: '暂停同步' },
    { stage: 'preview' as const, action: '取消预览' },
  ])('keeps explicit $action delegated to the Store', async ({ stage, action }) => {
    syncStatus(stage);
    const tree = await renderSyncPanel();
    click(tree, action);
    expect(driver.syncCancel).toHaveBeenCalledExactlyOnceWith('owner');
    expect(driver.syncLoad).not.toHaveBeenCalled();
    expect(driver.syncPreview).not.toHaveBeenCalled();
    expect(driver.syncApply).not.toHaveBeenCalled();
    unmountView();
    expect(driver.syncCancel).toHaveBeenCalledOnce();
  });
});
