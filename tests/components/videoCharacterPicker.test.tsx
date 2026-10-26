import type { ComponentProps, EffectCallback, KeyboardEvent, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>, refCursor: 0,
  states: [] as unknown[], stateCursor: 0,
  effects: [] as Array<{
    dependencies?: readonly unknown[];
    pending?: EffectCallback;
    cleanup?: () => void;
  }>, effectCursor: 0,
}));

vi.mock('../../src/i18n', async (original) => ({
  ...await original<typeof import('../../src/i18n')>(),
  useT: () => (key: string) => key,
}));
vi.mock('react', async () => {
  const useEffect = (effect: EffectCallback, dependencies?: readonly unknown[]) => {
    const index = hooks.effectCursor++;
    const previous = hooks.effects[index];
    if (previous && dependencies && previous.dependencies?.length === dependencies.length
      && dependencies.every((value, offset) => Object.is(value, previous.dependencies?.[offset]))) return;
    hooks.effects[index] = { dependencies, pending: effect, cleanup: previous?.cleanup };
  };
  return {
    ...await vi.importActual<typeof import('react')>('react'),
    useId: () => 'video-character-list',
    useRef: <T,>(initial: T) => {
      const index = hooks.refCursor++;
      return (hooks.refs[index] ??= { current: initial }) as { current: T };
    },
    useState: <T,>(initial?: T | (() => T)) => {
      const index = hooks.stateCursor++;
      if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [hooks.states[index] as T, (next: T | ((current: T) => T)) => {
        hooks.states[index] = typeof next === 'function' ? (next as (current: T) => T)(hooks.states[index] as T) : next;
      }] as const;
    },
    useEffect,
    useLayoutEffect: useEffect,
  };
});
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));

import MentionPicker from '../../src/components/shared/MentionPicker';
import VideoCharacterPicker from '../../src/components/nodes/shared/VideoCharacterPicker';

type PickerProps = ComponentProps<typeof VideoCharacterPicker>;
type MentionProps = ComponentProps<typeof MentionPicker>;
type ElementLike = ReactElement<Record<string, unknown>>;

function elements(value: unknown): ElementLike[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as ElementLike;
  return [element, ...elements(element.props.children)];
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor() { FakeResizeObserver.instances.push(this); }
}

