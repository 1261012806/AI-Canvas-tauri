import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramaAsset } from '../../src/types/dramaAssets';
import { setLocale, type Locale } from '../../src/i18n';
import { buildDramaAssetTransferDocument } from '../../src/services/dramaAssetTransferFormat';

const io = vi.hoisted(() => ({
  open: vi.fn(), save: vi.fn(), index: vi.fn(), putIndex: vi.fn(), deleteIndexes: vi.fn(),
  projectDir: vi.fn(), globalDir: vi.fn(), createWorkspace: vi.fn(), createFolder: vi.fn(), createGlobalFolder: vi.fn(),
  cleanup: vi.fn(), retain: vi.fn(), stage: vi.fn(), copy: vi.fn(),
  stat: vi.fn(), pack: vi.fn(), unpack: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: io.open, save: io.save }));
vi.mock('../../src/services/indexedDbService', () => ({
  getAssetIndexById: io.index, putAssetIndex: io.putIndex, deleteImportedAssetIndexes: io.deleteIndexes,
  putGlobalCharacterOrder: vi.fn(),
}));
vi.mock('../../src/services/fileService', () => ({
  isTauriEnv: () => true, getProjectDataDir: io.projectDir, getGlobalFilesDir: io.globalDir,
  getAssetUrlFromPath: async (path: string) => `asset://localhost/${path}`,
  joinPath: (...parts: string[]) => parts.join('/'), sanitizeFileName: (name: string) => name,
  stripVerbatimPrefix: (path: string) => path,
}));
vi.mock('../../src/services/fs/dramaAssetArchive', () => ({
  createDramaAssetArchiveWorkspace: io.createWorkspace, createDramaAssetImportFolder: io.createFolder,
  createGlobalDramaAssetImportFolder: io.createGlobalFolder,
  cleanupDramaAssetTransferDirectory: io.cleanup, retainDramaAssetTransferDirectory: io.retain, stageDramaAssetArchiveMedia: io.stage,
  copyImportedDramaAssetMedia: io.copy, readImportedDramaAssetStat: io.stat,
  packDramaAssetArchive: io.pack, unpackDramaAssetArchive: io.unpack,
  guardedDramaAssetTransfer: async <T>(work: () => Promise<T>, options: { signal?: AbortSignal; assertCurrent?: () => void }) => {
    const check = () => { if (options.signal?.aborted) throw new Error('已取消'); options.assertCurrent?.(); };
    check(); const result = await work(); check(); return result;
  },
}));

import { exportGlobalDramaAssets, exportProjectDramaAssets, importGlobalDramaAssets, importProjectDramaAssets } from '../../src/services/dramaAssetTransferService';

const sha256 = 'a'.repeat(64);
const workspace = { directory: '/staging', assetsDirectory: '/staging/assets', mediaDirectory: '/staging/assets/media', incomingDirectory: '/staging/incoming' };
const folder = { directory: '/project/Library/import-one', rootDirectory: '/project', relativeDirectory: 'Library/import-one' };
const globalFolder = { directory: '/global/import-one', rootDirectory: '/global', relativeDirectory: 'import-one' };
const base = { name: '资产', key: 'asset', summary: '', visualNotes: '', importance: 'main' as const,
  confirmed: true, source: 'manual' as const, createdAt: 1, updatedAt: 1 };
