import type { ImgHTMLAttributes, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  stateCursor: 0,
  refCursor: 0,
  effectCursor: 0,
  effects: [] as Array<{
    dependencies?: readonly unknown[];
    pending?: () => void | (() => void);
    cleanup?: () => void;
  }>,
}));
const acquire = vi.hoisted(() => vi.fn());

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const index = hooks.stateCursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.values[index] as T, (next: T | ((value: T) => T)) => {
      hooks.values[index] = typeof next === 'function' ? (next as (value: T) => T)(hooks.values[index] as T) : next;
    }] as const;
  },
  useRef: <T,>(initial: T) => {
    const index = hooks.refCursor++;
    hooks.refs[index] ??= { current: initial };
    return hooks.refs[index] as { current: T };
  },
  useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
    const index = hooks.effectCursor++;
    const previous = hooks.effects[index];
    if (previous && dependencies && previous.dependencies?.length === dependencies.length
      && dependencies.every((value, at) => Object.is(value, previous.dependencies?.[at]))) return;
    hooks.effects[index] = { dependencies, pending: effect, cleanup: previous?.cleanup };
  },
}));
vi.mock('../../src/components/nodes/shared/image/canvasImagePreviewCache', () => ({ acquireCanvasImagePreview: acquire }));

import { useViewportMediaSource, type ViewportMediaSourceOptions } from '../../src/hooks/useViewportMediaSource';
import { syncPerformanceModeRuntime } from '../../src/services/performanceModeRuntime';
import ViewportImage from '../../src/components/shared/ViewportImage';

