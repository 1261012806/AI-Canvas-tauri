import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramaAssetImportPreview } from '../../src/services/dramaAssetTransferFormat';

const hooks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<(() => void) | undefined>,
  stateIndex: 0, refIndex: 0, effectIndex: 0,
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useId: () => 'import-choice',
  useMemo: <T,>(factory: () => T) => factory(),
  useCallback: <T,>(callback: T) => callback,
  useRef: <T,>(initial: T) => (hooks.refs[hooks.refIndex++] ??= { current: initial }),
  useState: <T,>(initial: T | (() => T)) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.states[index], (next: T | ((current: T) => T)) => {
      hooks.states[index] = typeof next === 'function' ? (next as (current: T) => T)(hooks.states[index] as T) : next;
    }];
  },
  useEffect: (effect: () => (() => void) | void) => {
    const index = hooks.effectIndex++;
    if (!(index in hooks.effects)) hooks.effects[index] = effect() || undefined;
  },
}));
vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: () => null }));

import DramaAssetImportDialog from '../../src/components/assets/DramaAssetImportDialog';
import { useDramaAssetImportDialog } from '../../src/hooks/useDramaAssetImportDialog';
import { setLocale } from '../../src/i18n';

const preview: DramaAssetImportPreview = { name: '共享素材包',
  items: [{ kind: 'scene', id: 'scene', name: '客厅', mediaIds: ['shared'], sameName: true },
    { kind: 'prop', id: 'prop', name: '桌子', mediaIds: ['shared'], sameName: false }],
  media: [{ id: 'shared', kind: 'image', bytes: 1024 }],
};
type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value && typeof value === 'object' && 'props' in value ? text((value as Element).props.children) : '';
}
function render<T>(work: () => T): T {
  hooks.stateIndex = hooks.refIndex = hooks.effectIndex = 0;
  return work();
}
function click(tree: unknown, label: string) {
  const button = elements(tree).find((element) => element.type === 'button' && text(element.props.children) === label)!;
  (button.props.onClick as () => void)();
}
beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.effects = [];
  setLocale('zh-CN');
});
afterEach(() => hooks.effects.forEach((cleanup) => cleanup?.()));

describe('creative asset import choices', () => {
  it('starts selected, counts shared media once, and confirms only selected package identities', () => {
    const onChoose = vi.fn();
    const draw = () => render(() => DramaAssetImportDialog({ preview, onChoose }));
    let tree = draw();
    expect(elements(tree).find((element) => element.props.role === 'status')?.props.children).toBe('已选 2 项资产，1 份媒体，共 1.0 KB');
    expect(text(tree)).toContain('存在同名条目，将新增副本');
    expect(elements(tree).filter((element) => element.type === 'input').every((element) => element.props.checked)).toBe(true);
    click(tree, '取消全选'); tree = draw();
    expect(elements(tree).find((element) => element.type === 'button' && text(element.props.children) === '导入所选资产')?.props.disabled).toBe(true);
    const first = elements(tree).find((element) => element.type === 'input')!;
    (first.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    tree = draw(); click(tree, '导入所选资产');
    expect(onChoose).toHaveBeenCalledExactlyOnceWith([{ kind: 'scene', id: 'scene' }]);
  });

  it('settles the pending choice and removes the dialog when the operation aborts', async () => {
    let state = render(useDramaAssetImportDialog);
    const controller = new AbortController();
    const choice = state.chooseAssets(preview, controller.signal);
    state = render(useDramaAssetImportDialog);
    expect(state.dialog).not.toBeNull();
    controller.abort();
    await expect(choice).resolves.toBeNull();
    expect(render(useDramaAssetImportDialog).dialog).toBeNull();
  });

  it('unmount resolves pending work and refuses a retained callback after unmount', async () => {
    const state = render(useDramaAssetImportDialog);
    const choice = state.chooseAssets(preview);
    hooks.effects.forEach((cleanup) => cleanup?.());
    await expect(choice).resolves.toBeNull();
    await expect(state.chooseAssets(preview)).resolves.toBeNull();
  });

  it('an exiting dialog cannot complete a later import request', async () => {
    const state = render(useDramaAssetImportDialog);
    const firstChoice = state.chooseAssets(preview);
    const oldDialog = render(useDramaAssetImportDialog).dialog!;
    oldDialog.props.onChoose(null);
    await expect(firstChoice).resolves.toBeNull();
    const secondChoice = state.chooseAssets(preview);
    oldDialog.props.onChoose([{ kind: 'scene', id: 'scene' }]);
    const newDialog = render(useDramaAssetImportDialog).dialog!;
    expect(newDialog.key).not.toBe(oldDialog.key);
    newDialog.props.onChoose([{ kind: 'prop', id: 'prop' }]);
    await expect(secondChoice).resolves.toEqual([{ kind: 'prop', id: 'prop' }]);
  });
});
