import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createHash } from 'node:crypto';
import type { AppState } from '../../src/store/useAppStore';


type Element = { props: Record<string, unknown> };
const driver = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, state: () => ({} as AppState),
  patch: (_partial: Partial<AppState>) => {},
  listProjects: vi.fn(), loadProject: vi.fn(), saveProject: vi.fn(),
  saveCurrentProject: vi.fn(), toast: vi.fn(),
  native: false, secrets: new Map<string, string>(), invoke: vi.fn(),
}));
// 执行真实按钮事件和 Store / IndexedDB；不挂载余额查询及其他窗口副作用。
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const index = driver.cursor++;
    if (!(index in driver.slots)) driver.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [driver.slots[index], (next: T | ((old: T) => T)) => {
      driver.slots[index] = typeof next === 'function' ? (next as (old: T) => T)(driver.slots[index] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => {
    const index = driver.cursor++;
    driver.slots[index] ??= { current: initial };
    return driver.slots[index];
  },
  useEffect: () => {}, useMemo: <T,>(fn: () => T) => fn(), useCallback: <T,>(fn: T) => fn,
  useSyncExternalStore: <T,>(_subscribe: unknown, snapshot: () => T) => snapshot(),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
// 本用例按中文原文定位按钮与提示（data-tooltip / aria-label / toast 文案）。
// 直接返回 key，避免运行环境的系统语言不同导致文案被翻译后找不到元素。
vi.mock('../../src/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/i18n')>()),
  useT: () => (text: string, params?: Record<string, string | number>) => Object.entries(params || {})
    .reduce((value, [key, replacement]) => value.replaceAll(`{${key}}`, String(replacement)), text),
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign(<T,>(selector: (state: AppState) => T) => selector(driver.state()), { getState: () => driver.state() }),
}));
vi.mock('@iconify/react', () => ({ Icon: 'icon' }));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...await original<typeof import('@tauri-apps/api/core')>(), invoke: driver.invoke,
}));
vi.mock('../../src/components/shared/AnimatedButton', () => ({ default: 'button' }));
vi.mock('../../src/components/shared/ProviderBadge', () => ({ default: 'badge' }));
vi.mock('../../src/components/settings/ProviderConnectionDialog', () => ({ default: 'dialog' }));
vi.mock('../../src/components/settings/DreaminaLoginModal', () => ({ default: 'dreamina' }));
vi.mock('../../src/components/nodes/shared/defaultModels', () => ({ defaultModelGroups: [] }));
vi.mock('../../src/services/workflowApi/workflowApiConfig', () => ({ saveWorkflowApiDrafts: vi.fn(), saveAutodlWorkflowTemplate: vi.fn() }));
vi.mock('../../src/services/fs/core', () => ({
  isTauriEnv: () => driver.native, getProjectDataDir: async () => null,
  joinPath: (...parts: string[]) => parts.join('/'),
}));
vi.mock('../../src/services/fileService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/storageService')>('../../src/services/storageService'),
  loadProjectsList: driver.listProjects, loadProjectData: driver.loadProject,
  saveProject: driver.saveProject, setBaseDataDir: vi.fn(), syncAuthorizedDirectories: async () => {},
}));

import ApiKeySettings from '../../src/components/settings/ApiKeySettings';
import { createConfigSlice } from '../../src/store/store.config';
import { loadConfigFromDb, saveConfigToDb } from '../../src/services/indexedDbService';

function configStore() {
  return createStore<AppState>()((set, get, api) => ({
    ...createConfigSlice(set, get, api), showToast: driver.toast,
    nodes: [], projects: [], workflows: [], currentProjectId: null,
    pendingApiKeyConnectionId: null, setPendingApiKeyConnectionId: vi.fn(),
    commitToHistory: vi.fn(), saveCurrentProjectSilent: driver.saveCurrentProject,
  } as unknown as AppState));
}

function find(root: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(root)) return root.map((child) => find(child, predicate)).find(Boolean);
  if (!root || typeof root !== 'object' || !('props' in root)) return undefined;
  const element = root as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}

function render() {
  driver.cursor = 0;
  return ApiKeySettings({ onClose: vi.fn() });
}

function findAll(root: unknown, predicate: (element: Element) => boolean): Element[] {
  if (Array.isArray(root)) return root.flatMap((child) => findAll(child, predicate));
  if (!root || typeof root !== 'object' || !('props' in root)) return [];
  const element = root as Element;
  return [...(predicate(element) ? [element] : []), ...findAll(element.props.children, predicate)];
}

function addCccGroups() {
  driver.state().saveProviderConfig('cccapi-free', { name: 'CCC API · CCC生图白嫖', catalogId: 'cccapi', cccGroup: 'CCC生图白嫖', apiKey: '',
    selectedModels: [{ id: 'gpt-image-2', name: 'GPT Image 2', category: 'image', provider: 'cccapi-free' }],
  });
  driver.state().saveProviderConfig('cccapi-pro', { name: 'CCC API · GPT-特价Pro', catalogId: 'cccapi', cccGroup: 'GPT-特价Pro', apiKey: 'pro-fixture',
    selectedModels: [{ id: 'gpt-5.6-sol', name: 'GPT', category: 'text', provider: 'cccapi-pro' }],
  });
}

