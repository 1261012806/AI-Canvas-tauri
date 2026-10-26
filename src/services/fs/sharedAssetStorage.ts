/** 固定项目云存储 IPC；不提供任意 URL、Header 或对象路径读写。 */
import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from './core';
import type {
  BindSharedProjectInput, ProbeSharedProjectInput, SaveSharedStorageConnectionInput,
  SharedAssetStorageSnapshot, SharedProjectBinding, SharedProjectOperationResult,
  SharedStorageCapabilityCheck, SharedStorageCapabilityReport, SharedStorageCheckKind, SharedStorageConnectionInput,
} from '../../types/assetSync';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CHECK_KINDS: readonly SharedStorageCheckKind[] = ['list', 'readWrite', 'multipart', 'conditionalCreate', 'conditionalUpdate'];
const ERROR_MESSAGES: Record<string, string> = {
  permission_denied: '项目云存储仅允许在主窗口操作',
  access_denied: '云存储访问被拒绝，请检查 Bucket 和项目目录权限',
  authentication_failed: '云存储认证失败，请检查访问凭据和临时令牌是否过期',
  invalid_input: '云存储参数无效，请检查连接信息和共享项目 ID',
  unavailable: '云存储本地配置暂不可用，请稍后重试',
  conflict: '连接或项目绑定已改变，请刷新后重试',
  connection_not_found: '云存储连接已不存在，请重新选择',
  credentials_missing: '请先保存云存储访问凭据',
  connection_in_use: '该连接仍有项目绑定，请先解除本机绑定',
  binding_not_found: '该项目尚未绑定共享项目',
  cancelled: '云存储操作已取消',
  busy: '该项目正在处理云存储操作，请稍后重试',
  network: '云存储请求失败，请检查网络、证书和访问权限',
  project_not_found: '未找到共享项目，请检查共享项目 ID 和连接位置',
  project_mismatch: '远端项目描述与共享项目 ID 不一致，已停止绑定',
  conditional_write_unsupported: '目标存储未通过条件写校验，不能开启多人写入',
  cleanup_pending: '探测已结束，部分测试对象未清理，请检查存储权限',
  response_too_large: '远端项目响应超过允许大小，已停止读取',
};

export function sharedStorageErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? '云存储操作未完成，请刷新状态后重试';
}

function validateId(value: string): string {
  if (!ID_PATTERN.test(value)) throw new Error(ERROR_MESSAGES.invalid_input);
  return value;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
}

export function parseSharedProjectCode(code: string): { libraryId: string; sharedProjectId: string } {
  const parts = code.trim().split('/');
  if (parts.length !== 2) throw new Error(ERROR_MESSAGES.invalid_input);
  return { libraryId: validateId(parts[0]), sharedProjectId: validateId(parts[1]) };
}

function normalizePrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, '');
  if (prefix.length > 256 || /[\\%?#]/.test(prefix) || hasControlCharacters(prefix)
    || prefix.split('/').some((part) => part === '.' || part === '..' || (!part && prefix !== ''))) {
    throw new Error(ERROR_MESSAGES.invalid_input);
  }
  return prefix;
}

export function getSharedProjectPrefix(connection: Pick<SharedStorageConnectionInput, 'rootPrefix'>, libraryId: string, sharedProjectId: string): string {
  const prefix = normalizePrefix(connection.rootPrefix);
  return `${prefix ? `${prefix}/` : ''}libraries/${validateId(libraryId)}/projects/${validateId(sharedProjectId)}`;
}

export function normalizeSharedStorageConnection(input: SharedStorageConnectionInput): SharedStorageConnectionInput {
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint.trim()); } catch { throw new Error(ERROR_MESSAGES.invalid_input); }
  const name = input.name.trim();
  const region = input.region.trim();
  const bucket = input.bucket.trim();
  if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || input.endpoint.length > 2048
    || input.id.length > 100 || !name || Array.from(name).length > 160 || hasControlCharacters(name)
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(region)
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')
    || typeof input.pathStyle !== 'boolean') throw new Error(ERROR_MESSAGES.invalid_input);
  return { id: validateId(input.id), name, endpoint: endpoint.origin, region, bucket, rootPrefix: normalizePrefix(input.rootPrefix), pathStyle: input.pathStyle };
}

function publicReport(report: SharedStorageCapabilityReport): SharedStorageCapabilityReport {
  const checks = CHECK_KINDS.map<SharedStorageCapabilityCheck>((kind) => {
    const matches = report.checks.filter((check) => check.kind === kind);
    const check = matches.length === 1 ? matches[0] : undefined;
    const status = check && ['passed', 'failed', 'notChecked'].includes(check.status) ? check.status : 'notChecked';
    return { kind, status, ...(check?.code ? { code: Object.hasOwn(ERROR_MESSAGES, check.code) ? check.code : 'unknown' } : {}) };
  });
  return {
    checks, checkedAt: report.checkedAt, cleanupPending: report.cleanupPending,
    multiplayerWritable: report.multiplayerWritable && checks.every((check) => check.status === 'passed'),
  };
}

