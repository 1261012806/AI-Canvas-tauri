import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReferencePreviewContent, ReferencePreviewSource } from '../../src/types/referencePreview';

interface Harness {
  states: unknown[];
  refs: Array<{ current: unknown }>;
  memos: Array<{ value: unknown; deps: readonly unknown[] }>;
  effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }>;
  pending: Array<() => void>;
  stateIndex: number; refIndex: number; memoIndex: number; effectIndex: number;
}
const driver = vi.hoisted(() => ({
  scope: null as Harness | null,
  store: { currentProjectId: 'project-a' as string | null },
  subscribers: new Set<(state: { currentProjectId: string | null }) => void>(),
  resolve: vi.fn<(source: ReferencePreviewSource, options?: { signal?: AbortSignal }) => Promise<ReferencePreviewContent>>(),
  detached: vi.fn<(source: ReferencePreviewSource, projectId: string | null, signal?: AbortSignal) => Promise<ReferencePreviewContent>>(),
  now: 1000,
  stateWrites: 0,
}));
vi.mock('react', async () => {
  const memo = <T,>(factory: () => T, deps: readonly unknown[]) => {
    const scope = driver.scope!; const index = scope.memoIndex++; const previous = scope.memos[index];
    if (!previous || deps.length !== previous.deps.length || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      scope.memos[index] = { value: factory(), deps };
    }
    return scope.memos[index].value as T;
  };
  return { ...await vi.importActual<typeof import('react')>('react'),
    useCallback: <T,>(callback: T, deps: readonly unknown[]) => memo(() => callback, deps),
    useState: <T,>(initial: T | (() => T)) => {
      const scope = driver.scope!; const index = scope.stateIndex++;
      if (!(index in scope.states)) scope.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [scope.states[index], (value: T | ((previous: T) => T)) => {
        driver.stateWrites++;
        scope.states[index] = typeof value === 'function' ? (value as (previous: T) => T)(scope.states[index] as T) : value;
      }];
    },
    useRef: <T,>(initial: T) => {
      const scope = driver.scope!; const index = scope.refIndex++;
      return (scope.refs[index] ??= { current: initial });
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const scope = driver.scope!; const index = scope.effectIndex++; const previous = scope.effects[index];
      if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
      scope.pending.push(() => { previous?.cleanup?.(); scope.effects[index] = { deps, cleanup: effect() ?? undefined }; });
    },
  };
});
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: {
  getState: () => driver.store,
  subscribe: (listener: (state: typeof driver.store) => void) => {
    driver.subscribers.add(listener);
    return () => { driver.subscribers.delete(listener); };
  },
} }));
vi.mock('../../src/services/referencePreviewService', () => ({ resolveReferencePreview: driver.resolve }));
vi.mock('../../src/services/chat/chatReferencePreviewService', () => ({ requestDetachedReferencePreview: driver.detached }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: 'preview-modal' }));

import ReferencePreviewHost from '../../src/components/shared/ReferencePreviewHost';
import { requestReferencePreview } from '../../src/utils/referencePreviewEvents';

type TestElement = ReactElement<Record<string, unknown> & { children?: unknown }>;
interface PreviewProps {
  source: ReferencePreviewSource;
  content: ReferencePreviewContent;
  loading: boolean;
  onBack?: () => void;
  onClose: () => void;
}

/** 只模拟宿主使用的捕获监听与事件原始 target；不模拟播放器或 Markdown 渲染。 */
class EventSurface extends EventTarget {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  override addEventListener(name: string, callback: EventListenerOrEventListenerObject | null) {
    if (!callback) return;
    const handlers = this.listeners.get(name) ?? new Set(); handlers.add(callback); this.listeners.set(name, handlers);
  }
  override removeEventListener(name: string, callback: EventListenerOrEventListenerObject | null) {
    if (callback) this.listeners.get(name)?.delete(callback);
  }
  from(target: EventTarget, event: Event): boolean {
    Object.defineProperty(event, 'target', { value: target, configurable: true });
    for (const handler of [...this.listeners.get(event.type) ?? []]) {
      if (typeof handler === 'function') handler(event); else handler.handleEvent(event);
    }
    return !event.defaultPrevented;
  }
  override dispatchEvent(event: Event) { return this.from(this, event); }
}
class PreviewElement extends EventTarget {
  readonly nodeType = 1;
  isContentEditable = false;
  parentElement: PreviewElement | null = null;
  constructor(readonly attrs: Record<string, string> = {}, readonly tagName = 'SPAN') { super(); }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  hasAttribute(name: string) { return name in this.attrs; }
  contains(child: PreviewElement): boolean { return child === this || !!child.parentElement && this.contains(child.parentElement); }
  matches(selector: string): boolean {
    return selector.split(',').some((rule) => {
      const tag = rule.trim().match(/^[a-z]+/i)?.[0];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      const className = rule.match(/\.([\w-]+)/)?.[1];
      if (className && !(this.attrs.class || '').split(' ').includes(className)) return false;
      return [...rule.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)]
        .every((match) => match[2] === undefined ? match[1] in this.attrs : this.attrs[match[1]] === match[2]);
    });
  }
  closest(selector: string): PreviewElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelector() { return null; }
  override dispatchEvent(event: Event): boolean { return event.bubbles ? doc.from(this, event) : super.dispatchEvent(event); }
}
class PreviewDocument extends EventSurface {
  fullscreenElement = null;
  querySelector() { return null; }
}

