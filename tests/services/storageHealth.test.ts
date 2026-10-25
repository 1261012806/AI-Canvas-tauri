import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasProject } from '../../src/types';

const mocks = vi.hoisted(() => ({
  directories: new Map<string, string[]>(),
  sizes: new Map<string, number>(),
  digests: new Map<string, string>(),
  roots: new Map<string, string>(),
  exists: vi.fn(),
  readDir: vi.fn(),
  lstat: vi.fn(),
  stat: vi.fn(),
  remove: vi.fn(),
  fingerprintAssetImage: vi.fn(),
  getAllProjects: vi.fn(),
  getProjectById: vi.fn(),
  getHistoryEntriesPage: vi.fn(),
  getProjectConversations: vi.fn(),
  getConversationMessages: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: mocks.readDir,
  lstat: mocks.lstat,
  stat: mocks.stat,
  remove: mocks.remove,
  exists: mocks.exists,
}));
vi.mock('../../src/services/fs/core', () => ({
  isTauriEnv: () => true,
  joinPath: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
  getProjectDataDir: async (id: string) => mocks.roots.get(id) ?? `/${id}`,
}));
vi.mock('../../src/services/fs/assetImageMetadata', () => ({
  fingerprintAssetImage: mocks.fingerprintAssetImage,
}));
vi.mock('../../src/services/indexedDbService', () => ({
  getAllProjects: mocks.getAllProjects,
  getProjectById: mocks.getProjectById,
  getHistoryEntriesPage: mocks.getHistoryEntriesPage,
  getProjectConversations: mocks.getProjectConversations,
  getConversationMessages: mocks.getConversationMessages,
}));

import { clearTrashDir, scanStorageHealth } from '../../src/services/fs/storageHealth';

function project(id: string): CanvasProject {
  return { id, name: id, createdAt: 1, updatedAt: 1 };
}

function addFiles(root: string, entries: Record<string, number>): void {
  mocks.directories.set(root, Object.keys(entries));
  for (const [name, size] of Object.entries(entries)) mocks.sizes.set(`${root}/${name}`, size);
}