const scene: DramaAsset = { ...base, id: 'scene-old', kind: 'scene', imageUrl: 'aicasset-media:image-one' };
function document() {
  return buildDramaAssetTransferDocument({ exportedAt: 1, name: '资产包', assets: [scene],
    media: [{ id: 'image-one', kind: 'image', path: 'media/item.png', bytes: 3, sha256 }] });
}
function importInput(commit: (assets: DramaAsset[]) => Promise<void> = vi.fn(async (_assets: DramaAsset[]) => undefined)) {
  return { projectId: 'episode', ownerId: 'series', commit };
}
beforeEach(() => {
  vi.clearAllMocks();
  setLocale('zh-CN');
  io.open.mockResolvedValue('/chosen.aicassets'); io.save.mockResolvedValue('/export.aicassets');
  io.projectDir.mockResolvedValue('/project'); io.globalDir.mockResolvedValue('/global');
  io.createWorkspace.mockResolvedValue(workspace); io.createFolder.mockResolvedValue(folder);
  io.createGlobalFolder.mockResolvedValue(globalFolder);
  io.cleanup.mockResolvedValue(undefined); io.putIndex.mockResolvedValue(undefined); io.deleteIndexes.mockResolvedValue(undefined);
  io.index.mockImplementation(async (id: string) => ({ assetId: id, status: 'online', source: 'global', path: id === 'voice-index' ? '/global/voice.wav' : '/global/scene.png' }));
  io.stage.mockImplementation(async (_workspace, _source, id: string, extension: string) => ({
    path: `/staging/assets/media/${id}.${extension}`, relativePath: `media/${id}.${extension}`, totalBytes: 3, digest: sha256,
  }));
  io.copy.mockResolvedValue({ path: '/project/Library/import-one/item.png', totalBytes: 3, digest: sha256 });
  io.stat.mockResolvedValue({ size: 3, mtimeMs: 10 });
  io.pack.mockImplementation(async (_workspace, _path, content: string) => ({ assetCount: JSON.parse(content).media.length }));
  io.unpack.mockResolvedValue({ texts: { 'manifest.json': JSON.stringify(document()) }, assetPaths: ['media/item.png'], assetBytes: 3 });
});
afterEach(() => setLocale('zh-CN'));

