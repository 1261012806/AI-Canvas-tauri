import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMFY_LAUNCH_SETTINGS, isValidComfyLaunchSettings, isValidComfyH3MemoryApplication, comfyH3MemoryFingerprint } from '../../src/types/comfyLaunch';
import { getComfyLaunchSettings, normalizeComfyLaunchSettings, saveComfyLaunchSettings } from '../../src/services/comfyLaunchSettingsService';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => invoke.mockReset());

describe('ComfyUI 显存设置兼容与输入边界', () => {
  it('非法已有对象不静默回落默认配置', () => {
    for (const value of [null, false, 3, [], { h3Memory: null }, { h3Memory: false }, { h3Memory: 12 }]) {
      expect(() => normalizeComfyLaunchSettings(value)).toThrow('显存设置无效');
    }
  });

  it('执行回执只接受固定选项，策略摘要只随实际配置变化', () => {
    const settings = { ...DEFAULT_COMFY_LAUNCH_SETTINGS.h3Memory, preset: 'safe12' as const };
    expect(isValidComfyH3MemoryApplication({ preset: 'safe12' })).toBe(false);
    expect(isValidComfyH3MemoryApplication({ preset: 'safe12', settings, applied: ['arbitrary'] })).toBe(false);
    expect(isValidComfyH3MemoryApplication({ preset: 'custom', settings, applied: ['attention'] })).toBe(false);
    expect(isValidComfyH3MemoryApplication({ preset: 'safe12', settings, applied: ['attention'] })).toBe(true);
    expect(comfyH3MemoryFingerprint({ ...settings })).toBe(comfyH3MemoryFingerprint(settings));
    expect(comfyH3MemoryFingerprint({ ...settings, attentionHeadChunks: 8 })).not.toBe(comfyH3MemoryFingerprint(settings));
    expect(comfyH3MemoryFingerprint(undefined)).not.toBe(comfyH3MemoryFingerprint(settings));
  });
  it('旧配置补齐新增选项，保持原启动行为并关闭 H3 改写', async () => {
    const legacy = { port: 8190, vramMode: 'low' as const, precision: 'auto' as const,
      attention: 'auto' as const, previewMethod: 'none' as const, disableSmartMemory: false };
    invoke.mockResolvedValue(legacy);
    const settings = await getComfyLaunchSettings();
    expect(settings).toEqual({ ...DEFAULT_COMFY_LAUNCH_SETTINGS, ...legacy });
    expect(settings.h3Memory.preset).toBe('off');
    expect(settings.h3Memory).not.toBe(DEFAULT_COMFY_LAUNCH_SETTINGS.h3Memory);
    expect(invoke).toHaveBeenCalledWith('get_comfyui_launch_settings');
  });

  it('拒绝冲突模式、小数、非法刻度与越界，不调用原生保存', async () => {
    const invalid = [
      { reserveVramGb: -1 }, { reserveVramGb: 0.5 }, { reserveVramGb: 65 },
      { asyncOffloadStreams: 0 }, { asyncOffloadStreams: 5 },
      { dynamicVram: 'enabled' as const, vramMode: 'high' as const },
      ...[{ attentionHeadChunks: 57 }, { feedForwardThreshold: 4097 }, { referenceImageMaxSize: 513 },
        { vaeTileSize: 127 }, { vaeTemporalSize: 17 }].map((h3) => ({ h3Memory: { ...DEFAULT_COMFY_LAUNCH_SETTINGS.h3Memory, ...h3 } })),
    ];
    for (const patch of invalid) {
      const settings = { ...DEFAULT_COMFY_LAUNCH_SETTINGS, ...patch };
      expect(isValidComfyLaunchSettings(settings)).toBe(false);
      expect(() => normalizeComfyLaunchSettings(settings)).toThrow('显存设置无效');
      await expect(saveComfyLaunchSettings(settings)).rejects.toThrow('显存设置无效');
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('保存独立启动选项与 H3 预设，保持返回值的默认兼容', async () => {
    const settings = normalizeComfyLaunchSettings({ dynamicVram: 'enabled', reserveVramGb: 1,
      asyncOffload: 'enabled', asyncOffloadStreams: 2,
      h3Memory: { ...DEFAULT_COMFY_LAUNCH_SETTINGS.h3Memory, preset: 'safe12' } });
    invoke.mockResolvedValue(settings);
    expect(await saveComfyLaunchSettings(settings)).toEqual(settings);
    expect(invoke).toHaveBeenCalledWith('save_comfyui_launch_settings', { settings });
  });
});
