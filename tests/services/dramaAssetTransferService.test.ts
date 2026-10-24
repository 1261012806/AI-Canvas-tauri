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

import { exportGlobalDramaAssets, exportProjectDramaAssets, importGlobalDramaAssets, importProjectDramaAssets,
  copyGlobalDramaAssetsToProject, type DramaAssetImportPreview } from '../../src/services/dramaAssetTransferService';

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
      assetName: selected.name, assets: [selected], nodes: [] })).toMatchObject({ assetCount: 1, mediaCount: 0, assets: [{ kind: 'prop', id: selected.id }] });
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
    expect(result).toMatchObject({ assetCount: 3, mediaCount: 5 });
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
      .toMatchObject({ assetCount: 3, mediaCount: 0 });
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
    })).rejects.toThrow('无法导出');
    expect(io.pack).not.toHaveBeenCalled();
    expect(io.cleanup).toHaveBeenCalledWith('/staging');
  });

  it.each([
    ['legacy-top', 'missing'], ['reference', 'missing'],
    ['legacy-top', 'offline'], ['reference', 'wrong-scope'],
  ] as const)('%s 全局引用索引 %s 时不借用同 ID 项目节点、旧 URL 或相对文件', async (shape, status) => {
    io.index.mockResolvedValue(status === 'missing' ? undefined : { assetId: 'global-required',
      source: status === 'wrong-scope' ? 'project' : 'global', status: status === 'offline' ? 'offline' : 'online', path: '/project/live.png' });
    const asset: DramaAsset = { ...base, id: 'global-required-card', kind: 'scene',
      ...(shape === 'legacy-top' ? { imageAssetId: 'global-required', imageRelativePath: 'same.png',
        imageNodeId: 'same-node', imageUrl: 'asset://localhost//old/same.png' }
        : { referenceImages: [{ id: 'global-ref', label: '', prompt: '', assetId: 'global-required', assetSource: 'global',
          relativePath: 'same.png', sourceNodeId: 'same-node', imageUrl: 'asset://localhost//old/same.png', createdAt: 1, updatedAt: 1 }],
          primaryReferenceImageId: 'global-ref' }),
    };
    await expect(exportProjectDramaAssets({ projectId: 'episode', ownerId: 'series', projectName: '项目', assets: [asset],
      nodes: [{ id: 'same-node', type: 'ai-image', position: { x: 0, y: 0 },
        data: { type: 'ai-image', label: '同 ID 图', filePath: '/project/live.png', imageUrl: 'asset://localhost//project/live.png' } }],
    })).rejects.toThrow('无法导出');
    expect(io.stage).not.toHaveBeenCalled();
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
    const result = await importProjectDramaAssets(input);
    expect(result).toMatchObject({ assetCount: 1, mediaCount: 1 });
    expect(result?.assets).toEqual(vi.mocked(input.commit).mock.calls[0][0].map(({ kind, id }) => ({ kind, id })));
    expect(io.putIndex.mock.calls[0][0]).toMatchObject({ path: '/project/Library/import-one/item.png', projectId: 'series', source: 'project' });
    expect(input.commit).toHaveBeenCalledTimes(1);
    expect(io.deleteIndexes).not.toHaveBeenCalled();
    expect(io.cleanup.mock.calls).toEqual([['/staging']]);
  });

  it('imports a single-asset package through the append commit without replacing existing cards', async () => {
    const original: DramaAsset = { ...base, id: 'existing-prop', kind: 'prop' };
    const library: DramaAsset[] = [original];
    const commit = vi.fn(async (assets: DramaAsset[]) => { library.push(...assets); });
    expect(await importProjectDramaAssets(importInput(commit))).toMatchObject({ assetCount: 1, mediaCount: 1 });
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
    await expect(importProjectDramaAssets(input)).rejects.toThrow(/导入失败|校验失败/);
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
    expect(await importProjectDramaAssets(input, { signal: controller.signal })).toMatchObject({ assetCount: 1, mediaCount: 1 });
    expect(io.deleteIndexes).not.toHaveBeenCalled();
    expect(io.cleanup.mock.calls).toEqual([['/staging']]);
  });

  it('retains final media and indexes after an attempted commit fails', async () => {
    const input = importInput(vi.fn(async () => { throw new Error('database unavailable'); }));
    await expect(importProjectDramaAssets(input)).rejects.toThrow('导入媒体已保留');
    expect(io.deleteIndexes).not.toHaveBeenCalled();
    expect(io.cleanup.mock.calls).toEqual([['/staging']]);
  });

  it('verifies the full package before choosing, then only copies and returns selected asset identities', async () => {
    const bundle = buildDramaAssetTransferDocument({ exportedAt: 1, name: '混合包',
      assets: [scene, { ...base, id: 'prop-old', kind: 'prop', name: '桌子', imageUrl: 'aicasset-media:image-two' }],
      media: [{ id: 'image-one', kind: 'image', path: 'media/item.png', bytes: 3, sha256 },
        { id: 'image-two', kind: 'image', path: 'media/other.png', bytes: 3, sha256 }] });
    io.unpack.mockResolvedValue({ texts: { 'manifest.json': JSON.stringify(bundle) }, assetPaths: ['media/item.png', 'media/other.png'], assetBytes: 6 });
    io.copy.mockImplementation(async (source: string, directory: string) => ({ path: `${directory}/${source.split('/').pop()}`, totalBytes: 3, digest: sha256 }));
    const chooseAssets = vi.fn(async (preview: DramaAssetImportPreview) => {
      expect(io.copy).toHaveBeenCalledTimes(2);
      expect(io.createFolder).not.toHaveBeenCalled();
      expect(io.putIndex).not.toHaveBeenCalled();
      expect(preview.items[0]).toMatchObject({ id: scene.id, sameName: true, mediaIds: ['image-one'] });
      expect(preview.media).toEqual([{ id: 'image-one', kind: 'image', bytes: 3 }, { id: 'image-two', kind: 'image', bytes: 3 }]);
      return [{ kind: 'scene' as const, id: scene.id }];
    });
    const commit = vi.fn(async (_assets: DramaAsset[]) => undefined);
    const result = await importProjectDramaAssets({ ...importInput(commit), existingAssets: [scene] }, { chooseAssets });
    expect(io.copy.mock.calls.map((call) => call[1])).toEqual([workspace.incomingDirectory, workspace.incomingDirectory, folder.directory]);
    expect(io.copy.mock.calls[2][0]).toBe('/staging/incoming/item.png');
    expect(io.putIndex).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toHaveLength(1);
    expect(result).toEqual({ assetCount: 1, mediaCount: 1,
      assets: commit.mock.calls[0][0].map(({ kind, id }) => ({ kind, id })) });
    expect(result!.assets[0].id).not.toBe(scene.id);
  });

  it.each(['cancel', 'abort', 'unknown'])('does not allocate final files or save when asset selection is %s', async (mode) => {
    const controller = new AbortController();
    io.copy.mockResolvedValue({ path: '/staging/incoming/item.png', totalBytes: 3, digest: sha256 });
    const chooseAssets = vi.fn(async () => {
      if (mode === 'abort') controller.abort();
      return mode === 'cancel' ? null : [{ kind: 'scene' as const, id: mode === 'unknown' ? 'unknown' : scene.id }];
    });
    const input = importInput();
    const work = importProjectDramaAssets(input, { signal: controller.signal, chooseAssets });
    if (mode === 'cancel') expect(await work).toBeNull();
    else await expect(work).rejects.toThrow(mode === 'abort' ? '取消' : '资产包无效');
    expect(io.createFolder).not.toHaveBeenCalled();
    expect(io.putIndex).not.toHaveBeenCalled();
    expect(input.commit).not.toHaveBeenCalled();
    expect(io.cleanup).toHaveBeenCalledExactlyOnceWith(workspace.directory);
  });

  it('rejects corrupt media before selection can hide it, with a useful name and no filesystem details', async () => {
    io.copy.mockResolvedValue({ path: '/staging/incoming/item.png', totalBytes: 3, digest: 'b'.repeat(64) });
    const chooseAssets = vi.fn(async () => []);
    const input = importInput();
    await expect(importProjectDramaAssets(input, { chooseAssets })).rejects.toThrow('资产包中「资产」的主图校验失败');
    expect(chooseAssets).not.toHaveBeenCalled();
    expect(io.createFolder).not.toHaveBeenCalled();
    expect(input.commit).not.toHaveBeenCalled();
  });

  it.each(['reference', 'voice', 'action'])('names the broken %s media without exposing native errors', async (slot) => {
    const asset: DramaAsset = { ...base, id: 'person', kind: 'character', name: '人物甲', identity: '主角' };
    if (slot === 'reference') asset.referenceImages = [{ id: 'reference', kind: 'primary', imageUrl: 'asset://localhost//private/image.png', prompt: '', createdAt: 1, updatedAt: 1 }];
    if (slot === 'voice') asset.voiceClips = [{ id: 'voice', kind: 'line', label: '问候', audioUrl: 'asset://localhost//private/audio.wav', transcript: '', createdAt: 1, updatedAt: 1 }];
    if (slot === 'action') asset.actions = [{ id: 'action', category: 'walking', name: '行走', prompt: '', createdAt: 1, updatedAt: 1,
      media: [{ id: 'motion', kind: 'video', name: '抬脚', url: 'asset://localhost//private/video.mp4', createdAt: 1, updatedAt: 1 }] }];
    io.stage.mockRejectedValue(new Error('native failed at /private/credential/path'));
    const failure = await exportProjectDramaAssets({ projectId: 'episode', ownerId: 'series', projectName: '项目', assets: [asset], nodes: [] })
      .then(() => '', (error: Error) => error.message);
    expect(failure).toContain('人物甲');
    expect(failure).toContain(slot === 'reference' ? '参考图 1' : slot === 'voice' ? '声音「问候」' : '动作「行走」的素材「抬脚」');
    expect(failure).not.toContain('/private');
    expect(io.pack).not.toHaveBeenCalled();
  });
});

