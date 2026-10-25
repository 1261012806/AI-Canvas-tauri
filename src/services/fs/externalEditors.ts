/**
 * fs/externalEditors — 外部视频编辑器（剪映 / Premiere）探测与唤起。
 * 按平台（Windows / macOS）探测已安装的编辑器可执行文件，定位最近项目目录并拉起外部编辑器。
 */
import { invoke } from '@tauri-apps/api/core';
import { localDataDir } from '@tauri-apps/api/path';
import { isTauriEnv, joinPath } from './core';

type VideoEditorId = 'jianying' | 'premiere';

interface VideoEditorDefinition {
  displayName: string;
  executableNames: string[];
  macAppNames: string[];
}

const VIDEO_EDITOR_DEFINITIONS: Record<VideoEditorId, VideoEditorDefinition> = {
  jianying: {
    displayName: '剪映专业版',
    executableNames: ['JianyingPro.exe'],
    macAppNames: ['剪映专业版', 'JianyingPro'],
  },
  premiere: {
    displayName: 'Adobe Premiere Pro',
    executableNames: ['Adobe Premiere Pro.exe'],
    macAppNames: [
      'Adobe Premiere Pro 2026',
      'Adobe Premiere Pro 2025',
      'Adobe Premiere Pro 2024',
      'Adobe Premiere Pro 2023',
      'Adobe Premiere Pro 2022',
      'Adobe Premiere Pro 2021',
      'Adobe Premiere Pro',
    ],
  },
};

async function launchApp(appPath: string, filePath: string): Promise<boolean> {
  try {
    await invoke('open_with_app', { appPath, filePath });
    return true;
  } catch (error) {
    console.warn('[fileService] launchApp 失败:', appPath, error);
    return false;
  }
}

/** 在系统文件管理器中显示文件位置。 */
export async function revealFileInFolder(filePath: string): Promise<void> {
  if (!isTauriEnv()) {
    console.warn('[fileService] revealFileInFolder: 仅 Tauri 桌面环境支持');
    return;
  }

  await invoke('reveal_in_file_manager', { path: filePath, select: true });
}

/** 在系统文件管理器中打开目录。 */
export async function openDirectoryInFileManager(dirPath: string): Promise<void> {
  if (!isTauriEnv()) {
    console.warn('[fileService] openDirectoryInFileManager: 仅 Tauri 桌面环境支持');
    return;
  }

  await invoke('reveal_in_file_manager', { path: dirPath, select: false });
}

