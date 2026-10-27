import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Effect = { run: () => void | (() => void); deps?: readonly unknown[]; cleanup?: () => void };
type Lease = { src: string; release: () => void };
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  memos: [] as Array<{ value: unknown; deps: readonly unknown[] }>,
  effects: [] as Effect[], pending: [] as Effect[],
  stateCursor: 0, refCursor: 0, memoCursor: 0,
}));
const native = vi.hoisted(() => ({ matches: vi.fn(), acquire: vi.fn() }));

vi.mock('../../src/services/comfyImageSource', () => ({
  shouldLoadNativeComfyImage: native.matches,
  acquireComfyImageSource: native.acquire,
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useEffect: (run: Effect['run'], deps?: readonly unknown[]) => { hooks.pending.push({ run, deps }); },
  useRef: <T,>(value: T) => {
    const index = hooks.refCursor++;
    return (hooks.refs[index] ??= { current: value }) as { current: T };
  },
  useMemo: <T,>(compute: () => T, deps: readonly unknown[]) => {
    const index = hooks.memoCursor++;
    const previous = hooks.memos[index];
    if (!previous || deps.some((value, position) => !Object.is(value, previous.deps[position]))) {
      hooks.memos[index] = { value: compute(), deps };
    }
    return hooks.memos[index].value as T;
  },
  useState: <T,>(initial?: T | (() => T)) => {
    const index = hooks.stateCursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.values[index] as T, (next: T) => { hooks.values[index] = next; }] as const;
  },
}));

import { useComfyImageSource } from '../../src/hooks/useComfyImageSource';

const sourceA = 'http://127.0.0.1:8188/view?filename=a.png&type=output';
const sourceB = 'http://127.0.0.1:8188/view?filename=b.png&type=output';
function HookConsumer(source?: string, onError?: () => void): string | undefined {
  return useComfyImageSource(source, onError);
}
function render(source?: string, onError?: () => void): string | undefined {
  hooks.stateCursor = hooks.refCursor = hooks.memoCursor = 0;
  hooks.pending = [];
  return HookConsumer(source, onError);
}
function commit(): void {
  hooks.pending.forEach((next, index) => {
    const previous = hooks.effects[index];
    const changed = !previous || !next.deps || !previous.deps
      || next.deps.some((value, position) => !Object.is(value, previous.deps?.[position]));
    if (!changed) return;
    previous?.cleanup?.();
    hooks.effects[index] = { ...next, cleanup: next.run() || undefined };
  });
}
function unmount(): void {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  hooks.effects = [];
}
function deferredLease() {
  let resolve!: (lease: Lease) => void;
  const promise = new Promise<Lease>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  hooks.values = []; hooks.refs = []; hooks.memos = []; hooks.effects = []; hooks.pending = [];
  native.matches.mockReset().mockImplementation((source?: string) => source?.startsWith('http://127.0.0.1:8188/view?') === true);
  native.acquire.mockReset();
});
afterEach(unmount);

describe('useComfyImageSource', () => {
  it('keeps ordinary sources unchanged and does not read a deferred source', () => {
    for (const source of [undefined, 'asset://local.png', 'blob:existing', 'data:image/png;base64,AQ==', 'https://cdn.example/image.png']) {
      expect(render(source)).toBe(source);
      commit();
    }
    expect(native.acquire).not.toHaveBeenCalled();
  });

  it('only displays a native blob, keeps it across callback changes, and releases on unmount', async () => {
    const lease = { src: 'blob:native-a', release: vi.fn() };
    native.acquire.mockResolvedValue(lease);
    expect(render(sourceA, vi.fn())).toBeUndefined();
    expect(native.acquire).not.toHaveBeenCalled();
    commit();
    await Promise.resolve();
    expect(render(sourceA, vi.fn())).toBe(lease.src);
    commit();
    expect(native.acquire).toHaveBeenCalledOnce();
    expect(lease.release).not.toHaveBeenCalled();
    const signal = native.acquire.mock.calls[0][1] as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it('hides the old blob before releasing its lease after a source change is committed', async () => {
    const first = { src: 'blob:native-a', release: vi.fn() };
    const second = deferredLease();
    native.acquire.mockResolvedValueOnce(first).mockReturnValueOnce(second.promise);
    render(sourceA); commit(); await Promise.resolve();
    expect(render(sourceA)).toBe(first.src); commit();
    expect(render(sourceB)).toBeUndefined();
    expect(first.release).not.toHaveBeenCalled();
    commit();
    expect(first.release).toHaveBeenCalledOnce();
    const late = { src: 'blob:native-b', release: vi.fn() };
    second.resolve(late); await Promise.resolve();
    expect(render(sourceB)).toBe(late.src); commit();
    expect(render(undefined)).toBeUndefined(); commit();
    expect(late.release).toHaveBeenCalledOnce();
  });

  it('discards a late result from a source that was unloaded', async () => {
    const pending = deferredLease();
    native.acquire.mockReturnValue(pending.promise);
    render(sourceA); commit();
    expect(render(undefined)).toBeUndefined(); commit();
    const late = { src: 'blob:late', release: vi.fn() };
    pending.resolve(late); await Promise.resolve();
    expect(late.release).toHaveBeenCalledOnce();
    expect(render(undefined)).toBeUndefined();
  });

  it('reports native errors to the current callback without falling back to the remote URL', async () => {
    let reject!: (reason: Error) => void;
    native.acquire.mockReturnValue(new Promise<Lease>((_resolve, fail) => { reject = fail; }));
    const initialError = vi.fn(); const currentError = vi.fn();
    render(sourceA, initialError); commit();
    expect(render(sourceA, currentError)).toBeUndefined(); commit();
    reject(new Error('HTTP 403')); await Promise.resolve();
    expect(initialError).not.toHaveBeenCalled();
    expect(currentError).toHaveBeenCalledOnce();
    expect(render(sourceA, currentError)).toBeUndefined();
    expect(native.acquire).toHaveBeenCalledOnce();
  });

  it('does not downgrade an already-native source when server configuration changes', async () => {
    const pending = deferredLease();
    native.acquire.mockReturnValue(pending.promise);
    render(sourceA); commit();
    native.matches.mockReturnValue(false);
    expect(render(sourceA)).toBeUndefined(); commit();
    expect(native.acquire).toHaveBeenCalledOnce();
    const lease = { src: 'blob:still-native', release: vi.fn() };
    pending.resolve(lease); await Promise.resolve();
    expect(render(sourceA)).toBe(lease.src);
  });

  it('rejects a raw URL returned after a render-to-effect configuration change', async () => {
    const onError = vi.fn();
    const lease = { src: sourceA, release: vi.fn() };
    native.acquire.mockResolvedValue(lease);
    expect(render(sourceA, onError)).toBeUndefined();
    native.matches.mockReturnValue(false);
    commit(); await Promise.resolve();
    expect(lease.release).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(render(sourceA, onError)).toBeUndefined();
  });
});
