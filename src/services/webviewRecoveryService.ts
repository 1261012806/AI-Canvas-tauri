import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/useAppStore';
import { getLastActiveProjectId } from './indexedDbService';
import { confirmAction } from './confirmDialog';
import { t } from '../i18n';

const RECOVERY_PARAM = '__canvas_webview_recovery';
let pendingRecovery: Promise<void> | undefined;
let recoveryDetected: Promise<boolean> | undefined;

export function isWebviewRecovery(): Promise<boolean> {
  recoveryDetected ??= (async () => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)
      || typeof window.location?.href !== 'string') return false;
    const urlRecovery = new URL(window.location.href).searchParams.get(RECOVERY_PARAM) === '1';
    let nativeRecovery = false;
    try {
      // URL 已有标记也要消费原生状态，避免下次普通重载再次提示。
      nativeRecovery = await invoke<boolean>('consume_webview_recovery') === true;
    } catch { /* 旧安装包可能没有这条命令，仍沿用 URL 标记；不暴露原生错误正文。 */ }
    return urlRecovery || nativeRecovery;
  })();
  return recoveryDetected;
}

async function recover(): Promise<void> {
  if (!await isWebviewRecovery()) return;
  const url = new URL(window.location.href);
  url.searchParams.delete(RECOVERY_PARAM);
  try { window.history.replaceState(window.history.state, '', url); }
  catch { /* 清理地址标记失败也不影响恢复；当前页面内已有一次性保护。 */ }
  try {
    const projectId = await getLastActiveProjectId();
    const state = useAppStore.getState();
    if (!projectId || !state.projects.some((project) => project.id === projectId)) {
      state.showToast(t('页面异常后已重新加载，请从项目列表继续操作'), 'info');
      return;
    }
    const confirmed = await confirmAction(t('页面异常后已重新加载。是否打开上次项目的最近保存内容？尚未保存的改动可能无法恢复，生成任务不会自动重新提交。'), {
      title: t('页面已恢复'), kind: 'warning', okLabel: t('打开上次项目'), cancelLabel: t('留在项目列表'),
    });
    const live = useAppStore.getState();
    // 等待确认期间可能已主动打开或创建项目，不让迟到的恢复操作覆盖它。
    if (confirmed && live.currentProjectId === null && live.projectLoadStatus === 'ready'
      && !live.switchingProjectName && !live.isCreatingProject && !live.isReturningToStartPage
      && live.projects.some((project) => project.id === projectId)) {
      await live.switchProject(projectId);
    }
  } catch {
    useAppStore.getState().showToast(t('页面已重新加载，请从项目列表手动打开项目'), 'info');
  }
}

/** StrictMode 重放启动 effect 时沿用同一恢复请求，不重复弹窗。 */
export function restoreAfterWebviewTermination(): Promise<void> {
  pendingRecovery ??= recover();
  return pendingRecovery;
}