describe('global creative asset packages', () => {
  it('materializes selected global media into the project without archive dialogs and returns fresh identities', async () => {
    const source: DramaAsset[] = [{ ...base, id: 'global-scene', kind: 'scene', imageAssetId: 'global-image' },
      { ...base, id: 'global-person', kind: 'character', identity: '主角', voiceClips: [{ id: 'global-voice',
        kind: 'timbre', assetId: 'voice-index', transcript: '', createdAt: 1, updatedAt: 1 }], primaryVoiceClipId: 'global-voice' }];
    const before = JSON.stringify(source);
    io.copy.mockImplementation(async (path: string, directory: string) => ({ path: `${directory}/${path.split('/').pop()}`, totalBytes: 3, digest: sha256 }));
    const commit = vi.fn(async (_assets: DramaAsset[]) => undefined);
    const result = await copyGlobalDramaAssetsToProject({ ownerId: 'series', assets: source, commit });
    expect(io.open).not.toHaveBeenCalled(); expect(io.save).not.toHaveBeenCalled();
    expect(io.pack).not.toHaveBeenCalled(); expect(io.unpack).not.toHaveBeenCalled();
    expect(io.putIndex).toHaveBeenCalledTimes(2);
    expect(io.putIndex.mock.calls.every((call) => call[0].source === 'project' && call[0].projectId === 'series'
      && call[0].path.startsWith(folder.directory))).toBe(true);
    const saved = commit.mock.calls[0][0];
    expect(saved.every((asset) => !source.some((original) => original.id === asset.id))).toBe(true);
    const person = saved.find((asset) => asset.kind === 'character');
    expect(person?.kind).toBe('character');
    if (person?.kind !== 'character') throw new Error('Missing copied character');
    expect(person.primaryVoiceClipId).toBe(person.voiceClips![0].id);
    expect(person.voiceClips![0].id).not.toBe('global-voice');
    expect(person.voiceClips![0].assetId).not.toBe('voice-index');
    expect(person.voiceClips![0].relativePath).toMatch(/^Library\/import-one\//);
    expect(saved[0]).not.toHaveProperty('imageAssetId');
    expect(result).toEqual({ assetCount: 2, mediaCount: 2, assets: saved.map(({ kind, id }) => ({ kind, id })) });
    expect(JSON.stringify(source)).toBe(before);
  });

  it('uses the import cleanup and accepted-save rules for cross-scope copies', async () => {
    const source: DramaAsset[] = [{ ...base, id: 'global-scene', kind: 'scene', imageAssetId: 'global-image' }];
    const controller = new AbortController();
    const commit = vi.fn(async (_assets: DramaAsset[]) => { controller.abort(); });
    expect(await copyGlobalDramaAssetsToProject({ ownerId: 'series', assets: source, commit }, { signal: controller.signal }))
      .toMatchObject({ assetCount: 1, mediaCount: 1 });
    expect(io.retain).toHaveBeenCalledExactlyOnceWith(folder.directory);
    expect(io.deleteIndexes).not.toHaveBeenCalled();
    expect(io.cleanup.mock.calls).toEqual([[workspace.directory]]);
  });

  it('exports every scene reference with its label and preserves the selected primary image', async () => {
    io.index.mockImplementation(async (id: string) => ({ assetId: id, status: 'online', source: 'global', path: `/global/${id}.png` }));
    await exportGlobalDramaAssets({ libraryName: '全局场景', assets: [{ ...base, id: 'scene', kind: 'scene',
      referenceImages: [{ id: 'day', label: '日景', prompt: '阳光', assetId: 'day-image', createdAt: 1, updatedAt: 1 },
        { id: 'night', label: '夜景', prompt: '月光', assetId: 'night-image', createdAt: 1, updatedAt: 1 }],
      primaryReferenceImageId: 'night' }] });
    expect(io.stage.mock.calls.map((call) => call[1])).toEqual([{ filePath: '/global/day-image.png' }, { filePath: '/global/night-image.png' }]);
    const packed = JSON.parse(io.pack.mock.calls[0][2]);
    expect(packed.assets[0].referenceImages).toMatchObject([{ label: '日景', prompt: '阳光' }, { label: '夜景', prompt: '月光' }]);
    expect(packed.assets[0].imageUrl).toBe(packed.assets[0].referenceImages[1].imageUrl);
    expect(packed.assets[0].primaryReferenceImageId).toBe('night');
    expect(packed.media).toHaveLength(2);
  });

  it('exports all supplied kinds from global indexes and root without project or source-node lookup', async () => {
    const assets: DramaAsset[] = [{ ...base, id: 'character', kind: 'character', identity: '主角',
      imageNodeId: 'stale-project-node', primaryReferenceImageId: 'reference',
      referenceImages: [{ id: 'reference', kind: 'primary', relativePath: 'people/reference.png',
        sourceNodeId: 'stale-project-node', prompt: '', createdAt: 1, updatedAt: 1 }],
      voiceClips: [{ id: 'voice', kind: 'timbre', assetId: 'voice-index', transcript: '', createdAt: 1, updatedAt: 1 }],
      actions: [{ id: 'action', category: 'walking', name: '走路', prompt: '', createdAt: 1, updatedAt: 1,
        media: [{ id: 'motion', kind: 'video', name: 'motion.mp4', url: 'asset://localhost//global/motion.mp4', createdAt: 1, updatedAt: 1 }] }],
    }, { ...base, id: 'scene', kind: 'scene', imageAssetId: 'global-image' }, { ...base, id: 'prop', kind: 'prop' }];
    expect(await exportGlobalDramaAssets({ libraryName: '全局创作资产', assets })).toMatchObject({ assetCount: 3, mediaCount: 4 });
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
    })).rejects.toThrow('无法导出');
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
    expect(await importGlobalDramaAssets({ commit })).toMatchObject({ assetCount: 3, mediaCount: 1 });
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
    expect(await importGlobalDramaAssets({ commit }, { signal: controller.signal })).toMatchObject({ assetCount: 1, mediaCount: 1 });
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
