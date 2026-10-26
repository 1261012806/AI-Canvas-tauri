/** 项目资产共享连接。P0 只保存连接与项目绑定，不代表资产已同步。 */
export interface SharedStorageConnectionInput {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix: string;
  pathStyle: boolean;
}

export interface SharedStorageConnection extends SharedStorageConnectionInput {
  revision: string;
  credentialsSaved: boolean;
  sessionTokenSaved: boolean;
}

/** 只用于当次 IPC，不进入 Store、配置、日志或 IndexedDB。未提供的字段保留。 */
export interface SharedStorageCredentialUpdate {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  clearSessionToken?: boolean;
  clearCredentials?: boolean;
}

export interface SaveSharedStorageConnectionInput {
  connection: SharedStorageConnectionInput;
  expectedRevision?: string;
  credentials?: SharedStorageCredentialUpdate;
}

export type SharedStorageCheckKind = 'list' | 'readWrite' | 'multipart' | 'conditionalCreate' | 'conditionalUpdate';
export interface SharedStorageCapabilityCheck {
  kind: SharedStorageCheckKind;
  status: 'passed' | 'failed' | 'notChecked';
  code?: string;
}

export interface SharedStorageCapabilityReport {
  checks: SharedStorageCapabilityCheck[];
  checkedAt: number;
  cleanupPending: boolean;
  multiplayerWritable: boolean;
}

export interface SharedProjectBinding {
  ownerId: string;
  ownerName: string;
  connectionId: string;
  connectionRevision: string;
  libraryId: string;
  sharedProjectId: string;
  projectPrefix: string;
  capabilities: SharedStorageCapabilityReport;
  updatedAt: number;
}

export interface SharedAssetStorageSnapshot {
  connections: SharedStorageConnection[];
  bindings: SharedProjectBinding[];
  /** 单调递增的原生 catalog 版本，防止迟到快照覆盖新状态。 */
  revision: number;
}

export interface BindSharedProjectInput {
  taskId: string;
  ownerId: string;
  ownerName: string;
  connectionId: string;
  connectionRevision: string;
  mode: 'create' | 'join';
  libraryId: string;
  sharedProjectId: string;
}

export interface SharedProjectOperationResult {
  snapshot: SharedAssetStorageSnapshot;
  report: SharedStorageCapabilityReport;
  bound: boolean;
}

export interface ProbeSharedProjectInput {
  taskId: string;
  ownerId: string;
}
