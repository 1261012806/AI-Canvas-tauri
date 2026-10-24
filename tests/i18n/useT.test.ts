import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Reuse the project's hook-slot approach without adding a DOM test dependency.
const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as Array<{ value: unknown; deps: readonly unknown[] }>,
  unsubscribe: undefined as (() => void) | undefined,
  notify: vi.fn(),
}));

vi.mock('react', () => {
  const memo = <T>(create: () => T, deps: readonly unknown[]): T => {
    const index = harness.cursor++;
    const previous = harness.slots[index];
    if (!previous || previous.deps.length !== deps.length
      || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      harness.slots[index] = { value: create(), deps };
    }
    return harness.slots[index].value as T;
  };
  return {
    useMemo: memo,
    useCallback: <T>(callback: T, deps: readonly unknown[]) => memo(() => callback, deps),
    useSyncExternalStore: (subscribe: (notify: () => void) => () => void, getSnapshot: () => unknown) => {
      harness.unsubscribe ??= subscribe(harness.notify);
      return getSnapshot();
    },
  };
});

import { useMemo } from 'react';
import { setLocale, useT } from '../../src/i18n';

function HookHarness() {
  harness.cursor = 0;
  const t = useT();
  return { t, label: useMemo(() => t('设置'), [t]) };
}

beforeEach(() => {
  harness.slots = [];
  setLocale('zh-CN');
});

afterEach(() => {
  harness.unsubscribe?.();
  harness.unsubscribe = undefined;
  setLocale('zh-CN');
});

describe('useT language changes', () => {
  it('refreshes memoized labels on language changes and stays stable within a language', () => {
    const initial = HookHarness();
    expect(HookHarness().t).toBe(initial.t);
    setLocale('en-US');
    expect(harness.notify).toHaveBeenCalledOnce();
    const english = HookHarness();
    expect(english.t).not.toBe(initial.t);
    expect(english.label).toBe('Settings');
    expect(HookHarness().t).toBe(english.t);
    setLocale('ja-JP');
    expect(HookHarness().label).toBe('設定');
    setLocale('ko-KR');
    expect(HookHarness().label).toBe('설정');
    setLocale('zh-CN');
    expect(HookHarness().label).toBe('设置');
  });
});