let scope: Harness;
let doc: PreviewDocument;
let win: EventSurface;
let detached = false;
let tree: unknown;
const source = (id: string): ReferencePreviewSource => ({ kind: 'node', id, label: id });
const content = (id: string): ReferencePreviewContent => ({ kind: 'text', title: id, text: `正文 ${id}` });
function elements(value: unknown): TestElement[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as TestElement;
  return [element, ...elements(element.props.children)];
}
function render() {
  driver.scope = scope; scope.stateIndex = scope.refIndex = scope.memoIndex = scope.effectIndex = 0;
  tree = ReferencePreviewHost({ detached }); scope.pending.splice(0).forEach((effect) => effect()); return tree;
}
function current(): PreviewProps {
  const element = elements(render()).find((item) => 'source' in item.props && 'content' in item.props);
  if (!element) throw new Error('没有活动预览');
  return element.props as unknown as PreviewProps;
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function chip(id: string, nested = true) {
  const element = new PreviewElement({ 'data-ref-id': id, 'data-ref-label': id, role: 'button' });
  if (nested) element.parentElement = new PreviewElement({ class: 'reference-content-preview' });
  return element;
}
function open(id: string, nested = false) {
  driver.now += 300;
  requestReferencePreview(source(id), (nested ? chip(id) : doc) as unknown as Document);
  render();
}
function key(name: string, target: EventTarget = win, repeat = false, type = 'keydown') {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { key: name, repeat, isComposing: false });
  vi.spyOn(event, 'stopImmediatePropagation');
  win.from(target, event); render(); return event;
}
function doubleClick(element: PreviewElement) {
  driver.now += 300;
  const event = new Event('dblclick', { cancelable: true });
  Object.assign(event, { button: 0 }); doc.from(element, event); render(); return event;
}
function changeProject(id: string) {
  driver.store = { currentProjectId: id };
  for (const listener of [...driver.subscribers]) listener(driver.store);
  render();
}

