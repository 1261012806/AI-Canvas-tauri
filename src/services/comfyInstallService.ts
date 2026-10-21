import { Channel, invoke } from '@tauri-apps/api/core';
import portableRelease from '../../src-tauri/resources/comfyui-portable.json';
import type { ComfyInstallInfo, ComfyInstallProgress, ComfyInstallResult, ComfyInstallTarget } from '../types/comfyInstall';

/** 表单与 Rust 复用同一发布清单；平台判断仅用于展示，不能代替原生安装校验。 */
export function getBundledComfyInstallInfo(): ComfyInstallInfo {
  return { ...portableRelease, supported: typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent) };
}

/** 只等待宿主已有的接口，不注入桥接、不降级权限，也不重试已经发出的原生命令。 */
async function waitForInstallBridge(signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt <= 30; attempt += 1) {
    signal?.throwIfAborted();
    const bridge = typeof window === 'undefined' ? undefined
      : (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
    if (typeof bridge?.invoke === 'function') return;
    if (attempt < 30) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('桌面安装接口未就绪，请完全退出并重新打开 AI Canvas 后重试。若仍失败，请反馈客户端版本，以及“更换”安装目录能否正常打开。');
}

export async function getComfyInstallInfo(signal?: AbortSignal): Promise<ComfyInstallInfo> {
  await waitForInstallBridge(signal);
  signal?.throwIfAborted();
  return invoke('get_comfyui_install_info');
}

export async function chooseComfyInstallTarget(folderName: string): Promise<ComfyInstallTarget | null> {
  await waitForInstallBridge();
  return invoke('choose_comfyui_install_target', { folderName });
}

export async function cancelComfyInstall(targetId: string | null): Promise<void> {
  await waitForInstallBridge();
  return invoke('cancel_comfyui_install', { targetId });
}

export async function installComfyPortable(targetId: string, variantId: string, onProgress: (progress: ComfyInstallProgress) => void): Promise<ComfyInstallResult> {
  await waitForInstallBridge();
  const channel = new Channel<string>();
  channel.onmessage = (message) => onProgress(JSON.parse(message) as ComfyInstallProgress);
  try { return await invoke('install_comfyui_portable', { targetId, variantId, onProgress: channel }); }
  finally { channel.onmessage = () => {}; }
}
