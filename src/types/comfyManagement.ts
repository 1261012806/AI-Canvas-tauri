import type { AppearanceTheme } from './index';

export interface ComfyManagementUiContext {
  appearance: AppearanceTheme | null;
  language: string | null;
  nativeCursor: boolean;
}

export interface ComfyRepository {
  id: string;
  name: string;
  enabled: boolean;
  removed: boolean;
  isGit: boolean;
  remoteUrl: string | null;
  branch: string | null;
  commit: string | null;
  commitDate: string | null;
  dirty: boolean;
}

export interface ComfyVersion {
  reference: string;
  commit: string;
  title: string;
  date: string;
  kind: 'tag' | 'commit' | 'branch';
  current: boolean;
}

export interface ComfyCatalogEntry {
  id: string;
  name: string;
  description: string;
  repositoryUrl: string;
  installed: boolean;
}

export interface ComfyManagementSnapshot {
  installationName: string;
  gitAvailable: boolean;
  core: ComfyRepository | null;
  extensions: ComfyRepository[];
  warnings: string[];
  uiContext: ComfyManagementUiContext;
}

export interface ComfyRepositoryAction {
  repositoryId: string;
  action: 'update' | 'switch' | 'enable' | 'disable' | 'uninstall' | 'restore';
  reference?: string;
}

export interface ComfyManagementResult {
  message: string;
}

export interface ComfyDownloadProgress {
  stage: 'connecting' | 'receiving' | 'resolving' | 'counting' | 'compressing' | 'catalog' | 'applying';
  completed: number;
  total?: number | null;
  unit: 'objects' | 'bytes';
}

export type ComfyDependencyStage = 'waiting' | 'confirming' | 'checking' | 'resolving' | 'downloading'
  | 'building' | 'installing' | 'completed' | 'cancelled' | 'failed';

export type ComfyDependencyFailureKind = 'network' | 'dependencyConflict' | 'diskSpace' | 'permission'
  | 'build' | 'environment' | 'timeout' | 'cancelled' | 'unknown';

/** 仅用于当前管理会话展示，不持久化原始 pip 输出或本地路径。 */
export interface ComfyDependencyProgress {
  requestId: string;
  stage: ComfyDependencyStage;
  packageName?: string | null;
  failureKind?: ComfyDependencyFailureKind | null;
}
