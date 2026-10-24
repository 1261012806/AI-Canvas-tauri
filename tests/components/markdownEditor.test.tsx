import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  states: [] as unknown[], stateIndex: 0,
  refs: [] as Array<{ current: unknown }>, refIndex: 0,
}));
vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (value: T | ((old: T) => T)) => {
      hooks.states[index] = typeof value === 'function' ? (value as (old: T) => T)(hooks.states[index] as T) : value;
    }];
  },
  useRef: <T,>(initial: T) => hooks.refs[hooks.refIndex++] ??= { current: initial },
  useDeferredValue: <T,>(value: T) => value,
  useMemo: <T,>(factory: () => T) => factory(),
}));
import MarkdownEditor from '../../src/components/shared/MarkdownEditor';

interface ElementLike { type: unknown; props: Record<string, unknown> & { children?: unknown; ref?: { current: unknown } } }
function elements(node: unknown): ElementLike[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ElementLike;
  return [element, ...elements(element.props.children)];
}
let tree: ElementLike[];
let frames: FrameRequestCallback[];
const source = { selectionEnd: 0, focus: vi.fn(), setSelectionRange: vi.fn() };
const search = { focus: vi.fn() };
function render() {
  hooks.stateIndex = hooks.refIndex = 0;
  tree = elements(MarkdownEditor({ value: '前文中文后文', onChange: vi.fn(), markdown: false, initialMode: 'source' }));
  tree.forEach((node) => { if (node.props.ref) node.props.ref.current = node.type === 'textarea' ? source : search; });
}
function control(label: string) { return tree.find((node) => node.props['aria-label'] === label)!; }
function invoke(node: ElementLike, handler: string, event?: unknown) { (node.props[handler] as (event?: unknown) => void)(event); }
function flushFrames() { frames.splice(0).forEach((frame) => frame(0)); }
function enter(isComposing = false, keyCode = 13) {
  return { key: 'Enter', nativeEvent: { isComposing, keyCode }, preventDefault: vi.fn() };
}
beforeEach(() => {
  hooks.states = []; hooks.refs = []; frames = [];
  source.focus.mockClear(); source.setSelectionRange.mockClear(); search.focus.mockClear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  render();
  invoke(tree.find((node) => node.type === 'button' && node.props['aria-expanded'] === false)!, 'onClick');
  render(); flushFrames();
  invoke(control('查找内容'), 'onChange', { target: { value: '中文' } }); render();
});
afterEach(() => vi.unstubAllGlobals());

describe('MarkdownEditor 查找输入法边界', () => {
  it.each([[true, 13], [false, 229]])('输入法确认 isComposing=%s / keyCode=%i 不执行查找或抢焦点', (isComposing, keyCode) => {
    const event = enter(isComposing, keyCode);
    invoke(control('查找内容'), 'onKeyDown', event); render(); flushFrames();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(source.focus).not.toHaveBeenCalled(); expect(source.setSelectionRange).not.toHaveBeenCalled();
    expect(tree.some((node) => node.props.children === '已定位匹配内容')).toBe(false);
  });
  it('输入完成后的 Enter 查找并选中真实匹配内容', () => {
    const event = enter();
    invoke(control('查找内容'), 'onKeyDown', event); render(); flushFrames();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(source.focus).toHaveBeenCalledOnce(); expect(source.setSelectionRange).toHaveBeenCalledWith(2, 4);
    expect(tree.some((node) => node.props.children === '已定位匹配内容')).toBe(true);
  });
});
