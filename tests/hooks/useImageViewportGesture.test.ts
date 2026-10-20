import type { PointerEvent as ReactPointerEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => {
  vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' });
  return {
    states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
    effects: [] as Array<{ deps: readonly unknown[]; cleanup?: () => void }>,
    pending: [] as Array<() => void>, stateIndex: 0, refIndex: 0, effectIndex: 0,
    updating: false,
  };
});

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useCallback: <T,>(callback: T) => callback,
  useRef: (initial: unknown) => {
    const index = driver.refIndex++;
    driver.refs[index] ??= { current: initial };
    return driver.refs[index];
  },
  useState: (initial: unknown) => {
    const index = driver.stateIndex++;
    if (!(index in driver.states)) driver.states[index] = initial;
    return [driver.states[index], (value: unknown) => {
      // 模拟 React 对同一旧状态重放更新；更新函数里再调 setter 会直接失败。
      if (driver.updating) throw new Error('状态更新函数不能嵌套调用 setter');
      if (typeof value !== 'function') { driver.states[index] = value; return; }
      driver.updating = true;
      try {
        const previous = driver.states[index];
        const first = value(previous);
        expect(value(previous)).toEqual(first);
        driver.states[index] = first;
      } finally { driver.updating = false; }
    }];
  },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const index = driver.effectIndex++;
    const previous = driver.effects[index];
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    driver.pending.push(() => {
      previous?.cleanup?.();
      driver.effects[index] = { deps, cleanup: effect() ?? undefined };
    });
  },
}));

import { useImageViewportGesture } from '../../src/hooks/useImageViewportGesture';

class Surface extends EventTarget {
  getBoundingClientRect() { return { left: 10, top: 20, width: 800, height: 600 }; }
}

function ImageViewportProbe(options: Parameters<typeof useImageViewportGesture>[0]) {
  return useImageViewportGesture(options);
}

function render(options: Parameters<typeof useImageViewportGesture>[0] = {}) {
  driver.stateIndex = driver.refIndex = driver.effectIndex = 0;
  const view = ImageViewportProbe(options);
  driver.pending.splice(0).forEach((effect) => effect());
  return view;
}
function position(view: ReturnType<typeof render>) { return { scale: view.scale, tx: view.tx, ty: view.ty }; }
function wheel(surface: Surface, extras: Record<string, unknown> = {}) {
  const event = new Event('wheel', { cancelable: true });
  Object.assign(event, { deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: true, clientX: 610, clientY: 220, ...extras });
  surface.dispatchEvent(event);
  return event;
}
function pointer(type: string, extras: Record<string, unknown> = {}) {
  const event = new Event(type);
  Object.assign(event, { pointerId: 7, button: 0, clientX: 400, clientY: 300, ...extras });
  return event;
}
function cleanup() {
  driver.effects.forEach((effect) => effect.cleanup?.());
  driver.effects = []; driver.pending = [];
}

beforeEach(() => {
  driver.states = []; driver.refs = []; driver.effects = []; driver.pending = [];
  driver.updating = false;
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('WheelEvent', { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('图片查看与裁切的原子视口更新', () => {
  it('点击放大时一次更新倍率和位移，重复求值不产生额外 setter', () => {
    const view = render();
    view.zoomTo(1.4);
    expect(position(render())).toEqual({ scale: 1.4, tx: 0, ty: 0 });
  });

  it('连续放大保持同一光标锚点，回到默认倍率时清除位移', () => {
    const view = render();
    view.zoomTo(2, 200, -100);
    expect(position(render())).toEqual({ scale: 2, tx: -200, ty: 100 });
    view.zoomTo(4, 200, -100);
    expect(position(render())).toEqual({ scale: 4, tx: -600, ty: 300 });
    view.zoomTo(1);
    expect(position(render())).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it('同帧多个捏合事件累计倍率，不重复施加锚点平移', () => {
    const surface = new Surface();
    render().containerRef(surface as unknown as HTMLDivElement);
    expect(wheel(surface).defaultPrevented).toBe(true);
    wheel(surface);
    const view = render();
    expect(view.scale).toBeCloseTo(Math.exp(0.2), 10);
    expect(view.tx).toBeCloseTo(200 * (1 - view.scale), 10);
    expect(view.ty).toBeCloseTo(-100 * (1 - view.scale), 10);
  });

  it('Mac 双指滚动在放大后平移，默认倍率时不移动图片', () => {
    const surface = new Surface();
    const view = render();
    view.containerRef(surface as unknown as HTMLDivElement);
    view.zoomTo(2);
    render();
    wheel(surface, { ctrlKey: false, deltaX: 10, deltaY: 20 });
    expect(position(render())).toEqual({ scale: 2, tx: -10, ty: -20 });
    view.reset();
    render();
    wheel(surface, { ctrlKey: false, deltaX: 10, deltaY: 20 });
    expect(position(render())).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it('拖动只响应同一指针，复位后在途移动不能恢复旧位移', () => {
    render().zoomTo(2);
    render().onPointerDown(pointer('pointerdown') as unknown as ReactPointerEvent);
    render();
    window.dispatchEvent(pointer('pointermove', { pointerId: 8, clientX: 900 }));
    expect(position(render())).toEqual({ scale: 2, tx: 0, ty: 0 });
    window.dispatchEvent(pointer('pointermove', { clientX: 430, clientY: 320 }));
    const moved = render();
    expect(position(moved)).toEqual({ scale: 2, tx: 30, ty: 20 });
    moved.reset();
    window.dispatchEvent(pointer('pointermove', { clientX: 800, clientY: 700 }));
    const reset = render();
    expect(position(reset)).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(reset.dragging).toBe(false);
    expect(reset.gesturing).toBe(false);
  });

  it('裁切继续使用自身的倍率范围、初始倍率和右键拖动配置', () => {
    const options = { initialScale: 1, minScale: 0.1, maxScale: 5, panButtons: [1, 2] };
    render(options).zoomTo(2);
    render(options).onPointerDown(pointer('pointerdown') as unknown as ReactPointerEvent);
    expect(render(options).dragging).toBe(false);
    render(options).onPointerDown(pointer('pointerdown', { button: 2 }) as unknown as ReactPointerEvent);
    expect(render(options).dragging).toBe(true);
    render(options).zoomTo(0.01);
    expect(position(render(options))).toEqual({ scale: 0.1, tx: 0, ty: 0 });
    render(options).zoomTo(99);
    expect(render(options).scale).toBe(5);
  });

  it('拒绝非有限输入，达到上限后不继续改变锚点', () => {
    const view = render();
    view.zoomTo(8, 10, 20);
    const maximum = position(render());
    view.zoomTo(9, 300, 400);
    view.zoomTo(NaN);
    view.zoomTo(2, Infinity, 0);
    expect(position(render())).toEqual(maximum);
  });

  it('容器卸载后取消监听和手势定时器，不再响应迟到滚轮', () => {
    const surface = new Surface();
    const view = render();
    view.containerRef(surface as unknown as HTMLDivElement);
    wheel(surface);
    const previous = position(render());
    view.containerRef(null);
    cleanup();
    expect(wheel(surface).defaultPrevented).toBe(false);
    expect(position(render())).toEqual(previous);
    expect(vi.getTimerCount()).toBe(0);
  });
});