async function clickDelete() {
  const remove = find(render(), (element) => element.props['data-tooltip'] === '删除连接');
  expect(remove).toBeDefined();
  (remove!.props.onClick as () => void)();
  const confirm = find(render(), (element) => element.props['aria-label'] === '确认删除');
  expect(confirm).toBeDefined();
  (confirm!.props.onClick as () => void)();
  await vi.waitFor(() => expect(driver.toast).toHaveBeenCalled());
}

beforeEach(async () => {
  driver.slots = [];
  driver.native = false; driver.secrets.clear();
  driver.invoke.mockReset().mockImplementation(async (command: string, args: { key: string; value?: string; fingerprintOnly?: boolean; expected?: { fingerprint?: string } }) => {
    if (command === 'secret_store_available') return true;
    const current = driver.secrets.get(args.key) ?? null;
    const fingerprint = current === null ? null : createHash('sha256').update(current).digest('hex');
    if (command === 'secret_get') return args.fingerprintOnly ? fingerprint : current;
    if (command === 'secret_set') { driver.secrets.set(args.key, args.value!); return; }
    if (command === 'secret_delete') {
      if (current !== null && args.expected?.fingerprint && args.expected.fingerprint !== fingerprint) throw { code: 'conflict' };
      driver.secrets.delete(args.key); return;
    }
    throw new Error('测试未声明的原生命令');
  });
  driver.listProjects.mockReset().mockResolvedValue([]);
  driver.loadProject.mockReset().mockResolvedValue(null);
  driver.saveProject.mockReset().mockResolvedValue('project');
  driver.saveCurrentProject.mockReset().mockResolvedValue('current');
  driver.toast.mockReset();
  vi.stubGlobal('window', {});
  await saveConfigToDb({
    providers: {
      'custom-1': { name: '待删除连接', apiKey: '', catalogId: 'custom-openai', baseUrl: 'https://example.test/v1' },
      'custom-2': { name: '保留连接', apiKey: '', catalogId: 'custom-openai', baseUrl: 'https://other.test/v1' },
    },
    generalModels: [
      { id: 'removed-model', name: '待删除模型', modelId: 'model-a', category: 'text', providerConfigId: 'custom-1' },
      { id: 'kept-model', name: '保留模型', modelId: 'model-b', category: 'text', providerConfigId: 'custom-2' },
    ],
  });
  const store = configStore();
  await store.getState().loadConfig();
  driver.state = store.getState;
  driver.patch = store.setState;
  driver.toast.mockClear();
});

describe('API Key 连接删除持久化', () => {
  it.each(['正常清理', '项目列表读取失败', '项目内容读取失败', '当前项目保存失败'])(
    '%s 时删除自定义连接，重新加载不会恢复连接或模型', async (scenario) => {
      if (scenario === '项目列表读取失败') driver.listProjects.mockRejectedValueOnce(new Error('private fixture'));
      if (scenario === '项目内容读取失败') {
        driver.listProjects.mockResolvedValueOnce([{ id: 'other-project' }]);
        driver.loadProject.mockRejectedValueOnce(new Error('private fixture'));
      }
      if (scenario === '当前项目保存失败') {
        driver.patch({ currentProjectId: 'current', nodes: [{ id: 'node', type: 'ai-text', position: { x: 0, y: 0 }, data: {
          type: 'ai-text', label: '模型节点', model: 'general/removed-model', provider: 'general',
        } }] });
        driver.saveCurrentProject.mockRejectedValueOnce(new Error('private fixture'));
      }
      await clickDelete();
      const saved = await loadConfigFromDb();
      expect(saved).not.toHaveProperty('providers.custom-1');
      expect(saved).toHaveProperty('providers.custom-2');
      const fresh = configStore();
      await fresh.getState().loadConfig();
      expect(fresh.getState().config.providers).not.toHaveProperty('custom-1');
      expect(fresh.getState().config.generalModels?.map((model) => model.id)).toEqual(['kept-model']);
      if (scenario !== '正常清理') {
        expect(driver.toast).toHaveBeenCalledWith('连接已删除，但部分项目的模型引用清理失败，请检查相关项目', 'error');
      }
      expect(JSON.stringify(driver.toast.mock.calls)).not.toContain('private fixture');
    },
  );

  it('数据库提交失败时保留待保存删除并报告失败，重试成功后重新加载不会恢复', async () => {
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await clickDelete();
    expect(driver.state()).toMatchObject({ configDirty: true, configSaveStatus: 'error' });
    expect(await loadConfigFromDb()).toHaveProperty('providers.custom-1');
    expect(driver.toast).not.toHaveBeenCalledWith('连接已删除', 'success');
    await driver.state().saveConfig();
    const fresh = configStore();
    await fresh.getState().loadConfig();
    expect(fresh.getState().config.providers).not.toHaveProperty('custom-1');
    expect(fresh.getState().config.generalModels?.map((model) => model.id)).toEqual(['kept-model']);
  });
});