describe('storage health accounting and cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.directories.clear();
    mocks.sizes.clear();
    mocks.digests.clear();
    mocks.roots.clear();
    mocks.exists.mockImplementation(async (path: string) => mocks.directories.has(path) || mocks.sizes.has(path));
    mocks.getAllProjects.mockResolvedValue([]);
    mocks.getProjectById.mockImplementation(async (id: string) => ({ ...project(id), nodes: [] }));
    mocks.getHistoryEntriesPage.mockResolvedValue({ records: [], hasMore: false });
    mocks.getProjectConversations.mockResolvedValue([]);
    mocks.getConversationMessages.mockResolvedValue({ messages: [], total: 0 });
    mocks.readDir.mockImplementation(async (path: string) => {
      const entries = mocks.directories.get(path);
      if (!entries) throw new Error('directory unavailable');
      return entries.map((name) => ({
        name,
        isDirectory: mocks.directories.has(`${path}/${name}`),
        isFile: mocks.sizes.has(`${path}/${name}`),
        isSymlink: false,
      }));
    });
    const fileInfo = async (path: string) => {
      const directory = mocks.directories.has(path);
      if (!directory && !mocks.sizes.has(path)) throw new Error('file unavailable');
      return { isDirectory: directory, isFile: !directory, isSymlink: false,
        size: mocks.sizes.get(path) ?? 0, mtime: new Date(0) };
    };
    mocks.lstat.mockImplementation(fileInfo);
    mocks.stat.mockImplementation(fileInfo);
    mocks.fingerprintAssetImage.mockImplementation(async (path: string) => ({
      digest: mocks.digests.get(path) ?? path,
      bytes: mocks.sizes.get(path) ?? 0,
    }));
    mocks.remove.mockImplementation(async (path: string) => {
      if (mocks.directories.has(path)) {
        const prefix = `${path}/`;
        if ([...mocks.sizes.keys(), ...mocks.directories.keys()].some((entry) => entry.startsWith(prefix))) {
          throw new Error('directory not empty');
        }
        mocks.directories.delete(path);
      } else {
        mocks.sizes.delete(path);
      }
    });
  });

  it('counts a shared project directory once and retains references from either project', async () => {
    mocks.roots.set('a', '/shared');
    mocks.roots.set('b', '/shared');
    addFiles('/shared', { 'used.png': 10, 'unused.png': 20 });
    mocks.getProjectById.mockImplementation(async (id: string) => ({
      ...project(id), nodes: id === 'b' ? [{ data: { filePath: '/shared/used.png' } }] : [],
    }));

    const report = await scanStorageHealth([project('a'), project('b')], new Set());

    expect(report).toMatchObject({ projectSize: 30, trashSize: 0, totalSize: 30, reclaimableSize: 20 });
    expect(report.projects.reduce((sum, entry) => sum + entry.fileSize, 0)).toBe(30);
    expect(report.projects.find((entry) => entry.projectId === 'a')?.sharedWith).toContain('b');
    expect(report.orphans.map((entry) => entry.path)).toEqual(['/shared/unused.png']);
    expect(mocks.readDir.mock.calls.filter(([path]) => path === '/shared')).toHaveLength(1);
  });

  it('includes trash in total usage without counting duplicate orphan files twice', async () => {
    mocks.directories.set('/a', ['one', 'two', '.trash']);
    addFiles('/a/one', { 'same.mp4': 100 });
    addFiles('/a/two', { 'same.mp4': 100 });
    addFiles('/a/.trash', { 'old.bin': 50 });
    mocks.digests.set('/a/one/same.mp4', 'a'.repeat(64));
    mocks.digests.set('/a/two/same.mp4', 'a'.repeat(64));

    const report = await scanStorageHealth([project('a')], new Set());

    expect(report).toMatchObject({ projectSize: 200, trashSize: 50, totalSize: 250, reclaimableSize: 250 });
    expect(report.orphans).toHaveLength(2);
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0].reclaimableSize).toBe(100);
  });

  it.each([false, true])('does not offer referenced duplicate copies for deletion (both referenced: %s)', async (bothReferenced) => {
    addFiles('/a', { 'same.png': 10 });
    addFiles('/b', { 'same.png': 10 });
    mocks.digests.set('/a/same.png', 'a'.repeat(64));
    mocks.digests.set('/b/same.png', 'a'.repeat(64));
    mocks.getProjectById.mockImplementation(async (id: string) => ({
      ...project(id), nodes: id === 'a' || bothReferenced ? [{ data: { filePath: `/${id}/same.png` } }] : [],
    }));

    const report = await scanStorageHealth([project('a'), project('b')], new Set());
    const group = report.duplicates[0];

    expect(group.files.find((file) => file.path === '/a/same.png')).toMatchObject({ referenced: true, canDelete: false });
    expect(group.files.find((file) => file.path === '/b/same.png')).toMatchObject({ referenced: bothReferenced, canDelete: !bothReferenced });
    expect(group.reclaimableSize).toBe(bothReferenced ? 0 : 10);
    expect(report.reclaimableSize).toBe(bothReferenced ? 0 : 10);
  });

  it('does not identify same-name and same-size files with different content as duplicates', async () => {
    addFiles('/a', { 'same.png': 10 });
    addFiles('/b', { 'same.png': 10 });
    mocks.digests.set('/a/same.png', 'a'.repeat(64));
    mocks.digests.set('/b/same.png', 'b'.repeat(64));

    const report = await scanStorageHealth([project('a'), project('b')], new Set());

    expect(report.duplicates).toEqual([]);
    expect(mocks.fingerprintAssetImage.mock.calls.map(([path]) => path))
      .toEqual(expect.arrayContaining(['/a/same.png', '/b/same.png']));
  });

  it('can skip duplicate hashing while retaining references from every project', async () => {
    addFiles('/a', { 'same.png': 10 });
    addFiles('/b', { 'same.png': 10 });
    mocks.getProjectById.mockImplementation(async (id: string) => ({
      ...project(id), nodes: id === 'b' ? [{ data: { filePath: '/a/same.png' } }] : [],
    }));

    const report = await scanStorageHealth([project('a'), project('b')], new Set(), [], { includeDuplicates: false });

    expect(report.orphans.map((file) => file.path)).toEqual(['/b/same.png']);
    expect(report.reclaimableSize).toBe(10);
    expect(report.duplicates).toEqual([]);
    expect(mocks.fingerprintAssetImage).not.toHaveBeenCalled();
  });

  it('does not start database or file reads after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(scanStorageHealth([project('a')], new Set(), [], { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });

    expect(mocks.getAllProjects).not.toHaveBeenCalled();
    expect(mocks.getProjectById).not.toHaveBeenCalled();
    expect(mocks.readDir).not.toHaveBeenCalled();
    expect(mocks.fingerprintAssetImage).not.toHaveBeenCalled();
  });

  it('marks unreadable project directories as incomplete instead of reporting a healthy empty result', async () => {
    addFiles('/a', { 'used.png': 10 });
    mocks.readDir.mockRejectedValue(new Error('permission denied: /private/blocked'));

    const report = await scanStorageHealth([project('a')], new Set());

    expect(report.complete).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ area: 'project', reason: 'permission' })]));
    expect(JSON.stringify(report.issues)).not.toContain('/private/blocked');
  });

  it('does not probe an absent hidden trash directory even when the filesystem would reject that probe', async () => {
    addFiles('/a', { 'used.png': 10 });
    mocks.exists.mockImplementation(async (path: string) => {
      if (path === '/a/.trash') throw new Error('forbidden path');
      return mocks.directories.has(path) || mocks.sizes.has(path);
    });

    const report = await scanStorageHealth([project('a')], new Set());

    expect(report).toMatchObject({ complete: true, issues: [], projectSize: 10, trashSize: 0 });
    expect(mocks.exists).not.toHaveBeenCalledWith('/a/.trash');
    expect(mocks.lstat).not.toHaveBeenCalledWith('/a/.trash');
    expect(mocks.readDir).not.toHaveBeenCalledWith('/a/.trash');
  });

  it('keeps project usage when an existing trash directory cannot be accessed', async () => {
    addFiles('/a', { 'used.png': 10 });
    mocks.directories.get('/a')!.push('.trash');
    addFiles('/a/.trash', { 'old.png': 20 });
    const fileInfo = mocks.lstat.getMockImplementation()!;
    mocks.lstat.mockImplementation(async (path: string) => {
      if (path === '/a/.trash') throw new Error('permission denied: /private/trash');
      return fileInfo(path);
    });

    const report = await scanStorageHealth([project('a')], new Set());

    expect(report).toMatchObject({ complete: false, projectSize: 10, trashSize: 0, totalSize: 10 });
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ area: 'trash', reason: 'permission' })]));
    expect(JSON.stringify(report.issues)).not.toContain('/private/trash');
  });

  it('skips operating-system metadata before reading it while retaining ordinary hidden user files', async () => {
    addFiles('/a', { '.DS_Store': 5, '._used.png': 6, 'Thumbs.db': 7, 'desktop.ini': 8,
      '.user-data.json': 30, 'used.png': 20 });

    const report = await scanStorageHealth([project('a')], new Set());

    expect(report).toMatchObject({ complete: true, issues: [], projectSize: 50 });
    expect(report.orphans.map((file) => file.path)).toEqual(['/a/.user-data.json', '/a/used.png']);
    for (const name of ['.DS_Store', '._used.png', 'Thumbs.db', 'desktop.ini']) {
      expect(mocks.lstat).not.toHaveBeenCalledWith(`/a/${name}`);
    }
  });

  it('preserves usage but marks duplicate detection incomplete when content cannot be read', async () => {
    addFiles('/a', { 'same.png': 10 });
    addFiles('/b', { 'same.png': 10 });
    mocks.fingerprintAssetImage.mockRejectedValue(new Error('permission denied: /private/image.png'));

    const report = await scanStorageHealth([project('a'), project('b')], new Set());

    expect(report).toMatchObject({ complete: false, projectSize: 20, totalSize: 20, reclaimableSize: 20, duplicates: [] });
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ area: 'duplicates', reason: 'permission' })]));
    expect(JSON.stringify(report.issues)).not.toContain('/private/image.png');
  });

  it('reports only successfully removed files as reclaimed when trash cleanup partially fails', async () => {
    addFiles('/a/.trash', { 'ok.bin': 10, 'locked.bin': 20 });
    mocks.remove.mockImplementation(async (path: string) => {
      if (path === '/a/.trash/locked.bin') throw new Error('permission denied');
      mocks.sizes.delete(path);
    });

    const result = await clearTrashDir('/a/.trash');

    expect(result).toEqual({ deletedCount: 1, failedCount: 1, reclaimedSize: 10 });
    expect(mocks.sizes.has('/a/.trash/locked.bin')).toBe(true);
    expect(mocks.remove).not.toHaveBeenCalledWith('/a/.trash');
  });
});
