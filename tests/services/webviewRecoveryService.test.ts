import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), lastProject: vi.fn(), confirm: vi.fn() }));
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
  const location = { href: 'tauri://localhost/index.html?__canvas_webview_recovery=1' };
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, location, history: { state: null,
    replaceState: vi.fn((_state: unknown, _title: string, url: URL) => { location.href = url.toString(); }),
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe('WebContent recovery', () => {
  it('prompts once after a termination and restores only through the existing project action', async () => {
    const { isWebviewRecovery, restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    expect(isWebviewRecovery()).toBe(true);
    const first = restoreAfterWebviewTermination();
    expect(restoreAfterWebviewTermination()).toBe(first);
    await first;
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(state.switchProject).toHaveBeenCalledExactlyOnceWith('last-project');
    expect(window.location.href).not.toContain('__canvas_webview_recovery');
    // StrictMode 的另一轮初始化仍识别本次异常启动，不能提前自动打开重项目。
    expect(isWebviewRecovery()).toBe(true);
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
  });

  it('keeps the library usable when the remembered project is gone', async () => {
    state.projects = [];
    const { restoreAfterWebviewTermination } = await import('../../src/services/webviewRecoveryService');
    await restoreAfterWebviewTermination();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(state.showToast).toHaveBeenCalled();
  });
});