beforeEach(() => {
  scope = { states: [], refs: [], memos: [], effects: [], pending: [], stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0 };
  doc = new PreviewDocument(); win = new EventSurface(); detached = false;
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
  vi.stubGlobal('Element', PreviewElement); vi.stubGlobal('HTMLElement', PreviewElement);
  vi.stubGlobal('Node', { ELEMENT_NODE: 1, TEXT_NODE: 3 });
  vi.spyOn(Date, 'now').mockImplementation(() => driver.now);
  driver.now = 1000; driver.stateWrites = 0; driver.store = { currentProjectId: 'project-a' }; driver.subscribers.clear();
  driver.resolve.mockReset().mockImplementation(async (reference) => content(reference.id));
  driver.detached.mockReset().mockImplementation(async (reference) => content(reference.id));
  render();
});
afterEach(() => { scope.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe('引用预览宿主导航', () => {
  it('内部双击和 Enter 打开真实引用，逐层返回重新读取之前的 source，每层使用新 key', async () => {
    open('a'); await settle();
    const rootKey = elements(tree).find((item) => 'source' in item.props)?.key;
    expect(doubleClick(chip('b')).defaultPrevented).toBe(true); await settle();
    expect(current().source.id).toBe('b');
    driver.now += 300;
    expect(key('Enter', chip('c')).defaultPrevented).toBe(true); await settle();
    expect(current().source.id).toBe('c');
    current().onBack?.(); await settle(); expect(current().source.id).toBe('b');
    current().onBack?.(); await settle(); expect(current().source.id).toBe('a');
    expect(driver.resolve.mock.calls.map(([reference]) => reference.id)).toEqual(['a', 'b', 'c', 'b', 'a']);
    expect(elements(tree).find((item) => 'source' in item.props)?.key).not.toBe(rootKey);
    expect(current().onBack).toBeUndefined();
    current().onClose(); expect(render()).toBeNull(); expect(driver.subscribers.size).toBe(0);
  });

  it('Escape 每次按下只返回一层，长按与重复 keydown 不连退，根层关闭并吞掉释放键', async () => {
    open('a'); await settle(); open('b', true); await settle(); open('c', true); await settle();
    expect(key('Escape').defaultPrevented).toBe(true); await settle();
    expect(current().source.id).toBe('b');
    key('Escape', win, true); key('Escape'); await settle();
    expect(current().source.id).toBe('b'); expect(driver.resolve).toHaveBeenCalledTimes(4);
    expect(key('Escape', win, false, 'keyup').defaultPrevented).toBe(true);
    key('Escape'); await settle(); expect(current().source.id).toBe('a');
    key('Escape', win, false, 'keyup'); key('Escape'); expect(render()).toBeNull();
    expect(key('Escape', win, false, 'keyup').defaultPrevented).toBe(true);
  });

  it('忽略迟到内容；项目切换和卸载取消读取并清空返回历史', async () => {
    let finishA!: (value: ReferencePreviewContent) => void;
    driver.resolve.mockImplementationOnce(() => new Promise<ReferencePreviewContent>((resolve) => { finishA = resolve; }));
    open('a'); await settle(); open('b', true); await settle();
    expect(driver.resolve.mock.calls[0][1]?.signal?.aborted).toBe(true);
    finishA(content('迟到的 a')); await settle(); expect(current().content.title).toBe('b');
    let finishC!: (value: ReferencePreviewContent) => void;
    driver.resolve.mockImplementationOnce(() => new Promise<ReferencePreviewContent>((resolve) => { finishC = resolve; }));
    open('c', true); await settle(); changeProject('project-b');
    expect(render()).toBeNull(); expect(driver.resolve.mock.calls[2][1]?.signal?.aborted).toBe(true);
    const writesAfterClose = driver.stateWrites;
    finishC(content('旧项目 c')); await settle(); expect(render()).toBeNull();
    expect(driver.stateWrites).toBe(writesAfterClose);
    open('d'); await settle(); expect(current().onBack).toBeUndefined();
    expect(driver.subscribers.size).toBe(1);
    scope.effects.forEach((effect) => effect.cleanup?.()); scope.effects = [];
    expect(driver.subscribers.size).toBe(0); expect(driver.resolve.mock.calls[3][1]?.signal?.aborted).toBe(true);
  });

  it('同 source 内部打开不入栈；外部 root 替换已有历史，关闭后可立即重开同一引用', async () => {
    open('a'); await settle(); open('b', true); await settle(); open('b', true); await settle();
    expect(driver.resolve).toHaveBeenCalledTimes(2);
    current().onBack?.(); await settle(); expect(current().source.id).toBe('a'); expect(current().onBack).toBeUndefined();
    open('b', true); await settle(); open('external'); await settle();
    expect(current().source.id).toBe('external'); expect(current().onBack).toBeUndefined();
    current().onClose(); expect(render()).toBeNull();
    // 不推进时间，验证关闭会重置同一手势去重记录。
    requestReferencePreview(source('external'), doc as unknown as Document); await settle();
    expect(current().source.id).toBe('external'); expect(current().onBack).toBeUndefined();
  });

  it('独立窗口每层只调用按需桥接，返回时仍绑定当前项目和新的取消信号', async () => {
    detached = true; render(); open('a'); await settle();
    open('b', true); await settle(); current().onBack?.(); await settle();
    expect(driver.resolve).not.toHaveBeenCalled();
    expect(driver.detached.mock.calls.map(([reference, projectId]) => [reference.id, projectId]))
      .toEqual([['a', 'project-a'], ['b', 'project-a'], ['a', 'project-a']]);
    expect(driver.detached.mock.calls[1][2]?.aborted).toBe(true);
    expect(driver.detached.mock.calls[2][2]?.aborted).toBe(false);
    changeProject('project-b'); expect(render()).toBeNull(); expect(driver.detached.mock.calls[2][2]?.aborted).toBe(true);
  });
});