class FakeObserver {
  static instances: FakeObserver[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  private readonly callback: IntersectionObserverCallback;
  readonly options?: IntersectionObserverInit;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    FakeObserver.instances.push(this);
  }
  emit(element: Element, visible: boolean) {
    this.callback([{ target: element, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

let element: Element;
let reference: { current: Element | null };
function beginRender() { hooks.stateCursor = hooks.refCursor = hooks.effectCursor = 0; }
function commitEffects() {
  for (const slot of hooks.effects) {
    if (!slot.pending) continue;
    slot.cleanup?.();
    const cleanup = slot.pending();
    slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    slot.pending = undefined;
  }
}
function ViewportMediaHarness(source = 'asset://image.png', options?: ViewportMediaSourceOptions) {
  beginRender();
  const result = useViewportMediaSource(source, reference, options);
  commitEffects();
  return result;
}
function renderImage(source = 'asset://image.png', edge?: number, projectId = 'owner', loading?: ImgHTMLAttributes<HTMLImageElement>['loading']) {
  beginRender();
  const image = ViewportImage({ src: source, alt: 'Preview', previewMaxEdge: edge, projectId, loading }) as ReactElement<ImgHTMLAttributes<HTMLImageElement>>;
  hooks.refs[0].current = element;
  commitEffects();
  return image;
}
function latestObserver() { return FakeObserver.instances[FakeObserver.instances.length - 1]; }

beforeEach(() => {
  syncPerformanceModeRuntime(false);
  vi.useFakeTimers();
  hooks.values = []; hooks.refs = []; hooks.effects = [];
  FakeObserver.instances = [];
  element = { dispatchEvent: vi.fn() } as unknown as Element;
  reference = { current: element };
  acquire.mockReset();
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});
afterEach(() => {
  for (const slot of hooks.effects) slot.cleanup?.();
  hooks.effects = [];
  syncPerformanceModeRuntime(false);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('performance viewport media lifecycle', () => {
  it('preloads against the nearest scroll container even before it overflows', () => {
    const outer = { parentElement: null } as unknown as Element;
    const scroller = { parentElement: outer } as unknown as Element;
    const wrapper = { parentElement: scroller } as unknown as Element;
    Object.assign(element, { parentElement: wrapper });
    const computedStyle = vi.fn((target: Element) => target === scroller
      ? { overflowX: 'hidden', overflowY: 'auto' }
      : { overflowX: 'hidden', overflowY: 'hidden' });
    vi.stubGlobal('getComputedStyle', computedStyle);

    expect(ViewportMediaHarness()).toBeUndefined();
    const observer = latestObserver();
    expect(observer.options).toMatchObject({ root: scroller, rootMargin: '800px 0px' });
    expect(computedStyle.mock.calls.map(([target]) => target)).toEqual([wrapper, scroller]);
    observer.emit(element, true);
    expect(ViewportMediaHarness()).toBe('asset://image.png');
  });

  it('pools observers within one scroller and releases other scrollers independently', () => {
    const left = { parentElement: null } as unknown as Element;
    const right = { parentElement: null } as unknown as Element;
    const first = { current: { parentElement: left } as unknown as Element };
    const second = { current: { parentElement: left } as unknown as Element };
    const third = { current: { parentElement: right } as unknown as Element };
    vi.stubGlobal('getComputedStyle', vi.fn(() => ({ overflowX: 'auto', overflowY: 'hidden' })));
    function PooledViewportHarness(skipThird = false, skipFirst = false, skipSecond = false) {
      beginRender();
      useViewportMediaSource('asset://first.png', first, { eager: skipFirst });
      useViewportMediaSource('asset://second.png', second, { eager: skipSecond });
      useViewportMediaSource('asset://third.png', third, { eager: skipThird });
      commitEffects();
    }

    PooledViewportHarness();
    expect(FakeObserver.instances).toHaveLength(2);
    const [leftObserver, rightObserver] = FakeObserver.instances;
    expect(leftObserver.options?.root).toBe(left);
    expect(leftObserver.observe.mock.calls).toEqual([[first.current], [second.current]]);
    expect(rightObserver.options?.root).toBe(right);
    PooledViewportHarness(true);
    expect(rightObserver.disconnect).toHaveBeenCalledOnce();
    expect(leftObserver.disconnect).not.toHaveBeenCalled();
    PooledViewportHarness(true, true);
    expect(leftObserver.unobserve).toHaveBeenCalledWith(first.current);
    expect(leftObserver.disconnect).not.toHaveBeenCalled();
    PooledViewportHarness(true, true, true);
    expect(leftObserver.disconnect).toHaveBeenCalledOnce();
    PooledViewportHarness();
    expect(FakeObserver.instances).toHaveLength(4);
    expect(FakeObserver.instances[2].options?.root).toBe(left);
    expect(FakeObserver.instances[3].options?.root).toBe(right);
  });

  it('keeps document scrolling on the browser viewport', () => {
    const body = { parentElement: null } as unknown as Element;
    Object.assign(element, { parentElement: body, ownerDocument: { body, scrollingElement: body } });
    const computedStyle = vi.fn();
    vi.stubGlobal('getComputedStyle', computedStyle);
    ViewportMediaHarness();
    expect(latestObserver().options?.root).toBeNull();
    expect(computedStyle).not.toHaveBeenCalled();
  });

  it('changes the default preload margin while preserving the current source until the unload grace expires', () => {
    expect(ViewportMediaHarness()).toBeUndefined();
    const normal = latestObserver();
    expect(normal.options?.rootMargin).toBe('800px 0px');
    normal.emit(element, true); expect(ViewportMediaHarness()).toBe('asset://image.png');
    syncPerformanceModeRuntime(true);
    expect(ViewportMediaHarness()).toBe('asset://image.png');
    const performance = latestObserver();
    expect(performance.options?.rootMargin).toBe('160px 0px');
    expect(normal.disconnect).toHaveBeenCalledOnce();
    performance.emit(element, false);
    vi.advanceTimersByTime(1_999); expect(ViewportMediaHarness()).toBe('asset://image.png');
    vi.advanceTimersByTime(1); expect(ViewportMediaHarness()).toBeUndefined();
  });

  it('respects explicit margins, unload delays, and eager playback in performance mode', () => {
    syncPerformanceModeRuntime(true);
    const options = { rootMargin: '20px 0px', unloadDelayMs: 600 };
    ViewportMediaHarness(undefined, options);
    const observer = latestObserver();
    expect(observer.options?.rootMargin).toBe('20px 0px');
    observer.emit(element, true); expect(ViewportMediaHarness(undefined, options)).toBe('asset://image.png');
    observer.emit(element, false);
    vi.advanceTimersByTime(599); expect(ViewportMediaHarness(undefined, options)).toBe('asset://image.png');
    vi.advanceTimersByTime(1); expect(ViewportMediaHarness(undefined, options)).toBeUndefined();
    expect(ViewportMediaHarness(undefined, { ...options, eager: true })).toBe('asset://image.png');
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it('cancels an old source unload before a replacement enters the viewport', () => {
    ViewportMediaHarness('asset://old.png');
    const old = latestObserver(); old.emit(element, true); old.emit(element, false);
    expect(ViewportMediaHarness('asset://new.png')).toBeUndefined();
    latestObserver().emit(element, true);
    expect(ViewportMediaHarness('asset://new.png')).toBe('asset://new.png');
    vi.advanceTimersByTime(2_000);
    expect(ViewportMediaHarness('asset://new.png')).toBe('asset://new.png');
    expect(old.unobserve).toHaveBeenCalledWith(element);
  });

  it('keeps short viewport boundary crossings from repeatedly unloading media', () => {
    syncPerformanceModeRuntime(true); ViewportMediaHarness();
    const observer = latestObserver(); observer.emit(element, true); ViewportMediaHarness();
    observer.emit(element, false); vi.advanceTimersByTime(1_000); observer.emit(element, true);
    vi.advanceTimersByTime(2_000);
    expect(ViewportMediaHarness()).toBe('asset://image.png');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('viewport-gated shared image previews', () => {
  it('retains native lazy loading when viewport observation is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const image = renderImage();
    expect(image.props.src).toBe('asset://image.png');
    expect(image.props.loading).toBe('lazy');
  });

  it('loads immediately inside the preload boundary without mounting distant image sources', () => {
    const deferred = renderImage();
    expect(deferred.props.src).toBeUndefined();
    expect(deferred.props.loading).toBe('eager');
    latestObserver().emit(element, true);
    const preloaded = renderImage();
    expect(preloaded.props.src).toBe('asset://image.png');
    expect(preloaded.props.loading).toBe('eager');
    expect(renderImage(undefined, undefined, 'owner', 'lazy').props.loading).toBe('lazy');
  });

  it('derives only visible images, releases on unload, and never remounts a revoked preview', async () => {
    const first = { src: 'blob:first', release: vi.fn() };
    const next = { src: 'blob:next', release: vi.fn() };
    acquire.mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    expect(renderImage(undefined, 512).props.src).toBeUndefined();
    expect(acquire).not.toHaveBeenCalled();
    latestObserver().emit(element, true);
    expect(renderImage(undefined, 512).props.src).toBeUndefined();
    expect(acquire).toHaveBeenCalledWith('asset://image.png', 512, expect.any(AbortSignal), 'owner');
    await Promise.resolve();
    expect(renderImage(undefined, 512).props.src).toBe(first.src);
    latestObserver().emit(element, false); vi.advanceTimersByTime(2_000);
    expect(renderImage(undefined, 512).props.src).toBeUndefined();
    expect(first.release).toHaveBeenCalledOnce();
    latestObserver().emit(element, true);
    expect(renderImage(undefined, 512).props.src).toBeUndefined();
    await Promise.resolve();
    expect(renderImage(undefined, 512).props.src).toBe(next.src);
  });

  it('returns a late acquired lease after source replacement without displaying it', async () => {
    let finish!: (value: { src: string; release: () => void }) => void;
    acquire.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    renderImage('asset://old.png', 512); latestObserver().emit(element, true); renderImage('asset://old.png', 512);
    const signal = acquire.mock.calls[0][2] as AbortSignal;
    expect(renderImage('asset://new.png', 512).props.src).toBeUndefined();
    expect(signal.aborted).toBe(true);
    const late = { src: 'blob:late', release: vi.fn() }; finish(late); await Promise.resolve();
    expect(late.release).toHaveBeenCalledOnce();
    expect(renderImage('asset://new.png', 512).props.src).toBeUndefined();
  });

  it('releases a previous project lease and rejects a late project result even when source and edge stay identical', async () => {
    const initial = { src: 'blob:project-a', release: vi.fn() };
    const current = { src: 'blob:project-c', release: vi.fn() };
    let finishPrevious!: (value: { src: string; release: () => void }) => void;
    acquire.mockResolvedValueOnce(initial)
      .mockReturnValueOnce(new Promise((resolve) => { finishPrevious = resolve; }))
      .mockResolvedValueOnce(current);
    renderImage(undefined, 512, 'project-a'); latestObserver().emit(element, true);
    renderImage(undefined, 512, 'project-a'); await Promise.resolve();
    expect(renderImage(undefined, 512, 'project-a').props.src).toBe(initial.src);
    expect(renderImage(undefined, 512, 'project-b').props.src).toBeUndefined();
    expect(initial.release).toHaveBeenCalledOnce();
    expect((acquire.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    expect(renderImage(undefined, 512, 'project-c').props.src).toBeUndefined();
    expect((acquire.mock.calls[1][2] as AbortSignal).aborted).toBe(true);
    await Promise.resolve();
    expect(renderImage(undefined, 512, 'project-c').props.src).toBe(current.src);
    const late = { src: 'blob:project-b-late', release: vi.fn() };
    finishPrevious(late); await Promise.resolve();
    expect(late.release).toHaveBeenCalledOnce();
    expect(renderImage(undefined, 512, 'project-c').props.src).toBe(current.src);
    expect(acquire.mock.calls.map((call) => [call[0], call[1], call[3]])).toEqual([
      ['asset://image.png', 512, 'project-a'],
      ['asset://image.png', 512, 'project-b'],
      ['asset://image.png', 512, 'project-c'],
    ]);
  });

  it('restores the original immediately when preview mode is disabled and never revives cancelled URLs after reopening', async () => {
    let finishCancelled!: (value: { src: string; release: () => void }) => void;
    let finishLatest!: (value: { src: string; release: () => void }) => void;
    const ready = { src: 'blob:ready', release: vi.fn() };
    acquire.mockReturnValueOnce(new Promise((resolve) => { finishCancelled = resolve; }))
      .mockResolvedValueOnce(ready)
      .mockReturnValueOnce(new Promise((resolve) => { finishLatest = resolve; }));
    renderImage(undefined, 512); latestObserver().emit(element, true); renderImage(undefined, 512);
    expect(renderImage().props.src).toBe('asset://image.png');
    expect((acquire.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    const late = { src: 'blob:cancelled', release: vi.fn() };
    finishCancelled(late); await Promise.resolve();
    expect(late.release).toHaveBeenCalledOnce();
    expect(renderImage().props.src).toBe('asset://image.png');
    expect(renderImage(undefined, 512).props.src).toBeUndefined();
    await Promise.resolve();
    expect(renderImage(undefined, 512).props.src).toBe(ready.src);
    expect(renderImage().props.src).toBe('asset://image.png');
    expect(ready.release).toHaveBeenCalledOnce();
    expect((acquire.mock.calls[1][2] as AbortSignal).aborted).toBe(true);
    expect(renderImage(undefined, 512).props.src).toBeUndefined();
    const latest = { src: 'blob:latest', release: vi.fn() };
    finishLatest(latest); await Promise.resolve();
    expect(renderImage(undefined, 512).props.src).toBe(latest.src);
    expect(acquire).toHaveBeenCalledTimes(3);
  });

  it('preserves explicit original images but never bypasses an unavailable preview', async () => {
    renderImage(); latestObserver().emit(element, true);
    expect(renderImage().props.src).toBe('asset://image.png');
    expect(acquire).not.toHaveBeenCalled();
    acquire.mockResolvedValueOnce(null);
    renderImage(undefined, 512); await Promise.resolve();
    expect(renderImage(undefined, 512).props.src).toBeUndefined();
    expect(element.dispatchEvent).toHaveBeenCalled();
  });

  it('reports a failed thumbnail without switching its src back to the original', async () => {
    const release = vi.fn();
    acquire.mockResolvedValueOnce({ src: 'blob:bad', release });
    renderImage(undefined, 512); latestObserver().emit(element, true); renderImage(undefined, 512);
    await Promise.resolve();
    const image = renderImage(undefined, 512);
    expect(image.props.src).toBe('blob:bad');
    image.props.onError?.({} as Parameters<NonNullable<typeof image.props.onError>>[0]);
    expect(release).toHaveBeenCalledOnce();
    expect(renderImage(undefined, 512).props.src).toBeUndefined();
  });
});
