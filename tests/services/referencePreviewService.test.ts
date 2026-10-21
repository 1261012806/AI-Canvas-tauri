import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import type { DramaCharacter } from '../../src/types/dramaAssets';
import { buildDramaActionMentionId, buildDramaVoiceMentionId } from '../../src/types/dramaAssets';
import { useAppStore } from '../../src/store/useAppStore';
import { resolveReferencePreview } from '../../src/services/referencePreviewService';
import { getAssetUrlFromPath, readAssetTextFile } from '../../src/services/fileService';
import { readChatImageReference } from '../../src/services/chat/chatImageReferenceService';
import { GENERAL_ASSISTANT_SCOPE_ID } from '../../src/services/chat/assistantScope';
import { loadGlobalCharacterCards } from '../../src/services/characterLibraryService';

vi.mock('../../src/services/fileService', async (original) => ({
  ...await original<typeof import('../../src/services/fileService')>(),
  getAssetUrlFromPath: vi.fn(async () => 'asset://localhost/authorized-media'),
  readAssetTextFile: vi.fn(),
}));
vi.mock('../../src/services/chat/chatImageReferenceService', async (original) => ({
  ...await original<typeof import('../../src/services/chat/chatImageReferenceService')>(),
  readChatImageReference: vi.fn(async () => 'data:image/png;base64,aW1hZ2U='),
}));
vi.mock('../../src/services/characterLibraryService', async (original) => ({
  ...await original<typeof import('../../src/services/characterLibraryService')>(),
  loadGlobalCharacterCards: vi.fn(async () => []),
}));

const longText = '完整内容，不应裁成悬浮预览。'.repeat(100);
function node(id: string, type: BaseNodeData['type'], data: Partial<BaseNodeData> = {}) {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, ...data } };
}
function character(id = 'character'): DramaCharacter {
  return { id, kind: 'character', name: '小绘', key: '小绘', identity: '主角', summary: longText, visualNotes: '',
    importance: 'main', confirmed: true, createdAt: 1, updatedAt: 1, source: 'manual' };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  vi.mocked(readAssetTextFile).mockReset();
  vi.mocked(loadGlobalCharacterCards).mockReset().mockResolvedValue([]);
});

