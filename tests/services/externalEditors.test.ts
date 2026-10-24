import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openInJianying, openInPhotoshop, openInPremiere } from '../../src/services/fs/externalEditors';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/path', () => ({ localDataDir: vi.fn() }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => true, joinPath: (...parts: string[]) => parts.join('/') }));

beforeEach(() => {
  native.invoke.mockReset();
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('macOS external editor launch results', () => {
  it.each([
    { openEditor: openInPhotoshop, first: 'Adobe Photoshop 2025', second: 'Adobe Photoshop 2024' },
    { openEditor: openInPremiere, first: 'Adobe Premiere Pro 2026', second: 'Adobe Premiere Pro 2025' },
    { openEditor: openInJianying, first: '剪映专业版', second: 'JianyingPro' },
  ])('tries the next installed candidate after native launch failure for $first', async ({ openEditor, first, second }) => {
    native.invoke.mockRejectedValueOnce(new Error('应用未安装')).mockResolvedValueOnce(undefined);

    await openEditor('/project/素材 #1.png');

    expect(native.invoke).toHaveBeenNthCalledWith(1, 'open_with_app', { appPath: first, filePath: '/project/素材 #1.png' });
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'open_with_app', { appPath: second, filePath: '/project/素材 #1.png' });
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it('reports failure after every automatic candidate is rejected', async () => {
    native.invoke.mockRejectedValue(new Error('应用未安装'));

    await expect(openInPhotoshop('/project/photo.png')).rejects.toThrow('未找到 Photoshop');

    expect(native.invoke).toHaveBeenCalledTimes(4);
    expect(native.invoke).toHaveBeenLastCalledWith('open_with_app', { appPath: 'Adobe Photoshop', filePath: '/project/photo.png' });
  });

  it('reports configured application failure without silently switching applications', async () => {
    native.invoke.mockRejectedValue(new Error('应用未能打开文件'));

    await expect(openInPhotoshop('/project/photo.png', '/Applications/Photoshop.app')).rejects.toThrow('配置的 Photoshop 路径无效');

    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('open_with_app', {
      appPath: '/Applications/Photoshop.app', filePath: '/project/photo.png',
    });
  });
});
