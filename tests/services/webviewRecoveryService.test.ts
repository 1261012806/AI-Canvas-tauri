import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), lastProject: vi.fn(), confirm: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: mocks.getState } }));
vi.mock('../../src/services/indexedDbService', () => ({ getLastActiveProjectId: mocks.lastProject }));
vi.mock('../../src/services/confirmDialog', () => ({ confirmAction: mocks.confirm }));
vi.mock('../../src/i18n', () => ({ t: (message: string) => message }));

let state: {
  currentProjectId: string | null;
  projects: Array<{ id: string }>;
  projectLoadStatus: string;
  switchingProjectName: string | null;
  isCreatingProject: boolean;
  isReturningToStartPage: boolean;
  switchProject: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state = { currentProjectId: null, projects: [{ id: 'last-project' }], projectLoadStatus: 'ready',
    switchingProjectName: null, isCreatingProject: false, isReturningToStartPage: false,
    switchProject: vi.fn(async () => undefined), showToast: vi.fn() };
  mocks.getState.mockImplementation(() => state);
  mocks.lastProject.mockResolvedValue('last-project');
  mocks.confirm.mockResolvedValue(true);
  mocks.invoke.mockReset().mockResolvedValue(false);
  const location = { href: 'tauri://localhost/index.html?__canvas_webview_recovery=1' };
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, location, history: { state: null,
    replaceState: vi.fn((_state: unknown, _title: string, url: URL) => { location.href = url.toString(); }),
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe('WebContent recovery', () => {
  it('prompts once after a termination and restores only through the existing project action', async () => {
    const { isWebviewRecovery, restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    expect(await isWebviewRecovery()).toBe(true);
    const first = restoreAfterWebviewTermination();
    expect(restoreAfterWebviewTermination()).toBe(first);
    await first;
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(state.switchProject).toHaveBeenCalledExactlyOnceWith('last-project');
    expect(window.location.href).not.toContain('__canvas_webview_recovery');
    // StrictMode 的另一轮初始化仍识别本次异常启动，不能提前自动打开重项目。
    expect(await isWebviewRecovery()).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('consume_webview_recovery');
  });

  it('recovers from the native marker when fallback reload has no URL marker', async () => {
    window.location.href = 'tauri://localhost/index.html';
    mocks.invoke.mockResolvedValue(true);
    const { isWebviewRecovery, restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    expect(await isWebviewRecovery()).toBe(true);
    await restoreAfterWebviewTermination();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(state.switchProject).toHaveBeenCalledExactlyOnceWith('last-project');
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('consume_webview_recovery');
  });

  it('shares pending native detection between startup and the recovery prompt', async () => {
    window.location.href = 'tauri://localhost/index.html';
    let resolve!: (pending: boolean) => void;
    mocks.invoke.mockImplementation(() => new Promise<boolean>((complete) => { resolve = complete; }));
    const { isWebviewRecovery, restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    const detection = isWebviewRecovery();
    expect(isWebviewRecovery()).toBe(detection);
    const recovery = restoreAfterWebviewTermination();
    expect(mocks.lastProject).not.toHaveBeenCalled();
    resolve(true);
    await recovery;
    expect(await detection).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.confirm).toHaveBeenCalledOnce();
  });

  it('consumes native recovery even when the URL already marks the same termination', async () => {
    mocks.invoke.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { isWebviewRecovery, restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    await restoreAfterWebviewTermination();
    expect(await isWebviewRecovery()).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('consume_webview_recovery');
    expect(mocks.confirm).toHaveBeenCalledOnce();
  });

  it('keeps the URL fallback when an older native host does not expose the command', async () => {
    mocks.invoke.mockRejectedValue(new Error('private native failure details'));
    const { restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    await expect(restoreAfterWebviewTermination()).resolves.toBeUndefined();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(state.showToast).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'project-changed'])('keeps the current view when recovery is %s', async (scenario) => {
    mocks.confirm.mockImplementation(async () => {
      if (scenario === 'project-changed') state.currentProjectId = 'another-project';
      return scenario !== 'cancel';
    });
    const { restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    await restoreAfterWebviewTermination();
    expect(state.switchProject).not.toHaveBeenCalled();
  });

  it('does not change an ordinary startup', async () => {
    window.location.href = 'tauri://localhost/index.html';
    const { restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    await restoreAfterWebviewTermination();
    expect(mocks.lastProject).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(state.switchProject).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('consume_webview_recovery');
  });

  it('does not treat native detection failure as a termination', async () => {
    window.location.href = 'tauri://localhost/index.html';
    mocks.invoke.mockRejectedValue(new Error('private native failure details'));
    const { restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    await expect(restoreAfterWebviewTermination()).resolves.toBeUndefined();
    expect(mocks.lastProject).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(state.showToast).not.toHaveBeenCalled();
  });

  it('rejects non-boolean native status without opening a project', async () => {
    window.location.href = 'tauri://localhost/index.html';
    mocks.invoke.mockResolvedValue('true');
    const { isWebviewRecovery, restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    expect(await isWebviewRecovery()).toBe(false);
    await restoreAfterWebviewTermination();
    expect(state.switchProject).not.toHaveBeenCalled();
  });

  it('does not call native recovery from an ordinary browser', async () => {
    vi.stubGlobal('window', { location: { href: 'http://localhost/index.html?__canvas_webview_recovery=1' } });
    const { isWebviewRecovery, restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    expect(await isWebviewRecovery()).toBe(false);
    await restoreAfterWebviewTermination();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('keeps the library usable when the remembered project is gone', async () => {
    state.projects = [];
    const { restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    await restoreAfterWebviewTermination();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(state.showToast).toHaveBeenCalled();
  });
});