describe('CCC 统一管理入口', () => {
  it('多组仅显示一张 CCC 卡片，汇总配置状态并从统一入口编辑全部分组', () => {
    addCccGroups();
    const cards = findAll(render(), (element) => typeof element.props.className === 'string'
      && element.props.className.split(' ').includes('provider-connection-card'));
    expect(cards).toHaveLength(3); // 两个自定义连接和一个 CCC 入口。
    const ccc = cards.filter((card) => find(card.props.children, (element) => element.props.children === 'CCC API'));
    expect(ccc).toHaveLength(1);
    expect(find(ccc[0], (element) => element.props.children === '1/2 组已配置')).toBeDefined();
    expect(find(ccc[0], (element) => element.props.children === '2 个模型')).toBeDefined();
    expect(find(ccc[0], (element) => element.props.children === '2 个分组')).toBeDefined();
    expect(find(ccc[0], (element) => element.props['aria-label'] === '删除 CCC API 全部分组')).toBeDefined();
    expect(find(ccc[0], (element) => element.props['data-tooltip'] === '复制配置（不含 API Key）')).toBeUndefined();
    (find(ccc[0], (element) => element.props['aria-label'] === '管理 CCC 分组')!.props.onClick as () => void)();
    const dialog = find(render(), (element) => 'onSaveCccGroups' in element.props)!;
    expect(dialog.props.isOpen).toBe(true);
    expect(dialog.props.providerConfigs).toBe(driver.state().config.providers);
    expect(driver.state().config.providers['cccapi-pro'].apiKey).toBe('pro-fixture');
    expect(dialog.props.onCopyCccGroup).toBeTypeOf('function');
    expect(dialog.props.onRemoveCccGroup).toBeTypeOf('function');
  });

  it('外层删除需确认全部分组，取消不修改配置，确认后清理全部 CCC 配置、凭据与模型', async () => {
    addCccGroups();
    driver.native = true;
    await driver.state().saveConfig();
    expect([...driver.secrets.values()]).toContain('pro-fixture');
    const requestRemoval = () => {
      const remove = find(render(), (element) => element.props['aria-label'] === '删除 CCC API 全部分组');
      expect(remove).toBeDefined();
      (remove!.props.onClick as () => void)();
    };
    requestRemoval();
    expect(find(render(), (element) => element.props.children === '移除全部 2 个 CCC 分组及其模型配置？')).toBeDefined();
    expect(driver.state().config.providers).toHaveProperty('cccapi-free');
    expect(driver.state().config.providers).toHaveProperty('cccapi-pro');
    (find(render(), (element) => element.props['aria-label'] === '取消删除')!.props.onClick as () => void)();
    expect(find(render(), (element) => element.props['aria-label'] === '确认删除')).toBeUndefined();
    requestRemoval();
    (find(render(), (element) => element.props['aria-label'] === '确认删除')!.props.onClick as () => void)();
    await vi.waitFor(() => expect(driver.toast).toHaveBeenCalledWith('连接已删除', 'success'));
    const fresh = configStore();
    await fresh.getState().loadConfig();
    expect(Object.keys(fresh.getState().config.providers).sort()).toEqual(['custom-1', 'custom-2']);
    expect(fresh.getState().config.generalModels?.map((model) => model.id)).toEqual(['removed-model', 'kept-model']);
    expect([...driver.secrets.values()]).not.toContain('pro-fixture');
  });

  it('从管理页删除指定组并持久化，其他组的连接、Key 和模型保持独立', async () => {
    addCccGroups();
    driver.native = true;
    const dialog = find(render(), (element) => 'onRemoveCccGroup' in element.props)!;
    const removed = await (dialog.props.onRemoveCccGroup as (id: string) => Promise<boolean>)('cccapi-free');
    expect(removed).toBe(true);
    expect(driver.state().config.providers['cccapi-free']).toBeUndefined();
    expect(driver.state().config.providers['cccapi-pro'].apiKey).toBe('pro-fixture');
    const fresh = configStore();
    await fresh.getState().loadConfig();
    expect(fresh.getState().config.providers).not.toHaveProperty('cccapi-free');
    expect(fresh.getState().config.providers).toHaveProperty('cccapi-pro');
    expect(fresh.getState().config.providers['cccapi-pro'].apiKey).toBe('pro-fixture');
    expect(fresh.getState().config.generalModels?.filter((model) => model.providerConfigId.startsWith('cccapi'))
      .map((model) => model.providerConfigId)).toEqual(['cccapi-pro']);
  });
});