describe('引用大屏内容读取', () => {
  it('读取完整源文本和 Skill 正文，模型只投影安全资料，不改变 Store', async () => {
    const state = useAppStore.getState();
    useAppStore.setState({ nodes: [node('text', 'source-text', { output: longText })],
      userSkills: [{ id: 'skill', name: '剧作', description: '对白写作', fileName: 'SKILL.md', content: longText,
        sourceType: 'file', storagePath: 'private-skill-path', createdAt: 1 }],
      config: { ...state.config, generalModels: [{ id: 'model', name: '我的模型', modelId: 'video-model', category: 'video',
        description: '多参考图视频', providerConfigId: 'private-provider-id' }] },
    });
    const snapshot = useAppStore.getState();
    expect(await resolveReferencePreview({ kind: 'node', id: 'text', label: '文本' })).toMatchObject({ text: longText });
    expect(await resolveReferencePreview({ kind: 'skill', id: 'skill', label: 'Skill' })).toMatchObject({ kind: 'markdown', text: longText });
    const model = await resolveReferencePreview({ kind: 'model', id: 'general/model', label: '模型' });
    expect(model.details).toContainEqual({ label: '模型 ID', value: 'video-model' });
    expect(JSON.stringify(model)).not.toMatch(/private-|never-expose|executionProfile/);
    expect(useAppStore.getState()).toBe(snapshot);
  });

  it('视频使用真实成片地址，只有封面时明确不可用', async () => {
    useAppStore.setState({ nodes: [node('video', 'source-video', { videoUrl: 'https://media.test/full.mp4',
      thumbnailUrl: 'https://media.test/thumb.jpg', prompt: longText }),
    node('unfinished', 'ai-video', { thumbnailUrl: 'https://media.test/thumb.jpg' }),
    node('file-url', 'source-video', { videoUrl: 'file:///unapproved/movie.mp4' }),
    node('credential-url', 'source-video', { videoUrl: 'https://user:secret@media.test/movie.mp4' })] });
    expect(await resolveReferencePreview({ kind: 'node', id: 'video', label: '视频' })).toMatchObject({
      kind: 'video', mediaUrl: 'https://media.test/full.mp4', prompt: longText,
    });
    const unfinished = await resolveReferencePreview({ kind: 'node', id: 'unfinished', label: '生成中' });
    expect(unfinished.unavailable).toBeTruthy();
    expect(unfinished.mediaUrl).toBeUndefined();
    for (const id of ['file-url', 'credential-url']) {
      expect((await resolveReferencePreview({ kind: 'node', id, label: '无效媒体' })).mediaUrl).toBeUndefined();
    }
  });

  it('按稳定 ID 只读指定镜头；宫格使用完整原图与同源百分比裁切，覆盖图不再裁切', async () => {
    useAppStore.setState({ nodes: [node('sheet', 'ai-shotlist', { shotlistRows: [
      { id: 'row', shotNo: '7', content: longText, dialogue: '小绘：先留着。', audio: '风声', duration: 5 },
      { id: 'other', shotNo: '8', content: '不应混入的另一镜' },
    ] }), node('grid', 'ai-storyboard', { imageUrl: 'https://media.test/full.png', thumbnailUrl: 'https://media.test/thumb.png',
      storyboardCols: 2, storyboardRows: 2, storyboardColPositions: [30], storyboardRowPositions: [40],
      storyboardOverrides: [null, { url: 'https://media.test/override.png' }] })] });
    const shot = await resolveReferencePreview({ kind: 'node', id: 'sheet/shot/row', label: '镜头' });
    expect(shot.text).toContain(longText);
    expect(shot.text).toContain('小绘：先留着。');
    expect(shot.text).not.toContain('不应混入');
    expect((await resolveReferencePreview({ kind: 'node', id: 'sheet', label: '整表' })).text).toContain('不应混入');
    expect(await resolveReferencePreview({ kind: 'node', id: 'grid/cell/2', label: '第3格' })).toMatchObject({
      kind: 'image', mediaUrl: 'https://media.test/full.png', imageCrop: { x: 0, y: 40, width: 30, height: 60 },
    });
    const overridden = await resolveReferencePreview({ kind: 'node', id: 'grid/cell/1', label: '第2格' });
    expect(overridden.mediaUrl).toBe('https://media.test/override.png');
    expect(overridden.imageCrop).toBeUndefined();
    expect((await resolveReferencePreview({ kind: 'node', id: 'sheet/shot/deleted', label: '已删镜头' })).unavailable).toBeTruthy();
  });

  it('库引用保留指定图与全部图身份，删除指定图不回退主图，全局不串读本项目节点', async () => {
    const asset = { ...character(), imageUrl: 'https://media.test/primary.png', imageNodeId: 'local',
      primaryReferenceImageId: 'one', referenceImages: [
        { id: 'one', kind: 'primary' as const, sourceNodeId: 'local', imageUrl: 'https://media.test/saved.png', prompt: longText, createdAt: 1, updatedAt: 1 },
        { id: 'two', kind: 'primary' as const, imageUrl: 'https://media.test/two.png', prompt: '', createdAt: 1, updatedAt: 1 },
      ] };
    useAppStore.setState({ nodes: [node('local', 'source-image', { imageUrl: 'https://media.test/live.png' })],
      dramaAssets: { version: 2, characters: [asset], scenes: [], props: [] }, globalCharacters: [asset] });
    const specified = await resolveReferencePreview({ kind: 'drama', id: 'character#one', label: '角色' });
    expect(specified).toMatchObject({ mediaUrl: 'https://media.test/live.png', prompt: longText });
    expect(specified.text).toContain(longText);
    const missing = await resolveReferencePreview({ kind: 'drama', id: 'character#deleted', label: '旧图' });
    expect(missing.unavailable).toBeTruthy();
    expect(missing.mediaUrl).toBeUndefined();
    const all = await resolveReferencePreview({ kind: 'drama', id: 'character#all', label: '全部' });
    expect(all.images?.map((image) => image.url)).toEqual(['https://media.test/live.png', 'https://media.test/two.png']);
    expect((await resolveReferencePreview({ kind: 'drama', id: 'global/character#one', label: '全局角色' })).mediaUrl)
      .toBe('https://media.test/saved.png');
  });

  it('声音保留完整台词，动作视频使用指定素材原视频，失效片段不换成其他素材', async () => {
    const asset: DramaCharacter = { ...character(), voiceClips: [{ id: 'voice', kind: 'line', transcript: longText,
      audioUrl: 'https://media.test/voice.wav', createdAt: 1, updatedAt: 1 }], actions: [{ id: 'action', name: '转身',
      category: 'custom', prompt: longText, media: [{ id: 'clip', kind: 'video', name: '转身.mp4', url: 'https://media.test/action.mp4', createdAt: 1, updatedAt: 1 }],
      createdAt: 1, updatedAt: 1 }] };
    useAppStore.setState({ dramaAssets: { version: 2, characters: [asset], scenes: [], props: [] } });
    expect(await resolveReferencePreview({ kind: 'drama', id: buildDramaVoiceMentionId(asset.id, 'voice'), label: '声音' }))
      .toMatchObject({ kind: 'audio', mediaUrl: 'https://media.test/voice.wav', text: longText });
    expect(await resolveReferencePreview({ kind: 'drama', id: buildDramaActionMentionId(asset.id, 'action', 'clip'), label: '动作' }))
      .toMatchObject({ kind: 'video', mediaUrl: 'https://media.test/action.mp4', prompt: longText });
    expect((await resolveReferencePreview({ kind: 'drama', id: buildDramaVoiceMentionId(asset.id, 'deleted'), label: '旧声音' })).mediaUrl)
      .toBeUndefined();
  });

  it('冷启动直接预览全局角色按需只读加载，保留指定图身份且不串读项目同名 ID', async () => {
    const global = { ...character(), name: '全局小绘', primaryReferenceImageId: 'one', referenceImages: [
      { id: 'one', kind: 'primary' as const, sourceNodeId: 'local', imageUrl: 'https://media.test/global.png', prompt: longText, createdAt: 1, updatedAt: 1 },
    ] };
    const project = { ...character(), imageUrl: 'https://media.test/project.png' };
    useAppStore.setState({ nodes: [node('local', 'source-image', { imageUrl: 'https://media.test/project-node.png' })],
      dramaAssets: { version: 2, characters: [project], scenes: [], props: [] }, globalCharacters: [] });
    vi.mocked(loadGlobalCharacterCards).mockResolvedValue([global]);
    const snapshot = useAppStore.getState();
    expect(await resolveReferencePreview({ kind: 'drama', id: 'global/character#one', label: '全局角色' }))
      .toMatchObject({ title: '全局小绘', mediaUrl: 'https://media.test/global.png', prompt: longText });
    expect(loadGlobalCharacterCards).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState()).toBe(snapshot);
    expect(useAppStore.getState().globalCharacters).toEqual([]);
    const missing = await resolveReferencePreview({ kind: 'drama', id: 'global/character#deleted', label: '指定旧图' });
    expect(missing.unavailable).toBeTruthy();
    expect(missing.mediaUrl).toBeUndefined();
    vi.mocked(loadGlobalCharacterCards).mockClear();
    expect((await resolveReferencePreview({ kind: 'drama', id: 'character', label: '项目角色' })).mediaUrl)
      .toBe('https://media.test/project.png');
    expect(loadGlobalCharacterCards).not.toHaveBeenCalled();
    useAppStore.setState({ globalCharacters: [global] });
    await resolveReferencePreview({ kind: 'drama', id: 'global/character#one', label: '全局角色' });
    expect(loadGlobalCharacterCards).not.toHaveBeenCalled();
  });

  it('全局角色临时读取完成后仍检查取消，缺失与读取失败不泄漏或回落项目角色', async () => {
    useAppStore.setState({ dramaAssets: { version: 2, characters: [character()], scenes: [], props: [] } });
    const source = { kind: 'drama' as const, id: 'global/character', label: '全局角色' };
    const missing = await resolveReferencePreview(source);
    expect(missing.unavailable).toBeTruthy();
    expect(missing.mediaUrl).toBeUndefined();
    let finish!: (characters: DramaCharacter[]) => void;
    vi.mocked(loadGlobalCharacterCards).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const snapshot = useAppStore.getState();
    const pending = resolveReferencePreview(source, { signal: controller.signal });
    controller.abort();
    finish([character()]);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(useAppStore.getState()).toBe(snapshot);
    const before = vi.mocked(loadGlobalCharacterCards).mock.calls.length;
    await expect(resolveReferencePreview(source, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(loadGlobalCharacterCards).toHaveBeenCalledTimes(before);
    vi.mocked(loadGlobalCharacterCards).mockRejectedValueOnce(new Error('private-global-path token=never-expose'));
    const failed = await resolveReferencePreview(source);
    expect(failed.unavailable).toBeTruthy();
    expect(JSON.stringify(failed)).not.toMatch(/private-global-path|never-expose/);
  });

  it('工作流优先读取胶囊当前值，空值不回落旧值，单个引用可查看实际媒体', async () => {
    useAppStore.setState({ nodes: [node('owner', 'ai-image', { workflowId: 'workflow', workflowInputs: { prompt: longText } }),
      node('image', 'source-image', { imageUrl: 'https://media.test/reference.png' })], workflows: [
      { id: 'workflow', name: '图像工作流', category: 'ai-image', fileName: 'workflow.json', fileContent: '{}', createdAt: 1,
        ioNodes: [{ nodeId: 'prompt', title: '文本输入', type: 'prompt' }] },
    ] });
    const source = { kind: 'workflow' as const, id: 'prompt', label: '文本输入', ownerNodeId: 'owner' };
    expect((await resolveReferencePreview(source)).text).toBe(longText);
    expect((await resolveReferencePreview({ ...source, value: '' })).text).toBe('');
    expect(await resolveReferencePreview({ ...source, value: '@{image:参考图}' })).toMatchObject({
      kind: 'image', title: '文本输入', mediaUrl: 'https://media.test/reference.png',
    });
  });

  it('素材正文从授权文件服务完整读取，异步读完成后仍检查取消，错误不泄漏原生路径', async () => {
    vi.mocked(readAssetTextFile).mockResolvedValue({ content: longText, digest: '', size: 1, modified: null, bom: false, newline: 'LF' });
    const source = { kind: 'asset' as const, id: 'authorized.md', label: '写作说明' };
    expect(await resolveReferencePreview(source)).toMatchObject({ kind: 'markdown', text: longText });
    let finish!: (snapshot: Awaited<ReturnType<typeof readAssetTextFile>>) => void;
    vi.mocked(readAssetTextFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = resolveReferencePreview(source, { signal: controller.signal });
    controller.abort();
    finish({ content: longText, digest: '', size: 1, modified: null, bom: false, newline: 'LF' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    vi.mocked(readAssetTextFile).mockRejectedValueOnce(new Error('private-native-path token=never-expose'));
    const failed = await resolveReferencePreview(source);
    expect(failed.unavailable).toBeTruthy();
    expect(JSON.stringify(failed)).not.toMatch(/private-native-path|never-expose/);
    await resolveReferencePreview({ kind: 'asset', id: 'F:/authorized.mp4', label: '成片' });
    expect(getAssetUrlFromPath).toHaveBeenCalledWith('F:/authorized.mp4');
  });

  it('助手参考图沿用当前项目或普通助手范围读取，预取消不触发任何文件读取', async () => {
    const source = { kind: 'chat-image' as const, id: 'chat-ref-00000000-0000-0000-0000-000000000000.png', label: '参考图' };
    useAppStore.setState({ currentProjectId: 'project' });
    expect((await resolveReferencePreview(source)).kind).toBe('image');
    expect(readChatImageReference).toHaveBeenLastCalledWith('project', source.id, undefined);
    useAppStore.setState({ currentProjectId: null });
    await resolveReferencePreview(source);
    expect(readChatImageReference).toHaveBeenLastCalledWith(GENERAL_ASSISTANT_SCOPE_ID, source.id, undefined);
    const before = vi.mocked(readChatImageReference).mock.calls.length;
    const controller = new AbortController();
    controller.abort();
    await expect(resolveReferencePreview(source, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(readChatImageReference).toHaveBeenCalledTimes(before);
  });
});
