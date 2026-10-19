import type { ImgHTMLAttributes, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisplayImageLease } from '../../src/components/nodes/shared/image/canvasImageDisplay';

const driver = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>,
  stateIndex: 0, refIndex: 0, effectIndex: 0, zoom: 1,
  listeners: new Set<() => void>(), create: vi.fn(),
  config: { performanceMode: false },
  configListeners: new Set<(state: { config: { performanceMode: boolean } }, previous: { config: { performanceMode: boolean } }) => void>(),
}));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = driver.effectIndex++; const previous = driver.effects[index];
    if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
    driver.pending.push(() => { previous?.cleanup?.(); driver.effects[index] = { deps, cleanup: run() ?? undefined }; });
  };
  return { ...actual, memo: <T,>(value: T) => value, useContext: () => null,
    useState: <T,>(initial: T) => { const i = driver.stateIndex++; if (!(i in driver.states)) driver.states[i] = initial;
      return [driver.states[i], (value: T) => { driver.states[i] = value; }]; },
    useRef: <T,>(initial: T) => { const i = driver.refIndex++; driver.refs[i] ??= { current: initial }; return driver.refs[i]; },
    useEffect: effect, useLayoutEffect: effect,
  };
});
vi.mock('@xyflow/react', () => {
  const flow = { getState: () => ({ transform: [0, 0, driver.zoom] }),
    subscribe: (f: () => void) => { driver.listeners.add(f); return () => driver.listeners.delete(f); } };
  return { useStoreApi: () => flow };
});
vi.mock('../../src/components/nodes/shared/image/canvasImageDisplay', () => ({ createCanvasImageDisplay: driver.create }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: {
  getState: () => ({ config: driver.config }),
  subscribe: (listener: (typeof driver.configListeners extends Set<infer T> ? T : never)) => {
    driver.configListeners.add(listener); return () => driver.configListeners.delete(listener);
  },
} }));
import CanvasPreviewImage from '../../src/components/nodes/shared/image/CanvasPreviewImage';
type Props = Parameters<typeof CanvasPreviewImage>[0];
const base: Props = { src: 'asset://a.png', projectId: 'project-a', nodeWidth: 280, nodeHeight: 158 };
let active: { viewport: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; committed: ReturnType<typeof vi.fn>; original: ReturnType<typeof vi.fn> };
let publish: (lease: DisplayImageLease) => void;
function render(props = base) {
  driver.stateIndex = driver.refIndex = driver.effectIndex = 0;
  const image = CanvasPreviewImage(props) as ReactElement<ImgHTMLAttributes<HTMLImageElement>>;
  driver.pending.splice(0).forEach((effect) => effect());
  return image;
}
beforeEach(() => {
  driver.states = []; driver.refs = []; driver.effects = []; driver.pending = []; driver.listeners.clear(); driver.zoom = 1;
  driver.config = { performanceMode: false }; driver.configListeners.clear();
  driver.create.mockReset().mockImplementation((options: { publish: typeof publish }) => {
    publish = options.publish;
    active = { viewport: vi.fn(), dispose: vi.fn(), committed: vi.fn(), original: vi.fn() }; return active;
  });
  vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { driver.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe('canvas preview image integration', () => {
  it('retains one img across all source tiers and only exposes committed, project-matching sources', () => {
    expect(render().type).toBe('img'); expect(active.viewport).toHaveBeenCalledWith(1, 280, 158, 1, false);
    const lease = { src: 'blob:512', release: vi.fn() }; publish(lease);
    expect(render().props.src).toBe('blob:512'); expect(active.committed).toHaveBeenCalledWith(lease);
    const first = active; driver.zoom = 5; driver.listeners.forEach((f) => f());
    expect(active.viewport).toHaveBeenLastCalledWith(5, 280, 158, 1, false); expect(render().props.src).toBe('blob:512');
    publish({ src: base.src!, release: vi.fn() }); expect(render().type).toBe('img');
    expect(render().props.src).toBe(base.src); expect(active).toBe(first);
    expect(render({ ...base, projectId: 'project-b' }).props.src).toBeUndefined(); expect(first.dispose).toHaveBeenCalledOnce();
  });
  it('does not re-create the controller for pan or size changes and removes subscriptions on source change', () => {
    render(); const first = active; driver.listeners.forEach((f) => f());
    expect(active.viewport).toHaveBeenCalledOnce();
    render({ ...base, nodeWidth: 560 }); expect(driver.create).toHaveBeenCalledOnce();
    expect(active.viewport).toHaveBeenLastCalledWith(1, 560, 158, 1, false);
    render({ ...base, src: 'asset://a.png?revision=2' });
    expect(first.dispose).toHaveBeenCalledOnce(); expect(driver.listeners.size).toBe(1);
    expect(driver.configListeners.size).toBe(1);
  });
  it('updates modes without recreating the controller or hiding the displayed image', () => {
    render(); const first = active;
    publish({ src: 'blob:ready', release: vi.fn() });
    expect(render().props.src).toBe('blob:ready');
    for (const performanceMode of [true, false, true]) {
      const previous = { config: driver.config };
      driver.config = { performanceMode };
      driver.configListeners.forEach((f) => f({ config: driver.config }, previous));
      expect(active.viewport).toHaveBeenLastCalledWith(1, 280, 158, 1, performanceMode);
      expect(render().props.src).toBe('blob:ready');
      expect(active).toBe(first);
    }
    render({ ...base, nodeWidth: 560 });
    expect(active.viewport).toHaveBeenLastCalledWith(1, 560, 158, 1, true);
    expect(driver.create).toHaveBeenCalledOnce(); expect(first.dispose).not.toHaveBeenCalled();
    const calls = active.viewport.mock.calls.length;
    driver.configListeners.forEach((f) => f({ config: driver.config }, { config: driver.config }));
    expect(active.viewport).toHaveBeenCalledTimes(calls);
    driver.effects.forEach((effect) => effect.cleanup?.());
    expect(driver.configListeners.size).toBe(0); expect(driver.listeners.size).toBe(0);
  });
  it('keeps internal properties out of the DOM and handles absent sources', () => {
    const image = render({ ...base, nodeId: 'a', src: undefined });
    expect(image.props.src).toBeUndefined(); expect(driver.create).not.toHaveBeenCalled();
    for (const key of ['nodeId', 'nodeWidth', 'nodeHeight', 'projectId']) expect(image.props).not.toHaveProperty(key);
  });
  it('reports failed previews without automatically requesting the original', () => {
    const onError = vi.fn(); const props = { ...base, onError }; render(props);
    const event = {} as Parameters<NonNullable<ImgHTMLAttributes<HTMLImageElement>['onError']>>[0];
    publish({ src: 'blob:bad', release: vi.fn() }); render(props).props.onError?.(event);
    expect(active.original).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledWith(event);
    publish({ src: base.src!, release: vi.fn() }); render(props).props.onError?.(event);
    expect(onError).toHaveBeenCalledWith(event);
  });
});
