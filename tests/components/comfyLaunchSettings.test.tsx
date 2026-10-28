import type { ReactElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_COMFY_LAUNCH_SETTINGS } from '../../src/types/comfyLaunch';

const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }));
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), run: vi.fn() }));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: T | ((value: T) => T)) => {
      hooks.states[index] = typeof next === 'function' ? (next as (value: T) => T)(hooks.states[index] as T) : next;
    }];
  },
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
}));
vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/services/comfyLaunchSettingsService', () => ({
  getComfyLaunchSettings: mocks.get, saveComfyLaunchSettings: mocks.save,
}));

import ComfyLaunchSettings from '../../src/components/comfyui/ComfyLaunchSettings';
import ComfyH3MemoryFields from '../../src/components/comfyui/ComfyH3MemoryFields';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}
function render(busy = false) {
  hooks.cursor = 0;
  return elements(ComfyLaunchSettings({ busy, run: mocks.run }));
}
function field(id: string, busy = false) { return render(busy).find((element) => element.props.id === id)!; }
function changeSelect(id: string, value: string) { (field(id).props.onChange as (next: string) => void)(value); }
function changeNumber(id: string, value: number) {
  (field(id).props.onChange as (event: unknown) => void)({ target: { valueAsNumber: value } });
}
function saveButton() {
  return render().find((element) => element.type === 'button' && element.props.className === 'ui-btn ui-btn--primary')!;
}
async function load() {
  render();
  hooks.effects[0]();
  await Promise.resolve();
}
function h3Fields() { return render().find((element) => element.type === ComfyH3MemoryFields)!; }

beforeEach(() => {
  hooks.states = []; hooks.cursor = 0; hooks.effects = [];
  mocks.get.mockReset().mockResolvedValue({ ...DEFAULT_COMFY_LAUNCH_SETTINGS, h3Memory: { ...DEFAULT_COMFY_LAUNCH_SETTINGS.h3Memory } });
  mocks.save.mockReset().mockImplementation(async (settings: unknown) => settings);
  mocks.run.mockReset().mockImplementation(async (_label: string, operation: () => Promise<string>) => { await operation(); return true; });
});

it('默认保留安装版本行为和智能显存，不自动启用 H3 修改', async () => {
  await load();
  expect(field('comfy-launch-dynamic-vram').props.value).toBe('auto');
  expect(field('comfy-launch-reserve-mode').props.value).toBe('auto');
  expect(render().some((element) => element.props.id === 'comfy-launch-reserve-vram')).toBe(false);
  expect(render().find((element) => element.props['aria-labelledby'] === 'comfy-smart-memory-label')?.props['aria-checked']).toBe(true);
  expect((h3Fields().props.value as { preset: string }).preset).toBe('off');
  expect(saveButton().props.disabled).toBe(true);
});

it('仅手动预留时显示数值框，切回自动后恢复默认状态', async () => {
  await load();
  changeSelect('comfy-launch-reserve-mode', 'manual');
  expect(field('comfy-launch-reserve-vram').props.value).toBe(1);
  changeNumber('comfy-launch-reserve-vram', 65);
  expect(field('comfy-launch-reserve-vram').props['aria-invalid']).toBe(true);
  expect(saveButton().props.disabled).toBe(true);
  changeNumber('comfy-launch-reserve-vram', 0);
  expect(saveButton().props.disabled).toBe(false);
  expect(field('comfy-launch-reserve-mode', true).props.disabled).toBe(true);
  expect(field('comfy-launch-reserve-vram', true).props.disabled).toBe(true);
  changeSelect('comfy-launch-reserve-mode', 'auto');
  expect(render().some((element) => element.props.id === 'comfy-launch-reserve-vram')).toBe(false);
  // 默认本来就是自动，切回后不产生无意义的保存。
  expect(saveButton().props.disabled).toBe(true);
});

it('显式开启异步卸载才显示流数，非法流数阻止保存', async () => {
  await load();
  expect(render().some((element) => element.props.id === 'comfy-launch-offload-streams')).toBe(false);
  changeSelect('comfy-launch-async-offload', 'enabled');
  expect(field('comfy-launch-offload-streams').props.value).toBe(2);
  changeNumber('comfy-launch-offload-streams', 5);
  expect(saveButton().props.disabled).toBe(true);
  changeNumber('comfy-launch-offload-streams', 3);
  expect(saveButton().props.disabled).toBe(false);
  expect(field('comfy-launch-offload-streams', true).props.disabled).toBe(true);
});

it('动态显存冲突和空数值都不能保存，修正后一次保存完整 H3 配置', async () => {
  await load();
  changeSelect('comfy-launch-dynamic-vram', 'enabled');
  changeSelect('comfy-launch-vram', 'high');
  expect(saveButton().props.disabled).toBe(true);
  changeSelect('comfy-launch-vram', 'auto');
  changeNumber('comfy-launch-port', Number.NaN);
  expect(saveButton().props.disabled).toBe(true);
  changeNumber('comfy-launch-port', 8189);
  const h3 = h3Fields();
  (h3.props.onChange as (next: unknown) => void)({ ...(h3.props.value as object), preset: 'safe12' });
  expect(saveButton().props.disabled).toBe(false);
  (saveButton().props.onClick as () => void)();
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.save).toHaveBeenCalledOnce();
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
    port: 8189, dynamicVram: 'enabled', disableSmartMemory: false,
    h3Memory: expect.objectContaining({ preset: 'safe12', referenceImageMaxSize: 512 }),
  }));
  expect(saveButton().props.disabled).toBe(true);
});

it('H3 自定义可保持原文本设备并关闭 VAE 改写，保守档只显示固定摘要', () => {
  const onChange = vi.fn();
  const value = { ...DEFAULT_COMFY_LAUNCH_SETTINGS.h3Memory, preset: 'custom' as const, vaeTiling: false };
  const custom = elements(ComfyH3MemoryFields({ value, disabled: false, onChange }));
  expect(custom.some((element) => element.props.id === 'comfy-h3-vae-tile')).toBe(false);
  const device = custom.find((element) => element.props.id === 'comfy-h3-text-device')!;
  (device.props.onChange as (next: string) => void)('auto');
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ textEncoderDevice: 'auto', vaeTiling: false }));
  const conservative = elements(ComfyH3MemoryFields({ value: { ...value, preset: 'safe12' }, disabled: false, onChange }));
  expect(conservative.some((element) => element.type === 'input')).toBe(false);
  expect(conservative.some((element) => element.props.children === '参考图片长边上限 512px；请求 VAE 空间块 256px、时间块 16 帧。')).toBe(true);
  const preset = custom.find((element) => element.props.id === 'comfy-h3-memory-preset')!;
  (preset.props.onChange as (next: string) => void)('safe12');
  expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_COMFY_LAUNCH_SETTINGS.h3Memory, preset: 'safe12' });
});
