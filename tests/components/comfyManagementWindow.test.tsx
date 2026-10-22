import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComfyManagementSnapshot } from '../../src/types/comfyManagement';

const hooks = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0, refs: [] as Array<{ current: unknown }>, refCursor: 0,
  effects: [] as Array<() => void | (() => void)>,
}));
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), apply: vi.fn(), dependencies: vi.fn(), install: vi.fn(), catalog: vi.fn() }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.states[index], (next: T | ((value: T) => T)) => {
      hooks.states[index] = typeof next === 'function' ? (next as (value: T) => T)(hooks.states[index] as T) : next;
    }];
  },
  useRef: <T,>(initial: T) => hooks.refs[hooks.refCursor++] ??= { current: initial },
  useCallback: <T,>(callback: T) => callback,
  useEffect: (callback: () => void | (() => void)) => { hooks.effects.push(callback); },
}));
vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text, setLocale: vi.fn() }));
vi.mock('../../src/services/appearance/appearanceRuntime', () => ({
  applyAppearanceTheme: vi.fn(), installSystemAppearanceListener: () => () => {},
}));
vi.mock('../../src/services/comfyManagementService', () => ({
  getComfyManagementSnapshot: mocks.snapshot,
  applyComfyRepositoryAction: mocks.apply, installComfyDependencies: mocks.dependencies,
  installComfyExtension: mocks.install, listComfyCatalog: mocks.catalog,
}));
vi.mock('../../src/services/comfyRuntimeService', () => ({ startManagedComfyUI: vi.fn(), stopManagedComfyUI: vi.fn() }));
vi.mock('../../src/hooks/useComfyRuntime', () => ({
  useComfyRuntime: () => ({ runtime: null, error: '', refresh: vi.fn(), clearDisplay: vi.fn() }),
}));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: 'management-modal' }));
vi.mock('../../src/components/shared/Tabs', () => ({ default: 'management-tabs' }));
vi.mock('../../src/components/comfyui/ComfyVersionList', () => ({ default: 'management-versions' }));
vi.mock('../../src/components/comfyui/ComfyLaunchSettings', () => ({ default: 'management-settings' }));
vi.mock('../../src/components/comfyui/ComfyDownloadProgress', () => ({ default: 'management-download' }));
vi.mock('../../src/components/comfyui/ComfyModelDedupe', () => ({ default: 'model-dedupe-probe' }));
vi.mock('../../src/components/comfyui/ComfyRuntimeConsole', () => ({ default: 'management-console' }));

import ComfyManagementWindow from '../../src/components/comfyui/ComfyManagementWindow';

interface ElementLike {
  type: unknown;
  key?: string | null;
  props: Record<string, unknown> & { children?: unknown };
}
function elements(node: unknown): ElementLike[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ElementLike;
  return [element, ...elements(element.props.children)];
}
function renderWindow(): ElementLike[] {
  hooks.cursor = 0; hooks.refCursor = 0;
  return elements(ComfyManagementWindow());
}
function selectTab(tree: ElementLike[], value: string): void {
  const tabs = tree.find((element) => element.type === 'management-tabs');
  (tabs!.props.onChange as (next: string) => void)(value);
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (node && typeof node === 'object' && 'props' in node) return text((node as ElementLike).props.children);
  return '';
}
function clickButton(tree: ElementLike[], name: string): void {
  const button = tree.find((element) => element.type === 'button' && text(element.props.children) === name);
  (button!.props.onClick as () => void)();
}
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}
async function openModelsThen(tab: string): Promise<ElementLike[]> {
  renderWindow(); hooks.effects[0](); await settle();
  let tree = renderWindow();
  selectTab(tree, 'models'); tree = renderWindow();
  selectTab(tree, tab); await settle();
  return renderWindow();
}
function modelKey(tree: ElementLike[]): string | null | undefined {
  return tree.find((element) => element.type === 'model-dedupe-probe')?.key;
}

beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.effects = [];
  vi.clearAllMocks();
  mocks.apply.mockRejectedValue(new Error('模拟管理操作失败'));
  mocks.dependencies.mockRejectedValue(new Error('模拟依赖安装失败'));
  mocks.install.mockRejectedValue(new Error('模拟扩展安装失败'));
  mocks.catalog.mockResolvedValue([]);
  mocks.snapshot.mockResolvedValue({
    installationName: 'ComfyUI', gitAvailable: true,
    core: { id: 'core', name: 'ComfyUI', enabled: true, removed: false, isGit: true,
      remoteUrl: null, branch: 'master', commit: 'abc', commitDate: null, dirty: false },
    extensions: [], warnings: [],
    uiContext: { appearance: null, language: null, nativeCursor: false },
  } satisfies ComfyManagementSnapshot);
  vi.stubGlobal('document', { documentElement: { toggleAttribute: vi.fn() }, title: '' });
});
afterEach(() => vi.unstubAllGlobals());

it('模型去重首次打开才挂载，切控制台后保留同一页面并移出焦点与可访问树', async () => {
  renderWindow();
  const cleanup = hooks.effects[0]();
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  let tree = renderWindow();
  expect(tree.some((element) => element.type === 'model-dedupe-probe')).toBe(false);

  selectTab(tree, 'models');
  tree = renderWindow();
  const model = tree.find((element) => element.type === 'model-dedupe-probe')!;
  expect(model.props.active).toBe(true);

  selectTab(tree, 'console');
  tree = renderWindow();
  const retained = tree.find((element) => element.type === 'model-dedupe-probe')!;
  expect(retained.type).toBe(model.type);
  expect(retained.key).toBe(model.key);
  expect(retained.props.active).toBe(false);
  const container = tree.find((element) => element.props.children === retained)!;
  expect(container.props).toMatchObject({ hidden: true, inert: true, className: 'hidden' });

  selectTab(tree, 'models');
  tree = renderWindow();
  expect(tree.find((element) => element.type === 'model-dedupe-probe')?.props.active).toBe(true);
  expect(mocks.snapshot).toHaveBeenCalledTimes(1);
  if (typeof cleanup === 'function') cleanup();
});

it.each(['更新当前分支', '安装内核依赖', '一键更新'])('%s 开始就使旧扫描失效，原生失败也不恢复旧结果', async (action) => {
  let tree = await openModelsThen('core');
  const previousKey = modelKey(tree);
  clickButton(tree, action);
  if (action === '一键更新') {
    tree = renderWindow(); clickButton(tree, '确认');
  }
  expect(modelKey(renderWindow())).not.toBe(previousKey);
  await settle();
  expect(modelKey(renderWindow())).not.toBe(previousKey);
});

it('安装扩展确认后立即撤销旧扫描，即使下载失败也要求重新扫描', async () => {
  let tree = await openModelsThen('catalog');
  const previousKey = modelKey(tree);
  const input = tree.find((element) => element.props.id === 'comfy-extension-url')!;
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'https://github.com/example/nodes' } });
  tree = renderWindow();
  const form = tree.find((element) => element.type === 'form')!;
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
  tree = renderWindow(); clickButton(tree, '确认');
  expect(modelKey(renderWindow())).not.toBe(previousKey);
  await settle();
  expect(mocks.install).toHaveBeenCalledTimes(1);
  expect(modelKey(renderWindow())).not.toBe(previousKey);
});
