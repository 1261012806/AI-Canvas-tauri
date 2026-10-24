import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetUsageTarget } from '../../src/types/assetUsage';
const io = vi.hoisted(() => ({ projects: vi.fn(), project: vi.fn(), globals: vi.fn(), details: vi.fn(),
  state: { value: {} as Record<string, unknown> } }));
vi.mock('../../src/services/fileService', () => ({ getBaseDir: async () => '/base', getProjectDataDir: async (id: string) => `/data/${id}`,
  joinPath: (...parts: string[]) => parts.join('/') }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => io.state.value } }));
vi.mock('../../src/services/indexedDbService', () => ({
  getAllProjects: io.projects, getProjectById: io.project, getAllGlobalCharacters: io.globals,
  getAllGlobalDramaAssets: async () => [], getHistoryEntriesPage: async () => ({ records: [], hasMore: false }),
  getProjectConversations: async () => [], getTrashConversations: async () => [], getConversationMessages: async () => ({ messages: [], total: 0 }),
  getProjectAgentTasks: async () => [], listVideoEditorProjectsByProject: async () => [], getAllWorkflows: async () => [], getAllPresets: async () => [], getAssetImageRecords: io.details,
}));
import { loadAssetUsage, matchesAssetUsage } from '../../src/services/assetUsageService';
const file: AssetUsageTarget = { kind: 'file', path: 'D:/media/a b.png', assetId: 'file-a', name: '图' };
beforeEach(() => {
  vi.clearAllMocks(); io.projects.mockResolvedValue([{ id: 'project', name: '项目' }]); io.globals.mockResolvedValue([]); io.details.mockResolvedValue([]);
  io.state.value = { currentProjectId: 'project', projects: [{ id: 'project', name: '项目' }], projectName: '项目', nodes: [],
    dramaAssets: { characters: [], scenes: [], props: [] }, globalCharacters: [], globalScenes: [], globalProps: [], history: [], messages: [], workflows: [], userPresets: [] };
});
describe('asset usage identity matching', () => {
  it('matches encoded asset tokens and exact local identities without matching names or partial paths', () => {
    expect(matchesAssetUsage(`参考 @asset{${encodeURIComponent(file.path)}}`, file)).toBe(true);
    expect(matchesAssetUsage('参考 @asset{D%3A%2Fmedia%2Fother%2Fa%20b.png}', file)).toBe(false);
    expect(matchesAssetUsage('参考 @asset{%ZZ}', file)).toBe(false);
    expect(matchesAssetUsage({ imageAssetId: 'file-a' }, file)).toBe(true);
    expect(matchesAssetUsage({ name: 'a b.png' }, file)).toBe(false);
  });
  it('resolves same-ID creative mentions by the real kind priority and project owner', () => {
    const character: AssetUsageTarget = { kind: 'creative', scope: 'project', ownerId: 'series', assetKind: 'character', assetId: 'same', name: '人物' };
    const scene: AssetUsageTarget = { ...character, assetKind: 'scene' };
    const context = { ownerId: 'series', projectKinds: new Map([['same', 'character' as const]]) };
    expect(matchesAssetUsage('@drama{same#all:同名}', character, context)).toBe(true);
    expect(matchesAssetUsage('@drama{same:同名}', scene, context)).toBe(false);
    expect(matchesAssetUsage('@drama{same:同名}', character, { ...context, ownerId: 'other' })).toBe(false);
    expect(matchesAssetUsage('@drama{global/same:同名}', character, context)).toBe(false);
  });
  it('follows only explicitly supplied source output IDs and resolved creative file IDs', () => {
    expect(matchesAssetUsage('@{source:图}', file, { nodeIds: new Set(['source']) })).toBe(true);
    expect(matchesAssetUsage('@{other:图}', file, { nodeIds: new Set(['source']) })).toBe(false);
    const card = { id: 'card', kind: 'character', primaryReferenceImageId: 'a', referenceImages: [
      { id: 'a', imageUrl: file.path }, { id: 'b', imageUrl: 'D:/other.png' }], voiceClips: [{ id: 'v1', audioUrl: file.path }, { id: 'v2', audioUrl: 'D:/other.wav' }] };
    const context = { globalAssets: new Map([['card', card]]) };
    expect(matchesAssetUsage('@drama{global/card#all:角色}', file, context)).toBe(true);
    expect(matchesAssetUsage('@drama{global/card#b:角色}', file, context)).toBe(false);
    expect(matchesAssetUsage('@drama{global/card#voice/v2:角色}', file, context)).toBe(false);
    const legacy = { id: 'legacy', imageUrl: 'D:/other.png', voiceClips: [{ id: 'v1', audioUrl: file.path, sourceNodeId: 'voice' }] };
    const legacyContext = { projectAssets: new Map([['legacy', legacy]]), nodes: new Map([['voice', { data: { audioUrl: 'D:/new.wav' } }]]) };
    expect(matchesAssetUsage('@drama{legacy:角色}', file, legacyContext)).toBe(false);
    expect(matchesAssetUsage('@drama{legacy#voice/v1:角色}', file, legacyContext)).toBe(true);
  });
  it('keeps saved and live source output maps separate, and aggregates multiple targets in one project read', async () => {
    const card = { id: 'card', kind: 'character', name: '角色', referenceImages: [{ id: 'ref', sourceNodeId: 'source' }] };
    io.project.mockResolvedValue({ id: 'project', name: '项目', nodes: [{ id: 'source', type: 'source-image', data: { filePath: file.path, label: '旧图' } }],
      dramaAssets: { characters: [card], scenes: [], props: [] } });
    io.state.value.nodes = [{ id: 'source', type: 'source-image', data: { filePath: 'D:/media/new.png', label: '新图' } },
      { id: 'consumer', type: 'ai-image', data: { prompt: '@{source:新图}', label: '使用新图' } }];
    io.state.value.dramaAssets = { characters: [card], scenes: [], props: [] };
    const report = await loadAssetUsage([file, { kind: 'file', path: 'D:/unrelated.png', name: '其他' }]);
    expect(io.project).toHaveBeenCalledTimes(1);
    expect(report.locations.find((location) => location.kind === 'creative')?.live).toBe(false);
    expect(report.locations.some((location) => location.nodeId === 'consumer')).toBe(false);
  });
  it('rejects an incomplete project read instead of reporting that deletion has no impact', async () => {
    io.project.mockResolvedValue(undefined);
    await expect(loadAssetUsage(file)).rejects.toThrow('读取不完整');
  });
  it('includes image information associations and live workflow or preset edits', async () => {
    io.project.mockResolvedValue({ id: 'project', name: '项目', nodes: [] });
    io.details.mockResolvedValue([{ id: 'details', assetId: 'owner', fileName: '主图', references: [{ relativePath: 'references/image.png' }] }]);
    io.state.value.workflows = [{ id: 'workflow', name: '草稿工作流', prompt: `@asset{${encodeURIComponent(file.path)}}` }];
    io.state.value.userPresets = [{ id: 'preset', name: '草稿预设', thumbnail: file.path }];
    const report = await loadAssetUsage([file, { kind: 'file', name: '参考图', path: '/base/references/image.png' }]);
    expect(report.locations.map((location) => location.kind)).toEqual(expect.arrayContaining(['image-details', 'workflow', 'preset']));
  });
  it('treats canvas undo history as snapshots rather than generation history records', async () => {
    io.project.mockResolvedValue({ id: 'project', name: '项目', nodes: [] });
    io.state.value.history = [{ nodes: [{ id: 'old', data: { filePath: file.path, label: '旧画布节点' } }], edges: [], groups: [] }];
    const report = await loadAssetUsage(file);
    expect(report.locations.find((location) => location.key === 'undo:0:old')).toMatchObject({ kind: 'history', live: true });
  });
});
