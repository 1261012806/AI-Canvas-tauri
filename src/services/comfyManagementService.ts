import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  ComfyCatalogEntry,
  ComfyDownloadProgress,
  ComfyDependencyProgress,
  ComfyManagementResult,
  ComfyManagementSnapshot,
  ComfyManagementUiContext,
  ComfyRepositoryAction,
  ComfyVersion,
} from '../types/comfyManagement';

async function invokeWithProgress<T>(
  command: string,
  args: Record<string, unknown>,
  onProgress?: (progress: ComfyDownloadProgress) => void,
): Promise<T> {
  // 字符串 Channel 直接回包，管理窗口无需开放通用 Channel 取数权限。
  const channel = new Channel<string>();
  channel.onmessage = (message) => onProgress?.(JSON.parse(message) as ComfyDownloadProgress);
  try {
    return await invoke<T>(command, { ...args, onProgress: channel });
  } finally {
    channel.onmessage = () => {};
  }
}

/** 目录选择、校验与持久授权均由原生层完成；取消保持原选择。 */
export const selectComfyInstallation = (): Promise<string | null> =>
  invoke('select_comfyui_installation');

/** 只恢复原生已保存的选择，不根据前端配置字符串扩大目录权限。 */
export const getComfyInstallation = (): Promise<string | null> =>
  invoke('get_comfyui_installation');

export const openComfyManagementWindow = (comfyPath: string, uiContext: ComfyManagementUiContext): Promise<void> =>
  invoke('open_comfyui_settings_window', { comfyPath, uiContext });

export const getComfyManagementSnapshot = (refresh = false): Promise<ComfyManagementSnapshot> =>
  invoke('get_comfyui_management_snapshot', { refresh });

export const listComfyVersions = (repositoryId: string, refresh = false, onProgress?: (progress: ComfyDownloadProgress) => void): Promise<ComfyVersion[]> =>
  invokeWithProgress('list_comfyui_versions', { repositoryId, refresh }, onProgress);

export const applyComfyRepositoryAction = (request: ComfyRepositoryAction, onProgress?: (progress: ComfyDownloadProgress) => void): Promise<ComfyManagementResult> =>
  invokeWithProgress('apply_comfyui_repository_action', { request }, onProgress);

export const listComfyCatalog = (onProgress?: (progress: ComfyDownloadProgress) => void): Promise<ComfyCatalogEntry[]> =>
  invokeWithProgress('list_comfyui_catalog', {}, onProgress);

export const installComfyExtension = (repositoryUrl: string, onProgress?: (progress: ComfyDownloadProgress) => void): Promise<ComfyManagementResult> =>
  invokeWithProgress('install_comfyui_extension', { repositoryUrl }, onProgress);

const DEPENDENCY_STAGES = new Set<ComfyDependencyProgress['stage']>([
  'waiting', 'confirming', 'checking', 'resolving', 'downloading', 'building', 'installing',
  'completed', 'cancelled', 'failed',
]);
const DEPENDENCY_FAILURES = new Set<NonNullable<ComfyDependencyProgress['failureKind']>>([
  'network', 'dependencyConflict', 'diskSpace', 'permission', 'build', 'environment', 'timeout', 'cancelled', 'unknown',
]);

function dependencyProgress(message: string, requestId: string): ComfyDependencyProgress | null {
  try {
    const value = JSON.parse(message) as Partial<ComfyDependencyProgress> | null;
    if (!value || value.requestId !== requestId || !value.stage || !DEPENDENCY_STAGES.has(value.stage)) return null;
    if (value.packageName != null && (typeof value.packageName !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.packageName))) return null;
    if (value.failureKind != null && !DEPENDENCY_FAILURES.has(value.failureKind)) return null;
    return { requestId, stage: value.stage, packageName: value.packageName, failureKind: value.failureKind };
  } catch {
    return null;
  }
}

export class ComfyDependencyInstallCancelledError extends Error {
  constructor() {
    super('已取消依赖安装；已安装的软件包不会自动回滚。');
    this.name = 'ComfyDependencyInstallCancelledError';
  }
}

export async function installComfyDependencies(repositoryId: string, options?: {
  requestId: string;
  onProgress?: (progress: ComfyDependencyProgress) => void;
}): Promise<ComfyManagementResult> {
  const requestId = options?.requestId ?? `comfy-deps-${crypto.randomUUID()}`;
  const channel = new Channel<string>();
  let cancelled = false;
  channel.onmessage = (message) => {
    const progress = dependencyProgress(message, requestId);
    if (!progress) return;
    if (progress.stage === 'cancelled') cancelled = true;
    options?.onProgress?.(progress);
  };
  try {
    return await invoke<ComfyManagementResult>('install_comfyui_dependencies', { repositoryId, requestId, onProgress: channel });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (cancelled || message === '已取消依赖安装') throw new ComfyDependencyInstallCancelledError();
    throw cause;
  } finally {
    channel.onmessage = () => {};
  }
}

export const cancelComfyDependencies = (requestId: string): Promise<void> =>
  invoke('cancel_comfyui_dependencies', { requestId });