/** 在 Photoshop 中打开图片文件。 */
export async function openInPhotoshop(filePath: string, customPath?: string): Promise<void> {
  if (!isTauriEnv()) {
    console.warn('[fileService] openInPhotoshop: 仅 Tauri 桌面环境支持');
    return;
  }

  try {
    const platform = (navigator.platform || '').toLowerCase();

    if (platform.includes('win')) {
      const winPath = filePath.replace(/\//g, '\\');
      if (customPath?.trim()) {
        const resolved = customPath.replace(/\/+$/, '').replace(/\\+$/, '');
        const tries = /photoshop\.exe$/i.test(resolved)
          ? [resolved]
          : [resolved, `${resolved}\\Photoshop.exe`];
        for (const photoshopPath of tries) {
          if (await launchApp(photoshopPath, winPath)) return;
        }
        throw new Error(`配置的 Photoshop 路径无效: ${customPath}`);
      }

      const drives = ['C:', 'D:', 'E:', 'F:', 'G:'];
      const versions = ['2026', '2025', '2024', '2023', '2022', '2021', ''];
      for (const drive of drives) {
        for (const version of versions) {
          const dir = version ? `Adobe Photoshop ${version}` : 'Adobe Photoshop';
          if (await launchApp(`${drive}\\Program Files\\Adobe\\${dir}\\Photoshop.exe`, winPath)) return;
          if (await launchApp(`${drive}\\Program Files (x86)\\Adobe\\${dir}\\Photoshop.exe`, winPath)) return;
        }
      }
      throw new Error('未找到 Photoshop。请在设置中手动配置 Photoshop 安装路径，或确认已安装 Adobe Photoshop');
    }

    if (platform.includes('mac')) {
      if (customPath?.trim()) {
        if (await launchApp(customPath, filePath)) return;
        throw new Error(`配置的 Photoshop 路径无效: ${customPath}`);
      }

      for (const appName of [
        'Adobe Photoshop 2025',
        'Adobe Photoshop 2024',
        'Adobe Photoshop 2023',
        'Adobe Photoshop',
      ]) {
        if (await launchApp(appName, filePath)) return;
      }
      throw new Error('未找到 Photoshop。请在设置中手动配置 Photoshop 安装路径，或确认已安装 Adobe Photoshop');
    }

    throw new Error('不支持的操作系统');
  } catch (error) {
    console.error('[fileService] openInPhotoshop 失败:', filePath, error);
    throw error;
  }
}

function buildConfiguredExecutablePaths(customPath: string, executableNames: string[]): string[] {
  const resolved = customPath.trim().replace(/\/+$/, '').replace(/\\+$/, '');
  if (/\.exe$/i.test(resolved)) return [resolved];
  return [resolved, ...executableNames.map((name) => `${resolved}\\${name}`)];
}

async function buildVideoEditorWindowsPaths(editor: VideoEditorId): Promise<string[]> {
  const drives = ['C:', 'D:', 'E:', 'F:', 'G:'];

  if (editor === 'jianying') {
    const paths: string[] = [];
    try {
      const localDir = await localDataDir();
      paths.push(
        joinPath(localDir, 'JianyingPro', 'Apps', 'JianyingPro.exe'),
        joinPath(localDir, 'JianyingPro', 'JianyingPro.exe'),
      );
    } catch {
      // 系统目录不可用时继续检查常见安装盘。
    }
    for (const drive of drives) {
      paths.push(
        `${drive}\\Program Files\\JianyingPro\\JianyingPro.exe`,
        `${drive}\\Program Files\\ByteDance\\JianyingPro\\JianyingPro.exe`,
        `${drive}\\Program Files (x86)\\JianyingPro\\JianyingPro.exe`,
      );
    }
    return paths;
  }

  const versions = ['2026', '2025', '2024', '2023', '2022', '2021', '2020', ''];
  const paths: string[] = [];
  for (const drive of drives) {
    for (const version of versions) {
      const dir = version ? `Adobe Premiere Pro ${version}` : 'Adobe Premiere Pro';
      paths.push(
        `${drive}\\Program Files\\Adobe\\${dir}\\Adobe Premiere Pro.exe`,
        `${drive}\\Program Files (x86)\\Adobe\\${dir}\\Adobe Premiere Pro.exe`,
      );
    }
  }
  return paths;
}

async function openInVideoEditor(
  filePath: string,
  editor: VideoEditorId,
  customPath?: string,
): Promise<void> {
  const definition = VIDEO_EDITOR_DEFINITIONS[editor];
  if (!isTauriEnv()) {
    console.warn(`[fileService] openInVideoEditor(${editor}): 仅 Tauri 桌面环境支持`);
    return;
  }

  try {
    const platform = (navigator.platform || '').toLowerCase();
    if (platform.includes('win')) {
      const winPath = filePath.replace(/\//g, '\\');
      if (customPath?.trim()) {
        for (const appPath of buildConfiguredExecutablePaths(customPath, definition.executableNames)) {
          if (await launchApp(appPath, winPath)) return;
        }
        throw new Error(`配置的 ${definition.displayName} 路径无效: ${customPath}`);
      }

      for (const appPath of await buildVideoEditorWindowsPaths(editor)) {
        if (await launchApp(appPath, winPath)) return;
      }
      throw new Error(`未找到 ${definition.displayName}。请在设置中手动配置安装路径，或确认已安装该应用`);
    }

    if (platform.includes('mac')) {
      if (customPath?.trim()) {
        if (await launchApp(customPath, filePath)) return;
        throw new Error(`配置的 ${definition.displayName} 路径无效: ${customPath}`);
      }

      for (const appName of definition.macAppNames) {
        if (await launchApp(appName, filePath)) return;
      }
      throw new Error(`未找到 ${definition.displayName}。请在设置中手动配置安装路径，或确认已安装该应用`);
    }

    throw new Error('不支持的操作系统');
  } catch (error) {
    console.error(`[fileService] openInVideoEditor(${editor}) 失败:`, filePath, error);
    throw error;
  }
}

/** 在剪映专业版中打开视频文件。 */
export async function openInJianying(filePath: string, customPath?: string): Promise<void> {
  return openInVideoEditor(filePath, 'jianying', customPath);
}

/** 在 Adobe Premiere Pro 中打开视频文件。 */
export async function openInPremiere(filePath: string, customPath?: string): Promise<void> {
  return openInVideoEditor(filePath, 'premiere', customPath);
}
