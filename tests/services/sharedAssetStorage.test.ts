import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedAssetStorageSnapshot, SharedStorageConnectionInput } from '../../src/types/assetSync';

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauriEnv: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: native.isTauriEnv }));

import {
  bindSharedStorageProject, getSharedProjectPrefix, loadSharedStorageSnapshot,
  normalizeSharedStorageConnection, parseSharedProjectCode, saveSharedStorageConnection,
} from '../../src/services/fs/sharedAssetStorage';

const connection: SharedStorageConnectionInput = {
  id: 'connection-a', name: '团队存储', endpoint: 'https://storage.example.com', region: 'region-1',
  bucket: 'project-assets', rootPrefix: 'team', pathStyle: true,
};
const snapshot = (): SharedAssetStorageSnapshot => ({
  revision: 1, connections: [{ ...connection, revision: 'revision-1', credentialsSaved: true, sessionTokenSaved: false }], bindings: [],
});

beforeEach(() => { native.invoke.mockReset(); native.isTauriEnv.mockReturnValue(true); });

describe('项目 S3 连接边界', () => {
  it('只接受无认证信息、查询、片段及额外路径的 HTTPS Endpoint', () => {
    expect(normalizeSharedStorageConnection({ ...connection, endpoint: ' https://storage.example.com/ ' }).endpoint).toBe(connection.endpoint);
    expect(normalizeSharedStorageConnection({ ...connection, name: '汉'.repeat(70) }).name).toHaveLength(70);
    for (const endpoint of [
      'http://localhost:9000', 'file:///tmp/data', 'https://user:password@storage.example.com',
      'https://storage.example.com/api', 'https://storage.example.com?token=hidden', 'https://storage.example.com#secret',
    ]) expect(() => normalizeSharedStorageConnection({ ...connection, endpoint })).toThrow();
  });

  it('共享身份独立于名称，前缀不能越界或接受编码后的路径分隔符', () => {
    expect(parseSharedProjectCode(' library-a/project-b ')).toEqual({ libraryId: 'library-a', sharedProjectId: 'project-b' });
    expect(getSharedProjectPrefix(connection, 'library-a', 'project-b')).toBe('team/libraries/library-a/projects/project-b');
    for (const code of ['same-name', '../project-b', 'library-a/project-b/extra', 'library-a/%2fother']) {
      expect(() => parseSharedProjectCode(code)).toThrow();
    }
    for (const rootPrefix of ['team/../other', 'team//other', 'team\\other', 'team/%2e%2e', 'team?key=x']) {
      expect(() => getSharedProjectPrefix({ rootPrefix }, 'library-a', 'project-b')).toThrow();
    }
  });

  it('凭据必须成对更新，保留、清除和替换不混用，错误时不发送 IPC', async () => {
    await expect(saveSharedStorageConnection({ connection, credentials: { accessKeyId: 'new-key' } })).rejects.toThrow();
    await expect(saveSharedStorageConnection({ connection, credentials: { clearCredentials: true, secretAccessKey: 'secret' } })).rejects.toThrow();
    await expect(saveSharedStorageConnection({ connection, credentials: { sessionToken: 'token', clearSessionToken: true } })).rejects.toThrow();
    expect(native.invoke).not.toHaveBeenCalled();
    native.invoke.mockResolvedValue(snapshot());
    await saveSharedStorageConnection({ connection, expectedRevision: 'revision-1' });
    expect(native.invoke).toHaveBeenLastCalledWith('project_asset_storage_save_connection', {
      input: { connection, expectedRevision: 'revision-1', credentials: undefined },
    });
  });

  it('只返回公开字段，IPC 意外附带的凭据不会进入共享状态', async () => {
    const value = snapshot();
    native.invoke.mockResolvedValue({ ...value, secretAccessKey: 'do-not-store', connections: [
      { ...value.connections[0], credentials: { accessKeyId: 'private-key', secretAccessKey: 'do-not-store' } },
    ] });
    const result = await loadSharedStorageSnapshot();
    expect(result).toEqual(value);
    expect(JSON.stringify(result)).not.toContain('do-not-store');
    expect(JSON.stringify(result)).not.toContain('private-key');
  });

  it('能力报告缺少条件更新证明时不能投影为可多人写入', async () => {
    native.invoke.mockResolvedValue({ snapshot: snapshot(), bound: false, report: {
      checks: [{ kind: 'readWrite', status: 'passed' }], checkedAt: 1, cleanupPending: false, multiplayerWritable: true,
    } });
    const result = await bindSharedStorageProject({
      taskId: 'task-a', ownerId: 'owner-a', ownerName: '项目', connectionId: connection.id,
      connectionRevision: 'revision-1', mode: 'create', libraryId: 'library-a', sharedProjectId: 'project-a',
    });
    expect(result.report.multiplayerWritable).toBe(false);
    expect(result.report.checks.find((check) => check.kind === 'conditionalUpdate')?.status).toBe('notChecked');
  });

  it('不向界面转发带签名或响应正文的原始异常；Web 环境不尝试连接', async () => {
    native.invoke.mockRejectedValue({ code: 'network', message: 'Authorization=secret-signature' });
    await expect(loadSharedStorageSnapshot()).rejects.toThrow('检查网络');
    await expect(loadSharedStorageSnapshot()).rejects.toMatchObject({ cause: { code: 'network' } });
    native.invoke.mockRejectedValue({ code: 'Authorization=secret-signature' });
    await expect(loadSharedStorageSnapshot()).rejects.toMatchObject({ cause: { code: 'unknown' } });
    native.invoke.mockRejectedValue('Authorization=secret-signature');
    await expect(loadSharedStorageSnapshot()).rejects.toThrow('未完成');
    native.invoke.mockClear(); native.isTauriEnv.mockReturnValue(false);
    await expect(loadSharedStorageSnapshot()).rejects.toThrow('桌面端');
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
