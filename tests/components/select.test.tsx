import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, refs: [] as Array<{ current: unknown }>, refCursor: 0,
  effects: [] as Array<() => void | (() => void)>, layouts: [] as Array<() => void | (() => void)> }));
vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useId: () => 'select-test',
  useRef: <T,>(value: T) => hooks.refs[hooks.refCursor++] ??= { current: value },
  useEffect: (callback: () => void | (() => void)) => hooks.effects.push(callback),
  useLayoutEffect: (callback: () => void | (() => void)) => hooks.layouts.push(callback),
  useState: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: T | ((value: T) => T)) => {
      hooks.states[index] = typeof next === 'function' ? (next as (value: T) => T)(hooks.states[index] as T) : next;
    }];
  },
}));
vi.mock('react-dom', () => ({ createPortal: (element: unknown) => element }));

import Select from '../../src/components/shared/Select';

interface ElementLike {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown; ref?: { current: unknown } };
}
function elements(node: unknown): ElementLike[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ElementLike;
  return [element, ...elements(element.props.children)];
}
function invoke(element: ElementLike, handler: string, event: unknown) {
  (element.props[handler] as (event: unknown) => void)(event);
}
function event(key?: string, target?: unknown) {
  return { key, target, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() };
}

beforeEach(() => {
  hooks.states = [];
  hooks.cursor = 0;
  hooks.refs = [];
  hooks.refCursor = 0;
  hooks.effects = [];
  hooks.layouts = [];
  vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn(), activeElement: null });
  vi.stubGlobal('window', {
    innerWidth: 640, innerHeight: 720,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    getComputedStyle: (element: { zIndex?: string }) => ({ zIndex: element.zIndex ?? 'auto' }),
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

describe('共享 Select 迁移语义', () => {
  it('保留片段、空值、数值、默认文字及分组禁用', () => {
    const markup = renderToStaticMarkup(<Select value={0} onChange={vi.fn()} required autoFocus aria-describedby="hint" name="fps">
      <option value="">模型默认</option>
      <><option value={0}>{0} FPS</option><option>Auto</option></>
      <optgroup label="禁用分组" disabled><option value="blocked">不可用</option></optgroup>
    </Select>);
    expect(markup).toContain('value="0" selected="">0 FPS');
    expect(markup).toContain('value="Auto">Auto');
    expect(markup).toContain('value="blocked" disabled=""');
    expect(markup).toContain('aria-describedby="hint"');
    expect(markup).toContain('required=""');
    expect(markup).toContain('autofocus=""');
    expect(markup).toContain('name="fps"');
    expect(markup).toContain('ui-select__trigger');
  });

  it('展开菜单默认启用 Portal，无需业务组件重复传参', () => {
    hooks.states = [true, false];
    const nodes = elements(Select({ value: '1', onChange: vi.fn(), options: [{ value: '1', label: '一' }] }));
    expect(nodes.find((node) => node.props.role === 'listbox')?.props['data-ui-select-portal']).toBe('');
  });

  it('点击选项传递原字符串并收起菜单，恢复触发器焦点', () => {
    hooks.states = [true, false];
    const change = vi.fn();
    const tree = Select({ value: '1', onChange: change, fixedMenu: true, children: <><option value="">默认</option><option value={0}>零</option></> });
    const nodes = elements(tree);
    const trigger = nodes.find((node) => node.props['aria-haspopup'] === 'listbox')!;
    const focus = vi.fn();
    trigger.props.ref!.current = { focus };
    const option = nodes.filter((node) => node.props.role === 'option')[1];
    const click = event();
    invoke(option, 'onClick', click);
    expect(change).toHaveBeenCalledExactlyOnceWith('0');
    expect(hooks.states[0]).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
    expect(click.stopPropagation).toHaveBeenCalledOnce();
  });

  it('必填校验失败时聚焦可见按钮，禁用时不显示菜单', () => {
    hooks.states = [true, false];
    const nodes = elements(Select({ value: '', required: true, disabled: true, onChange: vi.fn(), options: [{ value: '', label: '请选择' }] }));
    expect(nodes.some((node) => node.props.role === 'listbox')).toBe(false);
    const trigger = nodes.find((node) => node.props['aria-haspopup'] === 'listbox')!;
    const focus = vi.fn();
    trigger.props.ref!.current = { focus };
    const native = nodes.find((node) => node.type === 'select')!;
    expect(native.props.required).toBe(true);
    expect(native.props.disabled).toBe(true);
    const invalid = event();
    invoke(native, 'onInvalid', invalid);
    expect(invalid.preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(hooks.states[1]).toBe(true);
  });

  it.each([
    { left: 40, top: 640, bottom: 672, width: 60, contentWidth: 180 },
    { left: 40, top: 8, bottom: 40, width: 500, contentWidth: 120 },
    { left: 550, top: 300, bottom: 332, width: 80, contentWidth: 900 },
  ])('默认菜单越过父容器并高于层级 10000，位置适配视口 $top', (rect) => {
    hooks.states = [true, false];
    const tree = Select({ value: 'chosen', onChange: vi.fn(), options: [{ value: 'chosen', label: '选中' }] });
    const nodes = elements(tree);
    const menuNode = nodes.find((node) => node.props.role === 'listbox')!;
    expect(menuNode.props['data-ui-select-portal']).toBe('');
    const menu = {
      style: {} as Record<string, string>, scrollTop: 0,
      get offsetWidth() {
        const naturalWidth = this.style.width === 'max-content' ? rect.contentWidth : Number.parseFloat(this.style.width);
        return Math.min(naturalWidth, Number.parseFloat(this.style.maxWidth) || Infinity);
      },
      get offsetHeight() { return Math.min(320, Number.parseFloat(this.style.maxHeight) || 320); },
      get clientHeight() { return this.offsetHeight; },
      querySelector: () => ({ offsetTop: 900, offsetHeight: 28, focus: vi.fn() }),
      removeAttribute: vi.fn(),
    };
    tree.props.ref.current = { getBoundingClientRect: () => rect, zIndex: 'auto', parentElement: { zIndex: '10000', parentElement: null } };
    menuNode.props.ref!.current = menu;
    const cleanups = hooks.layouts.map((layout) => layout());
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.zIndex).toBe('10001');
    expect(menu.offsetWidth).toBe(Math.min(rect.contentWidth, 624));
    expect(menu.style.minWidth).toBe('0');
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(menu.style.left) + menu.offsetWidth).toBeLessThanOrEqual(632);
    expect(Number.parseFloat(menu.style.top) + menu.offsetHeight).toBeLessThanOrEqual(712);
    expect(menu.scrollTop).toBeGreaterThan(0);
    if (rect.top > 600) expect(Number.parseFloat(menu.style.top) + menu.offsetHeight).toBeLessThan(rect.top);
    cleanups.forEach((cleanup) => cleanup?.());
  });

  it.each([
    { description: '当前选中项可用', selectedEnabled: true, hasEnabled: true },
    { description: '选中项禁用或不存在', selectedEnabled: false, hasEnabled: true },
    { description: '没有可用选项', selectedEnabled: false, hasEnabled: false },
  ])('容器内菜单打开后聚焦可用选项，$description', ({ selectedEnabled, hasEnabled }) => {
    hooks.states = [true, false];
    const tree = Select({ value: 'chosen', fixedMenu: false, onChange: vi.fn(), options: [
      { value: 'first', label: '第一项', disabled: !hasEnabled },
      { value: 'chosen', label: '当前项', disabled: !selectedEnabled },
    ] });
    const menuNode = elements(tree).find((node) => node.props.role === 'listbox')!;
    const chosen = { offsetTop: 240, offsetHeight: 28, focus: vi.fn() };
    const first = { offsetTop: 0, offsetHeight: 28, focus: vi.fn() };
    const menu = {
      clientHeight: 100, scrollTop: 0, focus: vi.fn(), removeAttribute: vi.fn(),
      querySelector: (selector: string) => selector.includes('aria-selected')
        ? (selectedEnabled ? chosen : null) : (hasEnabled ? first : null),
    };
    menuNode.props.ref!.current = menu;
    hooks.layouts.forEach((layout) => layout());
    expect((selectedEnabled ? chosen : hasEnabled ? first : menu).focus)
      .toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(menu.scrollTop).toBe(selectedEnabled ? 204 : 0);
  });

  it('打开时从当前选中项继续方向键导航，Enter 提交相邻项', () => {
    hooks.states = [true, false];
    const change = vi.fn();
    const tree = Select({ value: 'b', fixedMenu: false, onChange: change, options: [
      { value: 'a', label: '一' }, { value: 'b', label: '二' }, { value: 'c', label: '三' },
    ] });
    const nodes = elements(tree);
    const trigger = { focus: vi.fn() };
    nodes.find((node) => node.props['aria-haspopup'] === 'listbox')!.props.ref!.current = trigger;
    tree.props.ref.current = { contains: (target: unknown) => target === trigger };
    const controls = nodes.filter((node) => node.props.role === 'option').map((node, index) => {
      const control = {
        offsetTop: index * 28, offsetHeight: 28,
        focus: vi.fn(() => { Object.assign(document, { activeElement: control }); }),
        click: vi.fn(() => invoke(node, 'onClick', event())),
        scrollIntoView: vi.fn(),
      };
      return control;
    });
    nodes.find((node) => node.props.role === 'listbox')!.props.ref!.current = {
      clientHeight: 100, scrollTop: 0, removeAttribute: vi.fn(),
      querySelector: (selector: string) => selector.includes('aria-selected') ? controls[1] : controls[0],
      querySelectorAll: () => controls,
      contains: (target: unknown) => controls.includes(target as typeof controls[number]),
    };
    hooks.layouts.forEach((layout) => layout());
    expect(document.activeElement).toBe(controls[1]);
    const cleanup = hooks.effects[0]();
    const registration = vi.mocked(window.addEventListener).mock.calls.find(([name]) => name === 'keydown')!;
    const dispatch = registration[1] as (event: unknown) => void;
    dispatch(event('ArrowDown', controls[1]));
    expect(document.activeElement).toBe(controls[2]);
    dispatch(event('Enter', controls[2]));
    expect(change).toHaveBeenCalledExactlyOnceWith('c');
    expect(hooks.states[0]).toBe(false);
    expect(trigger.focus).toHaveBeenCalled();
    cleanup?.();
  });

  it('Escape 在父弹窗捕获监听前收起菜单', () => {
    hooks.states = [true, false];
    const tree = Select({ value: 'x', onChange: vi.fn(), options: [{ value: 'x', label: 'X' }] });
    const trigger = elements(tree).find((node) => node.props['aria-haspopup'] === 'listbox')!;
    const target = { focus: vi.fn() };
    trigger.props.ref!.current = target;
    tree.props.ref.current = { contains: (node: unknown) => node === target };
    const cleanup = hooks.effects[0]();
    const registration = vi.mocked(window.addEventListener).mock.calls.find(([name]) => name === 'keydown')!;
    expect(registration[2]).toBe(true);
    const escape = event('Escape', target);
    (registration[1] as (event: unknown) => void)(escape);
    expect(hooks.states[0]).toBe(false);
    expect(escape.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(target.focus).toHaveBeenCalledOnce();
    cleanup?.();
  });

  it('Escape 收起重渲染后仍消费连按和配对释放，下次独立 Escape 可交给父层', () => {
    const props = { value: 'x', onChange: vi.fn(), options: [{ value: 'x', label: 'X' }] };
    hooks.states = [true, false];
    const tree = Select(props);
    const target = { focus: vi.fn() };
    const nodes = elements(tree);
    nodes.find((node) => node.props['aria-haspopup'] === 'listbox')!.props.ref!.current = target;
    const menuRef = nodes.find((node) => node.props.role === 'listbox')!.props.ref!;
    tree.props.ref.current = { contains: (node: unknown) => node === target };
    const cleanup = hooks.effects[0]();
    const listener = (type: string) => vi.mocked(window.addEventListener).mock.calls
      .filter(([name]) => name === type).at(-1)![1] as (event: unknown) => void;
    listener('keydown')(event('Escape', target));
    expect(hooks.states[0]).toBe(false);
    cleanup?.(); menuRef.current = null;
    hooks.cursor = hooks.refCursor = 0; hooks.effects = []; hooks.layouts = [];
    Select(props);
    const nextCleanup = hooks.effects[0]();
    const repeated = { ...event('Escape', target), repeat: true };
    listener('keydown')(repeated);
    expect(repeated.stopImmediatePropagation).toHaveBeenCalledOnce();
    const release = event('Escape', target);
    listener('keyup')(release);
    expect(release.preventDefault).toHaveBeenCalledOnce();
    expect(release.stopImmediatePropagation).toHaveBeenCalledOnce();
    const nextEscape = event('Escape', target);
    listener('keydown')(nextEscape);
    expect(nextEscape.stopImmediatePropagation).not.toHaveBeenCalled();
    const nextRelease = event('Escape', target);
    listener('keyup')(nextRelease);
    expect(nextRelease.stopImmediatePropagation).not.toHaveBeenCalled();
    nextCleanup?.();
  });

  it('自定义输入 Escape 失焦后消费释放，窗口失焦清除未释放状态', () => {
    const onBlur = vi.fn();
    const tree = Select({ value: 'custom', onChange: vi.fn(), options: [{ value: 'custom', label: '自定义' }],
      customInput: { value: '自定义值', onChange: vi.fn(), onBlur } });
    const input = elements(tree).find((node) => node.type === 'input')!;
    const target = { blur: vi.fn(() => invoke(input, 'onBlur', {})) };
    input.props.ref!.current = target;
    tree.props.ref.current = { contains: (node: unknown) => node === target };
    const cleanup = hooks.effects[0]();
    const listener = (type: string) => vi.mocked(window.addEventListener).mock.calls
      .find(([name]) => name === type)![1] as (event: unknown) => void;
    const escape = event('Escape', target);
    listener('keydown')(escape);
    expect(target.blur).toHaveBeenCalledOnce(); expect(onBlur).toHaveBeenCalledOnce();
    expect(escape.stopImmediatePropagation).toHaveBeenCalledOnce();
    const release = event('Escape', {});
    listener('keyup')(release);
    expect(release.stopImmediatePropagation).toHaveBeenCalledOnce();
    listener('keydown')(event('Escape', target));
    listener('blur')({});
    const afterBlur = event('Escape', {});
    listener('keyup')(afterBlur);
    expect(afterBlur.stopImmediatePropagation).not.toHaveBeenCalled();
    const unrelated = event('Escape', {});
    listener('keydown')(unrelated);
    expect(unrelated.stopImmediatePropagation).not.toHaveBeenCalled();
    cleanup?.();
  });

  it('收起时空格打开菜单，Delete 不触发画布快捷键', () => {
    const tree = Select({ value: 'x', onChange: vi.fn(), options: [{ value: 'x', label: 'X' }] });
    const target = {};
    tree.props.ref.current = { contains: (node: unknown) => node === target };
    const cleanup = hooks.effects[0]();
    const registration = vi.mocked(window.addEventListener).mock.calls.find(([name]) => name === 'keydown')!;
    const dispatch = registration[1] as (event: unknown) => void;
    const deletion = event('Delete', target);
    dispatch(deletion);
    expect(deletion.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(hooks.states[0]).toBe(false);
    const space = event(' ', target);
    dispatch(space);
    expect(space.preventDefault).toHaveBeenCalledOnce();
    expect(space.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(hooks.states[0]).toBe(true);
    cleanup?.();
  });

  it('源码仅保留 UI Kit 内部原生控件，业务控件沿用默认 Portal', () => {
    const natives: string[] = [];
    function scan(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = `${directory}/${entry.name}`;
        if (entry.isDirectory()) { scan(file); continue; }
        if (!file.endsWith('.tsx')) continue;
        const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        function visit(node: ts.Node) {
          if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            if (node.tagName.getText(source) === 'select') natives.push(file);
            if (node.tagName.getText(source) === 'Select') {
              const portal = node.attributes.properties.find((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === 'fixedMenu');
              if (portal && ts.isJsxAttribute(portal) && portal.initializer) {
                expect(ts.isJsxExpression(portal.initializer) && portal.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword, file).toBe(true);
              }
            }
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
    scan('src');
    expect(natives).toEqual(['src/components/shared/Select.tsx']);
  });
});
