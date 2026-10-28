import { invoke } from '@tauri-apps/api/core';
import type { ComfyUILaunchSettings } from '../types/comfyLaunch';
import { DEFAULT_COMFY_LAUNCH_SETTINGS, isValidComfyLaunchSettings } from '../types/comfyLaunch';

/** 旧配置或旧桌面端返回值补齐新增字段；非法已存在值仍明确报错。 */
export function normalizeComfyLaunchSettings(value: unknown): ComfyUILaunchSettings {
  const invalid = () => new Error('ComfyUI 显存设置无效，请检查数值范围与冲突选项');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const partial = value as Partial<ComfyUILaunchSettings>;
  if (partial.h3Memory !== undefined && (!partial.h3Memory || typeof partial.h3Memory !== 'object' || Array.isArray(partial.h3Memory))) throw invalid();
  const settings = { ...DEFAULT_COMFY_LAUNCH_SETTINGS, ...partial,
    h3Memory: { ...DEFAULT_COMFY_LAUNCH_SETTINGS.h3Memory, ...partial.h3Memory } };
  if (!isValidComfyLaunchSettings(settings)) throw new Error('ComfyUI 显存设置无效，请检查数值范围与冲突选项');
  return settings;
}

export const getComfyLaunchSettings = async (): Promise<ComfyUILaunchSettings> =>
  normalizeComfyLaunchSettings(await invoke<ComfyUILaunchSettings>('get_comfyui_launch_settings'));

export const saveComfyLaunchSettings = async (settings: ComfyUILaunchSettings): Promise<ComfyUILaunchSettings> => {
  if (!isValidComfyLaunchSettings(settings)) throw new Error('ComfyUI 显存设置无效，请检查数值范围与冲突选项');
  return normalizeComfyLaunchSettings(await invoke<ComfyUILaunchSettings>('save_comfyui_launch_settings', { settings }));
};