describe('project creative asset packages', () => {
  it.each<[Locale, string]>([
    ['zh-CN', '角色甲-资产.aicassets'], ['en-US', '角色甲-Asset.aicassets'],
    ['ja-JP', '角色甲-アセット.aicassets'], ['ko-KR', '角色甲-에셋.aicassets'],
  ])('uses the explicit asset name and localized suffix in %s', async (locale, defaultPath) => {
    setLocale(locale);
    const selected: DramaAsset = { ...base, id: 'selected-prop', name: '角色甲', kind: 'prop' };
    expect(await exportProjectDramaAssets({ projectId: 'episode', ownerId: 'series', projectName: '项目乙',
      assetName: selected.name, assets: [selected], nodes: [] })).toEqual({ assetCount: 1, mediaCount: 0 });
    expect(io.save.mock.calls[0][0].defaultPath).toBe(defaultPath);
    const packed = JSON.parse(io.pack.mock.calls[0][2]);
    expect(packed.assets).toHaveLength(1);
    expect(packed.assets[0]).toMatchObject({ kind: 'prop', name: '角色甲' });
  });

  it('keeps the project name for a batch export containing only one asset', async () => {
    await exportProjectDramaAssets({ projectId: 'episode', ownerId: 'series', projectName: '项目乙',
      assets: [{ ...base, id: 'selected-prop', name: '角色甲', kind: 'prop' }], nodes: [] });
    expect(io.save.mock.calls[0][0].defaultPath).toBe('项目乙-资产.aicassets');
  });

  it('exports node-bound pictures, indexed global pictures, voices, GIF and video actions without project identities', async () => {
    const assets: DramaAsset[] = [{ ...base, id: 'character', kind: 'character', identity: '主角',
      imageNodeId: 'image-node', imageUrl: 'asset://localhost/old.png', primaryReferenceImageId: 'reference', primaryVoiceClipId: 'voice',
      referenceImages: [{ id: 'reference', kind: 'primary', sourceNodeId: 'image-node', imageUrl: 'asset://localhost/old.png', prompt: '', createdAt: 1, updatedAt: 1 }],
      voiceClips: [{ id: 'voice', kind: 'timbre', assetId: 'voice-index', transcript: '', createdAt: 1, updatedAt: 1 }],
      actions: [{ id: 'action', category: 'walking', name: '走路', prompt: '', createdAt: 1, updatedAt: 1, media: [
        { id: 'gif', kind: 'gif', name: 'walk.gif', url: 'asset://localhost//source/walk.gif', createdAt: 1, updatedAt: 1 },
        { id: 'video', kind: 'video', name: 'walk.mp4', url: 'asset://localhost//source/walk.mp4', createdAt: 1, updatedAt: 1 },
      ] }],
    }, { ...base, id: 'scene', kind: 'scene', imageAssetId: 'global-image' },
    { ...base, id: 'prop', kind: 'prop', imageNodeId: 'image-node' }];
    const result = await exportProjectDramaAssets({ projectId: 'episode', ownerId: 'series', projectName: '项目', assets,
      nodes: [{ id: 'image-node', type: 'ai-image', position: { x: 0, y: 0 }, data: {
        type: 'ai-image', label: '来源图', filePath: '/source/live.png', imageUrl: 'asset://localhost//source/live.png',
      } }] });
    expect(result).toEqual({ assetCount: 3, mediaCount: 5 });
    expect(io.stage.mock.calls[0][1]).toEqual({ filePath: '/source/live.png' });
    const packed = JSON.parse(io.pack.mock.calls[0][2]);
    expect(packed.media.map((entry: { kind: string }) => entry.kind)).toEqual(['image', 'audio', 'image', 'video', 'image']);
    expect(JSON.stringify(packed)).not.toMatch(/sourceNodeId|imageNodeId|imageAssetId|filePath|asset:\/\//);
    expect(io.cleanup).toHaveBeenCalledExactlyOnceWith('/staging');
  });

  it('does not allocate directories when the native picker is cancelled', async () => {
    io.open.mockResolvedValue(null);
    expect(await importProjectDramaAssets(importInput())).toBeNull();
    io.save.mockResolvedValue(null);
    expect(await exportProjectDramaAssets({ projectId: 'episode', ownerId: 'series', projectName: '项目', assets: [{ ...base, id: 'text', kind: 'prop' }], nodes: [] })).toBeNull();
    expect(io.createWorkspace).not.toHaveBeenCalled();
  });

  it('assigns independent package card IDs when different asset kinds share a project ID', async () => {
    const assets: DramaAsset[] = [{ ...base, id: 'shared', kind: 'character', identity: '主角' },
      { ...base, id: 'shared', kind: 'scene' }, { ...base, id: 'shared', kind: 'prop' }];
    expect(await exportProjectDramaAssets({ projectId: 'episode', ownerId: 'series', projectName: '项目', assets, nodes: [] }))
      .toEqual({ assetCount: 3, mediaCount: 0 });
    const packed = JSON.parse(io.pack.mock.calls[0][2]);
    expect(new Set(packed.assets.map((asset: DramaAsset) => asset.id)).size).toBe(3);
    expect(packed.assets.every((asset: DramaAsset) => asset.id !== 'shared')).toBe(true);
    expect(assets.map((asset) => asset.id)).toEqual(['shared', 'shared', 'shared']);
  });

  it('preserves the real WMA container suffix instead of renaming its bytes to WAV', async () => {
    io.index.mockResolvedValue({ assetId: 'voice-index', status: 'online', path: '/source/voice.WMA' });
    await exportProjectDramaAssets({ projectId: 'episode', ownerId: 'series', projectName: '项目', nodes: [], assets: [
      { ...base, id: 'character', kind: 'character', identity: '主角', voiceClips: [
        { id: 'voice', kind: 'timbre', assetId: 'voice-index', transcript: '', createdAt: 1, updatedAt: 1 },
      ] },
    ] });
    expect(io.stage.mock.calls[0][1]).toEqual({ filePath: '/source/voice.WMA' });
    expect(io.stage.mock.calls[0][3]).toBe('wma');
    expect(JSON.parse(io.pack.mock.calls[0][2]).media[0].path).toMatch(/\.wma$/);
  });

  it('requires a real indexed global image instead of falling back to its old display URL', async () => {
    io.index.mockResolvedValue(undefined);
    await expect(exportProjectDramaAssets({ projectId: 'episode', ownerId: 'series', projectName: '项目', nodes: [],
      assets: [{ ...base, id: 'scene', kind: 'scene', imageAssetId: 'missing', imageUrl: 'asset://localhost/old.png' }],
    })).rejects.toThrow('导出失败');
    expect(io.pack).not.toHaveBeenCalled();
    expect(io.cleanup).toHaveBeenCalledWith('/staging');
  });

  it('verifies and indexes copied files before committing freshly remapped project assets', async () => {
    const input = importInput(vi.fn(async (assets: DramaAsset[]) => {
      expect(io.putIndex).toHaveBeenCalledTimes(1);
      expect(io.retain).toHaveBeenCalledExactlyOnceWith(folder.directory);
      expect(assets[0].id).not.toBe(scene.id);
      expect(assets[0]).toMatchObject({ kind: 'scene', imageUrl: 'asset://localhost//project/Library/import-one/item.png',
        relativePath: 'Library/import-one/item.png' });
      expect(assets[0]).not.toHaveProperty('imageAssetId');
    }));
    expect(await importProjectDramaAssets(input)).toEqual({ assetCount: 1, mediaCount: 1 });
    expect(io.putIndex.mock.calls[0][0]).toMatchObject({ path: '/project/Library/import-one/item.png', projectId: 'series', source: 'project' });
    expect(input.commit).toHaveBeenCalledTimes(1);
    expect(io.deleteIndexes).not.toHaveBeenCalled();
    expect(io.cleanup.mock.calls).toEqual([['/staging']]);
  });

  it('imports a single-asset package through the append commit without replacing existing cards', async () => {
    const original: DramaAsset = { ...base, id: 'existing-prop', kind: 'prop' };
    const library: DramaAsset[] = [original];
    const commit = vi.fn(async (assets: DramaAsset[]) => { library.push(...assets); });
    expect(await importProjectDramaAssets(importInput(commit))).toEqual({ assetCount: 1, mediaCount: 1 });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toHaveLength(1);
    expect(library).toHaveLength(2);
    expect(library[0]).toBe(original);
    expect(library[1]).toMatchObject({ kind: 'scene', name: scene.name, relativePath: 'Library/import-one/item.png' });
    expect(library[1].id).not.toBe(scene.id);
  });

  it.each(['extra', 'duplicate', 'bytes', 'digest'])('rejects %s media inconsistencies without committing partial metadata', async (failure) => {
    if (failure === 'extra') io.unpack.mockResolvedValue({ texts: { 'manifest.json': JSON.stringify(document()) }, assetPaths: ['media/item.png', 'extra.png'], assetBytes: 3 });
    if (failure === 'duplicate') io.unpack.mockResolvedValue({ texts: { 'manifest.json': JSON.stringify(document()) }, assetPaths: ['media/item.png', 'media/item.png'], assetBytes: 3 });
    if (failure === 'bytes') io.copy.mockResolvedValue({ path: '/project/Library/import-one/item.png', totalBytes: 2, digest: sha256 });
    if (failure === 'digest') io.copy.mockResolvedValue({ path: '/project/Library/import-one/item.png', totalBytes: 3, digest: 'b'.repeat(64) });
    const input = importInput();
    await expect(importProjectDramaAssets(input)).rejects.toThrow('导入失败');
    expect(input.commit).not.toHaveBeenCalled();
    expect(io.putIndex).not.toHaveBeenCalled();
    expect(io.cleanup).toHaveBeenCalledWith('/staging');
    if (['bytes', 'digest'].includes(failure)) expect(io.cleanup).toHaveBeenCalledWith(folder.directory);
  });

  it('cleans only its uncommitted files when cancellation arrives during copying', async () => {
    const controller = new AbortController();
    io.copy.mockImplementation(async () => { controller.abort(); return { path: `${folder.directory}/item.png`, totalBytes: 3, digest: sha256 }; });
    const input = importInput();
    await expect(importProjectDramaAssets(input, { signal: controller.signal })).rejects.toThrow('取消');
    expect(input.commit).not.toHaveBeenCalled();
    expect(io.cleanup).toHaveBeenCalledWith(folder.directory);
    expect(io.cleanup).toHaveBeenCalledWith(workspace.directory);
  });

  it('treats a completed commit as success even when the view cancels while it is saving', async () => {
    const controller = new AbortController();
    const input = importInput(vi.fn(async () => { controller.abort(); }));
    expect(await importProjectDramaAssets(input, { signal: controller.signal })).toEqual({ assetCount: 1, mediaCount: 1 });
    expect(io.deleteIndexes).not.toHaveBeenCalled();
    expect(io.cleanup.mock.calls).toEqual([['/staging']]);
  });

  it('retains final media and indexes after an attempted commit fails', async () => {
    const input = importInput(vi.fn(async () => { throw new Error('database unavailable'); }));
    await expect(importProjectDramaAssets(input)).rejects.toThrow('导入媒体已保留');
    expect(io.deleteIndexes).not.toHaveBeenCalled();
    expect(io.cleanup.mock.calls).toEqual([['/staging']]);
  });
});

describe('global creative asset packages', () => {
  it('exports all supplied kinds from global indexes and root without project or source-node lookup', async () => {
    const assets: DramaAsset[] = [{ ...base, id: 'character', kind: 'character', identity: '主角',
      imageNodeId: 'stale-project-node', primaryReferenceImageId: 'reference',
      referenceImages: [{ id: 'reference', kind: 'primary', relativePath: 'people/reference.png',
        sourceNodeId: 'stale-project-node', prompt: '', createdAt: 1, updatedAt: 1 }],
      voiceClips: [{ id: 'voice', kind: 'timbre', assetId: 'voice-index', transcript: '', createdAt: 1, updatedAt: 1 }],
      actions: [{ id: 'action', category: 'walking', name: '走路', prompt: '', createdAt: 1, updatedAt: 1,
        media: [{ id: 'motion', kind: 'video', name: 'motion.mp4', url: 'asset://localhost//global/motion.mp4', createdAt: 1, updatedAt: 1 }] }],
    }, { ...base, id: 'scene', kind: 'scene', imageAssetId: 'global-image' }, { ...base, id: 'prop', kind: 'prop' }];
    expect(await exportGlobalDramaAssets({ libraryName: '全局创作资产', assets })).toEqual({ assetCount: 3, mediaCount: 4 });
    expect(io.projectDir).not.toHaveBeenCalled();
    expect(io.globalDir).toHaveBeenCalledTimes(1);
    expect(io.stage.mock.calls[0][1]).toEqual({ filePath: '/global/people/reference.png' });
    expect(io.stage.mock.calls[1][1]).toEqual({ filePath: '/global/voice.wav' });
    expect(io.save.mock.calls[0][0].defaultPath).toBe('全局创作资产-资产.aicassets');
    const packed = JSON.parse(io.pack.mock.calls[0][2]);
    expect(packed.assets.map((asset: DramaAsset) => asset.kind)).toEqual(['character', 'scene', 'prop']);
    expect(JSON.stringify(packed)).not.toMatch(/sourceNodeId|imageNodeId|imageAssetId|filePath|asset:\/\//);
  });

  it('supports a single global card with the same localized filename rule', async () => {
    setLocale('en-US');
    await exportGlobalDramaAssets({ libraryName: 'Global props', assetName: 'Selected prop',
      assets: [{ ...base, id: 'prop', name: 'Selected prop', kind: 'prop' }] });
    expect(io.save.mock.calls[0][0].defaultPath).toBe('Selected prop-Asset.aicassets');
    expect(JSON.parse(io.pack.mock.calls[0][2]).assets).toHaveLength(1);
    expect(io.projectDir).not.toHaveBeenCalled();
  });

  it('rejects a global card whose stable media ID points to a project index', async () => {
    io.index.mockResolvedValue({ assetId: 'project-image', source: 'project', status: 'online', path: '/project/image.png' });
    await expect(exportGlobalDramaAssets({ libraryName: '全局场景',
      assets: [{ ...base, id: 'scene', kind: 'scene', imageAssetId: 'project-image', imageUrl: 'asset://localhost//global/old.png' }],
    })).rejects.toThrow('导出失败');
    expect(io.stage).not.toHaveBeenCalled();
    expect(io.projectDir).not.toHaveBeenCalled();
    expect(io.pack).not.toHaveBeenCalled();
  });

  it('prepares three kinds with global identities and preserves a legacy character top image as an indexed reference', async () => {
    const assets: DramaAsset[] = [{ ...base, id: 'character-old', kind: 'character', identity: '主角',
      imageUrl: 'aicasset-media:image-one', referenceImages: [] }, scene,
    { ...base, id: 'prop-old', kind: 'prop', imageUrl: 'aicasset-media:image-one' }];
    const bundle = buildDramaAssetTransferDocument({ exportedAt: 1, name: '全局包', assets,
      media: [{ id: 'image-one', kind: 'image', path: 'media/item.png', bytes: 3, sha256 }] });
    io.unpack.mockResolvedValue({ texts: { 'manifest.json': JSON.stringify(bundle) }, assetPaths: ['media/item.png'], assetBytes: 3 });
    io.copy.mockResolvedValue({ path: `${globalFolder.directory}/item.png`, totalBytes: 3, digest: sha256 });
    const commit = vi.fn(async (imported: DramaAsset[]) => {
      const indexed = io.putIndex.mock.calls[0][0];
      expect(indexed).toMatchObject({ source: 'global', rootPath: '/global', relativePath: 'import-one/item.png' });
      expect(indexed).not.toHaveProperty('projectId');
      expect(imported.every((asset) => !assets.some((original) => original.id === asset.id))).toBe(true);
      const character = imported.find((asset) => asset.kind === 'character');
      expect(character?.kind).toBe('character');
      if (character?.kind !== 'character') throw new Error('Missing imported character');
      expect(character.referenceImages).toHaveLength(1);
      expect(character.referenceImages?.[0]).toMatchObject({ assetId: indexed.assetId, relativePath: 'import-one/item.png',
        imageUrl: 'asset://localhost//global/import-one/item.png' });
      expect(character.primaryReferenceImageId).toBe(character.referenceImages?.[0].id);
      for (const asset of imported) {
        expect(asset).not.toHaveProperty('assetId');
        expect(asset).not.toHaveProperty('relativePath');
        expect(asset).not.toHaveProperty('filePath');
        expect(asset).not.toHaveProperty('imageNodeId');
        if (asset.kind !== 'character') expect(asset).toMatchObject({ imageAssetId: indexed.assetId, imageRelativePath: 'import-one/item.png' });
      }
    });
    expect(await importGlobalDramaAssets({ commit })).toEqual({ assetCount: 3, mediaCount: 1 });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(io.createFolder).not.toHaveBeenCalled();
    expect(io.copy.mock.calls[0][1]).toBe(globalFolder.directory);
    expect(io.cleanup.mock.calls).toEqual([['/staging']]);
  });

  it('stops before global metadata commit when the captured scope changes during copying', async () => {
    let current = true;
    io.copy.mockImplementation(async () => {
      current = false;
      return { path: `${globalFolder.directory}/item.png`, totalBytes: 3, digest: sha256 };
    });
    const commit = vi.fn(async (_assets: DramaAsset[]) => undefined);
    await expect(importGlobalDramaAssets({ commit }, { assertCurrent: () => {
      if (!current) throw new Error('scope changed');
    } })).rejects.toThrow('scope changed');
    expect(commit).not.toHaveBeenCalled();
    expect(io.putIndex).not.toHaveBeenCalled();
    expect(io.cleanup).toHaveBeenCalledWith(globalFolder.directory);
    expect(io.cleanup).toHaveBeenCalledWith(workspace.directory);
  });

  it('keeps a completed global commit when the panel aborts while saving', async () => {
    io.copy.mockResolvedValue({ path: `${globalFolder.directory}/item.png`, totalBytes: 3, digest: sha256 });
    const controller = new AbortController();
    const commit = vi.fn(async (_assets: DramaAsset[]) => { controller.abort(); });
    expect(await importGlobalDramaAssets({ commit }, { signal: controller.signal })).toEqual({ assetCount: 1, mediaCount: 1 });
    expect(io.deleteIndexes).not.toHaveBeenCalled();
    expect(io.cleanup.mock.calls).toEqual([['/staging']]);
  });

  it('retains global media and indexes after an attempted metadata commit fails', async () => {
    io.copy.mockResolvedValue({ path: `${globalFolder.directory}/item.png`, totalBytes: 3, digest: sha256 });
    const commit = vi.fn(async (_assets: DramaAsset[]) => { throw new Error('database unavailable'); });
    await expect(importGlobalDramaAssets({ commit })).rejects.toThrow('请重新打开资产库检查');
    expect(io.deleteIndexes).not.toHaveBeenCalled();
    expect(io.cleanup.mock.calls).toEqual([['/staging']]);
  });
});