let options: PickerProps;
let anchor: { focus: ReturnType<typeof vi.fn>; contains: ReturnType<typeof vi.fn>; getBoundingClientRect: () => object };
let menu: {
  focus: ReturnType<typeof vi.fn>; contains: ReturnType<typeof vi.fn>; querySelectorAll: ReturnType<typeof vi.fn>;
  offsetWidth: number; offsetHeight: number; style: Record<string, string>;
};
let windowEvents: { addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
let documentEvents: { addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

function render() {
  hooks.refCursor = hooks.stateCursor = hooks.effectCursor = 0;
  const tree = VideoCharacterPicker(options);
  const nodes = elements(tree);
  const portal = nodes.find((element) => element.props['data-ui-select-portal'] === '')!;
  (portal.props.ref as { current: unknown }).current = menu;
  for (const effect of hooks.effects) {
    if (!effect.pending) continue;
    effect.cleanup?.();
    const cleanup = effect.pending();
    effect.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    effect.pending = undefined;
  }
  const picker = nodes.find((element) => element.type === MentionPicker) as ReactElement<MentionProps>;
  return { portal, picker: picker.props };
}

function unmount() {
  for (const effect of hooks.effects) effect.cleanup?.();
  hooks.effects = [];
}

function press(portal: ElementLike, key: string, capture = false) {
  const event = {
    key, target: {}, nativeEvent: { isComposing: false, keyCode: 0 },
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
  };
  const handler = portal.props[capture ? 'onKeyDownCapture' : 'onKeyDown'] as (event: KeyboardEvent<HTMLElement>) => void;
  handler(event as unknown as KeyboardEvent<HTMLElement>);
  return event;
}

beforeEach(() => {
  hooks.refs = []; hooks.states = []; hooks.effects = [];
  FakeResizeObserver.instances = [];
  anchor = {
    focus: vi.fn(), contains: vi.fn(() => false),
    getBoundingClientRect: () => ({ left: 120, top: 420, bottom: 452 }),
  };
  menu = {
    focus: vi.fn(), contains: vi.fn(() => false), querySelectorAll: vi.fn(() => []),
    offsetWidth: 336, offsetHeight: 260, style: {},
  };
  windowEvents = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  documentEvents = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', { innerWidth: 1024, innerHeight: 768, ...windowEvents });
  vi.stubGlobal('document', { body: {}, ...documentEvents });
  class FakeNode {}
  vi.stubGlobal('Node', FakeNode);
  vi.stubGlobal('Element', class extends FakeNode {});
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  options = {
    anchorRef: { current: anchor as unknown as HTMLButtonElement },
    projectItems: [{ key: 'shared', label: 'Project Alice', title: 'Project captain', onSelect: vi.fn() }],
    globalItems: [{ key: 'shared', label: 'Global Alice', title: 'Global captain', onSelect: vi.fn() }],
    onReloadGlobal: vi.fn(), onClose: vi.fn(),
  };
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

describe('VideoCharacterPicker 角色范围与交互', () => {
  it('默认只展示项目角色，切换全局后不会混入同 key 的项目角色', () => {
    let { picker } = render();
    expect(picker.activeTab).toBe('project');
    expect(picker.items.map((item) => item.label)).toEqual(['Project Alice']);
    expect(picker.items[0].domId).toContain('-project-');
    picker.onTabChange('global');
    ({ picker } = render());
    expect(picker.activeTab).toBe('global');
    expect(picker.items.map((item) => item.label)).toEqual(['Global Alice']);
    expect(picker.items[0].domId).toContain('-global-');
    picker.items[0].onSelect();
    expect(options.globalItems[0].onSelect).toHaveBeenCalledOnce();
    expect(options.projectItems[0].onSelect).not.toHaveBeenCalled();
    expect(anchor.focus).toHaveBeenCalledWith({ preventScroll: true });
    picker.onTabChange('project');
    options.projectItems = [];
    ({ picker } = render());
    expect(picker.items).toEqual([]);
    expect(picker.footer).toBeUndefined();
  });

  it('搜索只匹配当前范围的名称和说明，不把内部 key 当搜索内容', () => {
    options.projectItems = [
      { key: 'hero', label: 'Alice', title: 'Harbor Captain', onSelect: vi.fn() },
      { key: 'key-only-token', label: 'Detective Lynn', title: 'Investigator', onSelect: vi.fn() },
    ];
    let { picker } = render();
    picker.search!.onExpandedChange(true);
    picker.search!.onChange('  CAPTAIN  ');
    ({ picker } = render());
    expect(picker.search?.expanded).toBe(true);
    expect(picker.items.map((item) => item.label)).toEqual(['Alice']);
    picker.search!.onChange('lynn');
    ({ picker } = render());
    expect(picker.items.map((item) => item.label)).toEqual(['Detective Lynn']);
    picker.search!.onChange('key-only-token');
    ({ picker } = render());
    expect(picker.items).toEqual([]);
    expect(picker.emptyText).toBe('没有匹配的角色');
  });

  it('禁用条目不能直接或通过键盘激活，方向键只经过可用角色', () => {
    const disabled = vi.fn();
    const first = vi.fn();
    const last = vi.fn();
    options.projectItems = [
      { key: 'disabled', label: 'Unavailable', disabled: true, onSelect: disabled },
      { key: 'first', label: 'First', onSelect: first },
      { key: 'last', label: 'Last', onSelect: last },
    ];
    let view = render();
    expect(view.picker.activeKey).toBe('first');
    view.picker.items[0].onSelect();
    expect(disabled).not.toHaveBeenCalled();
    press(view.portal, 'ArrowDown');
    view = render();
    expect(view.picker.activeKey).toBe('last');
    press(view.portal, 'Enter');
    expect(last).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    options.projectItems = [options.projectItems[0]];
    view = render();
    press(view.portal, 'Enter');
    expect(view.picker.activeKey).toBeUndefined();
    expect(disabled).not.toHaveBeenCalled();
  });

  it('全局空库显示加载状态并禁止重试，加载结束后可重新读取', () => {
    options.globalItems = [];
    options.globalLoading = true;
    render().picker.onTabChange('global');
    let { picker } = render();
    expect(picker.items).toEqual([]);
    expect(picker.emptyText).toBe('正在读取全局角色…');
    expect(elements(picker.footer).find((element) => element.type === 'button')?.props.disabled).toBe(true);
    options.globalLoading = false;
    ({ picker } = render());
    expect(picker.emptyText).toBe('当前范围暂无角色，请先在角色库新建');
    const retry = elements(picker.footer).find((element) => element.type === 'button')!;
    expect(retry.props.disabled).toBe(false);
    (retry.props.onClick as () => void)();
    expect(options.onReloadGlobal).toHaveBeenCalledOnce();
  });

  it('搜索中的第一次 Escape 清空并收起，第二次才关闭且还给触发按钮焦点', () => {
    let view = render();
    view.picker.search!.onExpandedChange(true);
    view.picker.search!.onChange('Alice');
    view = render();
    menu.focus.mockClear();
    const escape = press(view.portal, 'Escape', true);
    view = render();
    expect(view.picker.search).toMatchObject({ expanded: false, value: '' });
    expect(options.onClose).not.toHaveBeenCalled();
    expect(menu.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(escape.stopPropagation).toHaveBeenCalledOnce();
    expect(anchor.focus).not.toHaveBeenCalled();
    press(view.portal, 'Escape', true);
    expect(options.onClose).toHaveBeenCalledOnce();
    expect(anchor.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('点外部空白关闭并归还焦点，点击其它控件保留该控件的焦点意图', () => {
    render();
    const outside = documentEvents.addEventListener.mock.calls.find(([name]) => name === 'mousedown')![1] as (event: MouseEvent) => void;
    const blank = new Node();
    menu.contains.mockReturnValueOnce(true);
    outside({ target: blank } as MouseEvent);
    expect(options.onClose).not.toHaveBeenCalled();
    outside({ target: blank } as MouseEvent);
    expect(options.onClose).toHaveBeenCalledOnce();
    expect(anchor.focus).toHaveBeenCalledWith({ preventScroll: true });
    anchor.focus.mockClear();
    const control = new Element();
    Object.assign(control, { closest: vi.fn(() => control) });
    outside({ target: control } as MouseEvent);
    expect(options.onClose).toHaveBeenCalledTimes(2);
    expect(anchor.focus).not.toHaveBeenCalled();
  });

  it('Tab 可正常移交焦点，离开浮层或失去焦点时关闭，内部切焦点不关闭', () => {
    const view = render();
    const blur = view.portal.props.onBlur as (event: { relatedTarget: Node | null; currentTarget: typeof menu }) => void;
    menu.contains.mockReturnValueOnce(true);
    blur({ relatedTarget: new Node(), currentTarget: menu });
    expect(options.onClose).not.toHaveBeenCalled();
    const tab = press(view.portal, 'Tab');
    expect(tab.preventDefault).not.toHaveBeenCalled();
    blur({ relatedTarget: new Node(), currentTarget: menu });
    expect(options.onClose).toHaveBeenCalledOnce();
    blur({ relatedTarget: null, currentTarget: menu });
    expect(options.onClose).toHaveBeenCalledTimes(2);
    expect(anchor.focus).not.toHaveBeenCalled();
  });

  it('纯 click 可切换页签并选择卡片，指针 click 不重复激活且禁用卡片仍不可选', () => {
    const disabled = vi.fn();
    const selected = vi.fn();
    options.globalItems = [
      { key: 'global-disabled', label: 'Disabled', disabled: true, onSelect: disabled },
      { key: 'global-enabled', label: 'Enabled', onSelect: selected },
    ];
    const roleTarget = (role: 'tab' | 'option', id = '', disabled = false) => {
      const target = new Element();
      Object.assign(target, { id, disabled,
        closest: (selector: string) => selector === 'button' || selector === `[role="${role}"]` ? target : null });
      return target;
    };
    const projectTab = roleTarget('tab');
    const globalTab = roleTarget('tab');
    menu.querySelectorAll.mockImplementation((selector: string) => selector === '[role="tab"]' ? [projectTab, globalTab] : []);
    let view = render();
    const click = (target: Element, detail: number) => {
      (view.portal.props.onClick as (event: { target: Element; detail: number; stopPropagation: () => void }) => void)({
        target, detail, stopPropagation: vi.fn(),
      });
    };
    click(globalTab, 1);
    view = render();
    expect(view.picker.activeTab).toBe('project');
    click(globalTab, 0);
    view = render();
    expect(view.picker.activeTab).toBe('global');
    const disabledCard = roleTarget('option', view.picker.items[0].domId, true);
    const enabledCard = roleTarget('option', view.picker.items[1].domId);
    click(disabledCard, 0);
    click(enabledCard, 1);
    expect(disabled).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
    click(enabledCard, 0);
    expect(selected).toHaveBeenCalledOnce();
    expect(anchor.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('卸载时释放尺寸观察器和定位、点外关闭监听', () => {
    render();
    const observer = FakeResizeObserver.instances[0];
    expect(observer.observe.mock.calls).toEqual([[menu], [anchor]]);
    const resize = windowEvents.addEventListener.mock.calls.find(([name]) => name === 'resize')!;
    const scroll = documentEvents.addEventListener.mock.calls.find(([name]) => name === 'scroll')!;
    const outside = documentEvents.addEventListener.mock.calls.find(([name]) => name === 'mousedown')!;
    expect(scroll[2]).toBe(true);
    expect(outside[2]).toBe(true);
    unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(windowEvents.removeEventListener).toHaveBeenCalledWith(...resize);
    expect(documentEvents.removeEventListener).toHaveBeenCalledWith(...scroll);
    expect(documentEvents.removeEventListener).toHaveBeenCalledWith(...outside);
  });
});