/** 只投影公开字段；即使以后 IPC 加字段，也不会将凭据塞入共享 Store。 */
function publicSnapshot(snapshot: SharedAssetStorageSnapshot): SharedAssetStorageSnapshot {
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error(ERROR_MESSAGES.unavailable);
  return {
    revision: snapshot.revision,
    connections: snapshot.connections.map((item) => ({
      ...normalizeSharedStorageConnection(item), revision: item.revision,
      credentialsSaved: item.credentialsSaved, sessionTokenSaved: item.sessionTokenSaved,
    })),
    bindings: snapshot.bindings.map((item) => ({
      ownerId: item.ownerId, ownerName: item.ownerName, connectionId: item.connectionId,
      connectionRevision: item.connectionRevision, libraryId: item.libraryId, sharedProjectId: item.sharedProjectId,
      projectPrefix: item.projectPrefix, capabilities: publicReport(item.capabilities), updatedAt: item.updatedAt,
    })),
  };
}

function sanitizedStorageFailure(value: unknown): Error {
  // 不保留原始异常作为 cause；它可能包含签名请求、凭据或响应正文。
  const rawCode = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' ? value.code : 'unknown';
  const code = Object.hasOwn(ERROR_MESSAGES, rawCode) ? rawCode : 'unknown';
  return new Error(sharedStorageErrorMessage(code), { cause: { code } });
}

async function nativeCall<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriEnv()) throw new Error('项目云存储需要在 Tauri 桌面端使用');
  try { return await invoke<T>(command, args); } catch (error: unknown) {
    throw sanitizedStorageFailure(error);
  }
}

export async function loadSharedStorageSnapshot(): Promise<SharedAssetStorageSnapshot> {
  return publicSnapshot(await nativeCall<SharedAssetStorageSnapshot>('project_asset_storage_snapshot'));
}

export async function saveSharedStorageConnection(input: SaveSharedStorageConnectionInput): Promise<SharedAssetStorageSnapshot> {
  const connection = normalizeSharedStorageConnection(input.connection);
  const credentials = input.credentials;
  if (credentials) {
    const hasKey = credentials.accessKeyId !== undefined;
    const hasSecret = credentials.secretAccessKey !== undefined;
    if (hasKey !== hasSecret || (hasKey && (!credentials.accessKeyId?.trim() || !credentials.secretAccessKey?.trim()))
      || (credentials.clearSessionToken && credentials.sessionToken !== undefined)
      || (credentials.clearCredentials && (hasKey || hasSecret || credentials.sessionToken !== undefined || credentials.clearSessionToken))) {
      throw new Error(ERROR_MESSAGES.invalid_input);
    }
  }
  return publicSnapshot(await nativeCall<SharedAssetStorageSnapshot>('project_asset_storage_save_connection', {
    input: { connection, expectedRevision: input.expectedRevision, credentials },
  }));
}

export async function removeSharedStorageConnection(connectionId: string, expectedRevision: string): Promise<SharedAssetStorageSnapshot> {
  return publicSnapshot(await nativeCall<SharedAssetStorageSnapshot>('project_asset_storage_remove_connection', { connectionId: validateId(connectionId), expectedRevision }));
}

function publicOperation(result: SharedProjectOperationResult): SharedProjectOperationResult {
  return { snapshot: publicSnapshot(result.snapshot), report: publicReport(result.report), bound: result.bound };
}

export async function bindSharedStorageProject(input: BindSharedProjectInput): Promise<SharedProjectOperationResult> {
  [input.taskId, input.ownerId, input.connectionId, input.libraryId, input.sharedProjectId].forEach(validateId);
  if (!['create', 'join'].includes(input.mode)) throw new Error(ERROR_MESSAGES.invalid_input);
  return publicOperation(await nativeCall<SharedProjectOperationResult>('project_asset_storage_bind_project', { input }));
}

export async function probeSharedStorageProject(input: ProbeSharedProjectInput): Promise<SharedProjectOperationResult> {
  validateId(input.taskId); validateId(input.ownerId);
  return publicOperation(await nativeCall<SharedProjectOperationResult>('project_asset_storage_probe_project', { input }));
}

export async function unbindSharedStorageProject(binding: Pick<SharedProjectBinding, 'ownerId' | 'connectionRevision' | 'libraryId' | 'sharedProjectId'>): Promise<SharedAssetStorageSnapshot> {
  return publicSnapshot(await nativeCall<SharedAssetStorageSnapshot>('project_asset_storage_unbind_project', { ...binding }));
}

export async function cancelSharedStorageTask(taskId: string): Promise<void> {
  await nativeCall('project_asset_storage_cancel', { taskId: validateId(taskId) });
}
