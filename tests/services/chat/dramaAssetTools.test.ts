import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerDramaAssetAgentTools } from '../../../src/services/chat/tools/dramaAssetTools';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import type { DramaAsset, DramaCharacter, DramaProp, DramaScene } from '../../../src/types/dramaAssets';
import { emptyDramaAssetLibrary } from '../../../src/types/dramaAssets';

function character(overrides: Partial<DramaCharacter> = {}): DramaCharacter {
  return {
    kind: 'character',
    id: 'char_1',
    key: '沈砚',
    name: '沈砚',
    identity: '刑警',
    summary: '沉默寡言的刑警',
    visualNotes: '短发、疤',
    voiceNotes: '低沉沙哑，语速偏慢',
    importance: 'main',
    confirmed: true,
    createdAt: 1,
    updatedAt: 2,
    source: 'manual',
    primaryVoiceClipId: 'voice-1',
    voiceClips: [{
      id: 'voice-1',
      kind: 'timbre',
      label: '低沉男声',
      audioUrl: 'asset:///project/data/voice.mp3',
      transcript: '你终于来了。',
      createdAt: 1,
      updatedAt: 2,
    }],
    ...overrides,
  };
}

function context(): AgentToolContext {
  return { projectId: 'p1' } as AgentToolContext;
}

function visualAsset(kind: 'scene' | 'prop', id = `${kind}-1`): DramaScene | DramaProp {
  const base = { id, key: '参考资产', name: '参考资产', summary: '供多个项目复用', visualNotes: '固定外观',
    importance: 'supporting' as const, confirmed: true, createdAt: 1, updatedAt: 2, source: 'manual' as const };
  return kind === 'scene' ? { ...base, kind, atmosphere: '雨夜' } : { ...base, kind, category: '信物' };
}

beforeEach(() => {
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'p1',
    projectLoadStatus: 'ready',
    saveCurrentProjectSilent: vi.fn(async () => 'p1'),
    dramaAssets: { ...emptyDramaAssetLibrary(), characters: [character()] },
    loadGlobalDramaAssets: vi.fn(async () => undefined),
  });
});

describe('drama asset agent tools', () => {
  function mediaNodes() {
    useAppStore.setState({ nodes: [
      { id: 'audio-1', type: 'source-audio', position: { x: 0, y: 0 }, data: {
        label: '参考声音', type: 'source-audio', audioUrl: 'asset:///private/voice.flac', assetId: 'audio-asset',
      } },
      { id: 'image-1', type: 'source-image', position: { x: 100, y: 0 }, data: {
        label: '全身图', type: 'source-image', imageUrl: 'asset:///private/image.png', assetId: 'image-asset',
      } },
    ] });
  }

  it('binds audio and image references to the requested character without changing the canvas', async () => {
    registerDramaAssetAgentTools();
    mediaNodes();
    const before = useAppStore.getState().nodes;
    const audio = getAgentTool('drama_voice_add')!;
    const image = getAgentTool('drama_reference_image_add')!;
    expect(audio.effect).toBe('asset_write');
    expect(image.effect).toBe('asset_write');
    const voiceResult = await audio.execute(context(), {
      assetId: 'char_1', nodeId: 'audio-1', label: '小满音色', transcript: '试听台词', makePrimary: true,
    });
    const imageResult = await image.execute(context(), { assetId: 'char_1', nodeId: 'image-1', kind: 'full_body', makePrimary: true });
    const voice = JSON.parse(voiceResult.modelContent);
    const reference = JSON.parse(imageResult.modelContent);
    expect(voiceResult.status).toBe('success');
    expect(imageResult.status).toBe('success');
    const card = useAppStore.getState().dramaAssets.characters[0];
    expect(card.voiceClips).toHaveLength(2);
    expect(card.primaryVoiceClipId).toBe(voice.clipId);
    expect(card.voiceClips?.find((clip) => clip.id === voice.clipId)).toMatchObject({
      sourceNodeId: 'audio-1', label: '小满音色', kind: 'timbre', transcript: '试听台词',
    });
    expect(card.primaryReferenceImageId).toBe(reference.referenceImageId);
    expect(voice.mention).toContain('#voice/');
    expect(reference.mention).toContain(`#${reference.referenceImageId}`);
    expect(voiceResult.modelContent + imageResult.modelContent).not.toContain('asset:///');
    expect(useAppStore.getState().nodes).toBe(before);
    const read = await getAgentTool('drama_asset_get')!.execute(context(), { assetId: 'char_1' });
    expect(JSON.parse(read.modelContent).referenceImages[0]).toMatchObject({ id: reference.referenceImageId, isPrimary: true });
  });

  it.each(['scene', 'prop'] as const)('binds an already generated %s image without copying media or changing the canvas', async (kind) => {
    registerDramaAssetAgentTools();
    mediaNodes();
    const result = await getAgentTool('drama_asset_upsert')!.execute(context(), { kind, name: '参考资产' });
    const assetId = JSON.parse(result.modelContent).id;
    const before = useAppStore.getState().nodes;
    const tool = getAgentTool('drama_reference_image_add')!;
    const input = { assetId, nodeId: 'image-1' };
    const bound = await tool.execute(context(), input);
    expect(bound.status).toBe('success');
    expect(JSON.parse(bound.modelContent)).toMatchObject({ assetId, kind, imageReady: true, reused: false,
      referenceImageId: 'mcp-image-p1-image-1', mention: `@drama{${assetId}#mcp-image-p1-image-1:参考资产}` });
    expect(useAppStore.getState().nodes).toBe(before);
    const read = await getAgentTool('drama_asset_get')!.execute(context(), { assetId });
    expect(JSON.parse(read.modelContent)).toMatchObject({ imageNodeId: 'image-1', imageReady: true });
    expect(JSON.parse((await tool.execute(context(), input)).modelContent).reused).toBe(true);
    expect(bound.modelContent + read.modelContent).not.toContain('asset:///');
    expect((await getAgentTool('drama_voice_add')!.execute(context(), { assetId, nodeId: 'audio-1' })).status).toBe('error');
    useAppStore.getState().syncDramaAssetImageFromNode('image-1', 'updated.png');
    const list = kind === 'scene' ? useAppStore.getState().dramaAssets.scenes : useAppStore.getState().dramaAssets.props;
    expect(list[0].imageUrl).toBe('updated.png');
  });

  it.each(['drama_voice_add', 'drama_reference_image_add'])('reuses %s media and rejects wrong types, missing roles and stale projects', async (id) => {
    registerDramaAssetAgentTools();
    mediaNodes();
    const tool = getAgentTool(id)!;
    const nodeId = id === 'drama_voice_add' ? 'audio-1' : 'image-1';
    const input = { assetId: 'char_1', nodeId };
    const first = JSON.parse((await tool.execute(context(), input)).modelContent);
    const second = JSON.parse((await tool.execute(context(), input)).modelContent);
    expect(second).toEqual({ ...first, reused: true });
    const card = useAppStore.getState().dramaAssets.characters[0];
    expect(id === 'drama_voice_add' ? card.voiceClips : card.referenceImages).toHaveLength(id === 'drama_voice_add' ? 2 : 1);
    expect((await tool.execute(context(), { ...input, nodeId: nodeId === 'audio-1' ? 'image-1' : 'audio-1' })).status).toBe('error');
    expect((await tool.execute(context(), { ...input, nodeId: 'absent' })).status).toBe('error');
    expect((await tool.execute(context(), { ...input, assetId: 'absent' })).status).toBe('error');
    expect((await tool.execute({ ...context(), projectId: 'other' }, input)).status).toBe('error');
    expect((await tool.execute({ ...context(), baseRevision: -1 }, input)).status).toBe('error');
    const abort = new AbortController();
    abort.abort();
    expect((await tool.execute({ ...context(), signal: abort.signal }, input)).status).toBe('error');
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((node) => ({
      ...node, data: { ...node.data, audioUrl: undefined, imageUrl: undefined, thumbnailUrl: undefined },
    })) });
    expect((await tool.execute(context(), input)).status).toBe('error');
    expect(tool.authorize?.({ ...context(), projectId: 'other' }, { ...input, scope: 'global' })).toMatchObject({ allowed: false });
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).not.toHaveProperty('path');
    expect(tool.inputSchema.properties).not.toHaveProperty('audioUrl');
  });

  it.each(['drama_voice_add', 'drama_reference_image_add'])('supports global %s without project node IDs and reports save failure', async (id) => {
    registerDramaAssetAgentTools();
    mediaNodes();
    // 没有素材索引 ID 的节点也必须幂等，不能只依赖 assetId 去重。
    useAppStore.setState({ nodes: useAppStore.getState().nodes.map((node) => ({
      ...node, data: { ...node.data, assetId: undefined },
    })) });
    useAppStore.setState({ globalCharacters: [character({ id: 'global-1', voiceClips: [] })] });
    const save = vi.fn(async (_scope, card: DramaCharacter) => {
      useAppStore.setState({ globalCharacters: [card] });
      return true;
    });
    useAppStore.setState({ saveCharacterCard: save });
    const tool = getAgentTool(id)!;
    const input = { scope: 'global', assetId: 'global-1', nodeId: id === 'drama_voice_add' ? 'audio-1' : 'image-1' };
    expect((await tool.execute(context(), input)).status).toBe('success');
    expect(JSON.parse((await tool.execute(context(), input)).modelContent).reused).toBe(true);
    const card = useAppStore.getState().globalCharacters[0];
    const media = id === 'drama_voice_add' ? card.voiceClips : card.referenceImages;
    expect(media).toHaveLength(1);
    expect(media?.[0].sourceNodeId).toBeUndefined();
    const read = await getAgentTool('drama_asset_get')!.execute(context(), { scope: 'global', assetId: 'global-1' });
    expect(JSON.parse(read.modelContent).mention).toBe('@drama{global/global-1:沈砚}');
    expect(JSON.parse((await tool.execute(context(), input)).modelContent).mention).toContain('@drama{global/global-1#');
    expect(useAppStore.getState().dramaAssets.characters[0].referenceImages).toBeUndefined();
    save.mockResolvedValueOnce(false);
    expect((await tool.execute(context(), input)).status).toBe('error');
    save.mockRejectedValueOnce(new Error('private-path-that-must-not-leak'));
    const failed = await tool.execute(context(), input);
    expect(failed.status).toBe('error');
    expect(failed.modelContent).not.toContain('private-path');
  });

  it('lists assets as read-only with mention strings and voice availability', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_list');

    expect(definition?.effect).toBe('read');
    const result = await definition!.execute(context(), {});
    const payload = JSON.parse(result.modelContent ?? '{}');

    expect(result.status).toBe('success');
    expect(payload.assets).toEqual([expect.objectContaining({
      id: 'char_1',
      kind: 'character',
      name: '沈砚',
      mention: '@drama{char_1:沈砚}',
      voiceClipCount: 1,
      hasVoice: true,
      imageReady: false,
    })]);
    unregisters.forEach((unregister) => unregister());
  });

  it('returns the full brief including voice notes and clips', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_get');

    const result = await definition!.execute(context(), { assetId: 'char_1' });
    const payload = JSON.parse(result.modelContent ?? '{}');

    expect(payload.brief).toContain('声音：低沉沙哑，语速偏慢');
    expect(payload.voiceClips).toEqual([expect.objectContaining({
      id: 'voice-1',
      isPrimary: true,
      transcript: '你终于来了。',
    })]);
    unregisters.forEach((unregister) => unregister());
  });

  it('refuses to read assets from another project', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_list');

    expect(definition?.authorize?.({ projectId: 'other' } as AgentToolContext, {}))
      .toEqual(expect.objectContaining({ allowed: false }));
    unregisters.forEach((unregister) => unregister());
  });

  it('creates a project asset behind the asset_write approval', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_upsert')!;

    expect(definition.effect).toBe('asset_write');
    const result = await definition.execute(context(), {
      kind: 'scene',
      name: '雨夜天台',
      summary: '决战发生地',
      timeOfDay: '深夜',
    });
    const payload = JSON.parse(result.modelContent ?? '{}');
    const created = useAppStore.getState().dramaAssets.scenes[0];

    expect(result.status).toBe('success');
    expect(created).toMatchObject({
      kind: 'scene',
      name: '雨夜天台',
      timeOfDay: '深夜',
      source: 'manual',
    });
    expect(payload.mention).toBe(`@drama{${created.id}:雨夜天台}`);
    unregisters.forEach((unregister) => unregister());
  });

  it('rejects fields that belong to another asset kind and unknown ids', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_upsert')!;

    const crossKind = await definition.execute(context(), {
      kind: 'scene',
      name: '天台',
      identity: '刑警',
    });
    expect(crossKind.status).toBe('error');
    expect(crossKind.summary).toContain('identity');

    const missing = await definition.execute(context(), { kind: 'scene', assetId: 'scene-nope' });
    expect(missing.status).toBe('error');
    expect(useAppStore.getState().dramaAssets.scenes).toHaveLength(0);
    unregisters.forEach((unregister) => unregister());
  });

  it('patches an existing character without dropping its voice clips', async () => {
    const unregisters = registerDramaAssetAgentTools();

    const result = await getAgentTool('drama_asset_upsert')!.execute(context(), {
      kind: 'character',
      assetId: 'char_1',
      wardrobeDefault: '黑色风衣',
    });
    const updated = useAppStore.getState().dramaAssets.characters[0];

    expect(result.status).toBe('success');
    expect(updated.wardrobeDefault).toBe('黑色风衣');
    // 参考图 / 音色片段不在工具的字段范围里，改设定不能把它们冲掉
    expect(updated.voiceClips).toHaveLength(1);
    expect(updated.summary).toBe('沉默寡言的刑警');
    unregisters.forEach((unregister) => unregister());
  });

  it('deletes assets as a permanent delete', async () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_delete')!;

    expect(definition.effect).toBe('permanent_delete');
    const result = await definition.execute(context(), { assetId: 'char_1' });

    expect(result.status).toBe('success');
    expect(useAppStore.getState().dramaAssets.characters).toHaveLength(0);
    unregisters.forEach((unregister) => unregister());
  });

  it('allows all global creative asset kinds without granting access to another project', () => {
    const unregisters = registerDramaAssetAgentTools();
    const definition = getAgentTool('drama_asset_upsert')!;

    for (const kind of ['character', 'scene', 'prop']) {
      expect(definition.authorize?.(
        { projectId: 'other' } as AgentToolContext,
        { scope: 'global', kind, name: '全局资产' },
      )).toEqual(expect.objectContaining({ allowed: true }));
      expect(definition.authorize?.(
        { projectId: 'other' } as AgentToolContext,
        { scope: 'project', kind, name: '其他项目资产' },
      )).toEqual(expect.objectContaining({ allowed: false }));
    }
    unregisters.forEach((unregister) => unregister());
  });

  it('loads the complete global library before listing or reading and preserves scoped identities', async () => {
    registerDramaAssetAgentTools();
    const scene = { ...visualAsset('scene'), imageUrl: 'asset:///global/scene.png', imageAssetId: 'scene-image' } as DramaScene;
    const prop = visualAsset('prop') as DramaProp;
    const load = vi.fn(async () => {
      useAppStore.setState({ globalCharacters: [character()], globalScenes: [scene], globalProps: [prop] });
    });
    useAppStore.setState({ loadGlobalDramaAssets: load,
      dramaAssets: { ...emptyDramaAssetLibrary(), scenes: [{ ...scene, name: '项目场景', imageUrl: undefined }] } });
    const list = getAgentTool('drama_asset_list')!;
    const all = JSON.parse((await list.execute(context(), { scope: 'global' })).modelContent);
    expect(load).toHaveBeenCalledOnce();
    expect(all.assets.map((asset: { kind: string }) => asset.kind)).toEqual(['character', 'scene', 'prop']);
    expect(all.assets[0].mention).toBe('@drama{global/char_1:沈砚}');
    expect(all.assets[1]).toMatchObject({ id: scene.id, imageReady: true, mention: `@drama{global/${scene.id}:参考资产}` });
    const filtered = JSON.parse((await list.execute(context(), { scope: 'global', kind: 'prop' })).modelContent);
    expect(filtered.assets).toHaveLength(1);
    expect(filtered.assets[0].id).toBe(prop.id);
    const read = await getAgentTool('drama_asset_get')!.execute(context(), { scope: 'global', assetId: scene.id });
    expect(JSON.parse(read.modelContent)).toMatchObject({ kind: 'scene', name: '参考资产', imageReady: true, voiceClips: [] });
    expect(read.modelContent).toContain('氛围：雨夜');
    expect(read.modelContent).not.toContain('imageNodeId');
    expect(read.modelContent).not.toContain('asset:///');
    expect(useAppStore.getState().dramaAssets.scenes[0].name).toBe('项目场景');
  });

  it.each(['scene', 'prop'] as const)('saves global %s metadata through its own persistence without character conversion', async (kind) => {
    registerDramaAssetAgentTools();
    const asset = { ...visualAsset(kind), imageAssetId: 'stable-image', imageRelativePath: 'Library/image.png', imageUrl: 'global.png' };
    const save = vi.fn(async (_asset: DramaAsset) => true);
    const projectSave = vi.fn();
    useAppStore.setState({ globalScenes: kind === 'scene' ? [asset as DramaScene] : [],
      globalProps: kind === 'prop' ? [asset as DramaProp] : [], saveGlobalDramaAsset: save, upsertDramaAsset: projectSave });
    const before = useAppStore.getState().dramaAssets;
    const tool = getAgentTool('drama_asset_upsert')!;
    const result = await tool.execute(context(), { scope: 'global', kind, assetId: asset.id, summary: '更新设定' });
    expect(result.status).toBe('success');
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind, id: asset.id, summary: '更新设定',
      imageAssetId: 'stable-image', imageRelativePath: 'Library/image.png', imageUrl: 'global.png' }),
    { signal: undefined, assertCurrent: expect.any(Function) });
    const saved = save.mock.calls[0][0];
    expect(saved).not.toHaveProperty('identity');
    expect(saved).not.toHaveProperty('referenceImages');
    expect(saved).not.toHaveProperty('voiceClips');
    expect(projectSave).not.toHaveBeenCalled();
    expect(useAppStore.getState().dramaAssets).toBe(before);
    expect(JSON.parse(result.modelContent).mention).toBe(`@drama{global/${asset.id}:参考资产}`);
    const created = await tool.execute(context(), { scope: 'global', kind, name: '新资产' });
    expect(created.status).toBe('success');
    expect(JSON.parse(created.modelContent)).toMatchObject({ kind, created: true, scope: 'global' });
    expect(save.mock.calls[1][0]).toMatchObject({ kind, name: '新资产', source: 'manual' });
    expect(save.mock.calls[1][0]).not.toHaveProperty('identity');
    save.mockResolvedValueOnce(false);
    expect((await tool.execute(context(), { scope: 'global', kind, name: '保存失败资产' })).status).toBe('error');
    expect((await tool.execute(context(), { scope: 'global', kind, assetId: 'absent', summary: '更新' })).status).toBe('error');
    expect((await tool.execute(context(), { scope: 'global', kind: kind === 'scene' ? 'prop' : 'scene', assetId: asset.id, summary: '改类型' })).status).toBe('error');
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('preserves global character voices and actions when editing through the unified asset tool', async () => {
    registerDramaAssetAgentTools();
    const card = character({ actions: [{ id: 'action/1', name: '走路', category: 'walking', prompt: '缓慢行走', createdAt: 1, updatedAt: 1,
      media: [{ id: 'media/1', kind: 'video', name: '走路正面', url: 'asset:///private/action.mp4', filePath: 'private-action-file',
        relativePath: 'internal/action.mp4', createdAt: 1, updatedAt: 1 }] }] });
    const save = vi.fn(async (_asset: DramaAsset) => true);
    useAppStore.setState({ globalCharacters: [card], saveGlobalDramaAsset: save });
    const result = await getAgentTool('drama_asset_upsert')!.execute(context(),
      { scope: 'global', kind: 'character', assetId: card.id, wardrobeDefault: '黑色风衣' });
    expect(result.status).toBe('success');
    expect(save.mock.calls[0][0]).toMatchObject({ kind: 'character', wardrobeDefault: '黑色风衣',
      identity: card.identity, voiceClips: card.voiceClips, actions: card.actions });
    expect(JSON.parse(result.modelContent).mention).toBe('@drama{global/char_1:沈砚}');
    const listed = JSON.parse((await getAgentTool('drama_asset_list')!.execute(context(), { scope: 'global' })).modelContent);
    expect(listed.assets[0]).toMatchObject({ voiceClipCount: 1, actionCount: 1 });
    const read = await getAgentTool('drama_asset_get')!.execute(context(), { scope: 'global', assetId: card.id });
    const payload = JSON.parse(read.modelContent);
    expect(payload.voiceClips[0]).toMatchObject({ id: 'voice-1', transcript: '你终于来了。',
      mention: '@drama{global/char_1#voice/voice-1:沈砚}' });
    expect(payload.actions).toEqual([{ id: 'action/1', name: '走路', category: 'walking', prompt: '缓慢行走',
      media: [{ id: 'media/1', kind: 'video', name: '走路正面', mention: '@drama{global/char_1#action/action%2F1/media%2F1:沈砚}' }] }]);
    expect(read.modelContent).not.toContain('asset:///');
    expect(read.modelContent).not.toContain('private-action-file');
    expect(read.modelContent).not.toContain('relativePath');
  });

  it.each(['scene', 'prop'] as const)('deletes the global %s card without deleting a same-ID project asset', async (kind) => {
    registerDramaAssetAgentTools();
    const asset = visualAsset(kind);
    const remove = vi.fn(async () => true);
    const projectRemove = vi.fn();
    useAppStore.setState({ globalScenes: kind === 'scene' ? [asset as DramaScene] : [],
      globalProps: kind === 'prop' ? [asset as DramaProp] : [], deleteGlobalDramaAsset: remove, deleteDramaAsset: projectRemove,
      dramaAssets: { ...emptyDramaAssetLibrary(), scenes: kind === 'scene' ? [{ ...asset, name: '项目场景' } as DramaScene] : [],
        props: kind === 'prop' ? [{ ...asset, name: '项目道具' } as DramaProp] : [] } });
    const before = useAppStore.getState().dramaAssets;
    const tool = getAgentTool('drama_asset_delete')!;
    expect(tool.effect).toBe('permanent_delete');
    expect((await tool.execute(context(), { scope: 'global', assetId: asset.id })).status).toBe('success');
    expect(remove).toHaveBeenCalledWith(kind, asset.id, { signal: undefined, assertCurrent: expect.any(Function) });
    expect(projectRemove).not.toHaveBeenCalled();
    expect(useAppStore.getState().dramaAssets).toBe(before);
    remove.mockResolvedValueOnce(false);
    expect((await tool.execute(context(), { scope: 'global', assetId: asset.id })).status).toBe('error');
  });

  it.each(['scene', 'prop'] as const)('binds global %s images using guarded global media persistence and rejects audio', async (kind) => {
    registerDramaAssetAgentTools();
    mediaNodes();
    const asset = visualAsset(kind);
    const addReference = vi.fn<ReturnType<typeof useAppStore.getState>['addDramaAssetReferenceImage']>(
      async (_scope, _kind, _assetId, _reference, options) => { options?.assertCurrent?.(); return true; },
    );
    const projectBind = vi.fn();
    useAppStore.setState({ globalScenes: kind === 'scene' ? [asset as DramaScene] : [],
      globalProps: kind === 'prop' ? [asset as DramaProp] : [], addDramaAssetReferenceImage: addReference, bindDramaAssetImage: projectBind });
    const before = useAppStore.getState().nodes;
    const signal = new AbortController().signal;
    const tool = getAgentTool('drama_reference_image_add')!;
    const input = { scope: 'global', assetId: asset.id, nodeId: 'image-1' };
    const result = await tool.execute({ ...context(), signal }, input);
    expect(result.status).toBe('success');
    expect(addReference).toHaveBeenCalledWith('global', kind, asset.id, expect.objectContaining({
      id: 'mcp-image-p1-image-1', sourceNodeId: 'image-1', assetId: 'image-asset', imageUrl: 'asset:///private/image.png',
    }), { signal, assertCurrent: expect.any(Function), makePrimary: undefined });
    expect(JSON.parse(result.modelContent)).toMatchObject({ kind, scope: 'global', imageReady: true,
      referenceImageId: 'mcp-image-p1-image-1', mention: `@drama{global/${asset.id}#mcp-image-p1-image-1:参考资产}` });
    expect(result.modelContent).not.toContain('asset:///');
    expect(projectBind).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes).toBe(before);
    expect((await getAgentTool('drama_voice_add')!.execute(context(), { ...input, nodeId: 'audio-1' })).status).toBe('error');
    addReference.mockResolvedValueOnce(false);
    expect((await tool.execute(context(), input)).status).toBe('error');
    addReference.mockRejectedValueOnce(new Error('private-path-must-not-leak'));
    const failed = await tool.execute(context(), input);
    expect(failed.status).toBe('error');
    expect(failed.modelContent).not.toContain('private-path');
  });

  it.each(['project', 'revision', 'cancel'] as const)('rejects a global image bind when %s changes while loading the library', async (change) => {
    registerDramaAssetAgentTools();
    mediaNodes();
    const asset = visualAsset('scene') as DramaScene;
    const controller = new AbortController();
    let revision = useAppStore.getState().getCurrentRevision();
    const addReference = vi.fn(async () => true);
    useAppStore.setState({ globalScenes: [asset], addDramaAssetReferenceImage: addReference, getCurrentRevision: () => revision,
      loadGlobalDramaAssets: vi.fn(async () => {
        if (change === 'project') useAppStore.setState({ currentProjectId: 'other' });
        if (change === 'revision') revision += 1;
        if (change === 'cancel') controller.abort();
      }) });
    const result = await getAgentTool('drama_reference_image_add')!.execute({ ...context(), baseRevision: revision, signal: controller.signal },
      { scope: 'global', assetId: asset.id, nodeId: 'image-1' });
    expect(result.status).toBe('error');
    expect(addReference).not.toHaveBeenCalled();
  });

  it('passes a live task guard to prevent committing after media persistence changes the canvas', async () => {
    registerDramaAssetAgentTools();
    mediaNodes();
    const asset = visualAsset('scene') as DramaScene;
    const commit = vi.fn();
    const addReference = vi.fn<ReturnType<typeof useAppStore.getState>['addDramaAssetReferenceImage']>(async (_scope, _kind, _assetId, _reference, options) => {
      useAppStore.setState({ currentProjectId: 'other' });
      options?.assertCurrent?.();
      commit();
      return true;
    });
    useAppStore.setState({ globalScenes: [asset], addDramaAssetReferenceImage: addReference });
    const result = await getAgentTool('drama_reference_image_add')!.execute(context(),
      { scope: 'global', assetId: asset.id, nodeId: 'image-1' });
    expect(result.status).toBe('error');
    expect(addReference).toHaveBeenCalledWith('global', 'scene', asset.id, expect.any(Object),
      expect.objectContaining({ assertCurrent: expect.any(Function) }));
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'drama_asset_list', input: {} },
    { id: 'drama_asset_get', input: { assetId: 'char_1' } },
    { id: 'drama_asset_upsert', input: { kind: 'character', assetId: 'char_1', summary: '更新' } },
    { id: 'drama_asset_delete', input: { assetId: 'char_1' } },
    { id: 'drama_voice_update', input: { assetId: 'char_1', clipId: 'voice-1', label: '更新' } },
    { id: 'drama_voice_set_primary', input: { assetId: 'char_1', clipId: 'voice-1' } },
    { id: 'drama_voice_delete', input: { assetId: 'char_1', clipId: 'voice-1' } },
  ])('rechecks the project after the scope-loading await in $id', async ({ id, input }) => {
    registerDramaAssetAgentTools();
    const save = vi.fn(async () => true);
    const remove = vi.fn();
    const voice = vi.fn(async () => true);
    useAppStore.setState({ saveCharacterCard: save, deleteDramaAsset: remove,
      updateCharacterVoiceClip: voice, setCharacterPrimaryVoice: voice, removeCharacterVoiceClip: voice });
    const execution = getAgentTool(id)!.execute(context(), input);
    useAppStore.setState({ currentProjectId: 'other',
      dramaAssets: { ...emptyDramaAssetLibrary(), characters: [character({ name: '其他项目人物' })] } });
    const result = await execution;
    expect(result.status).toBe('error');
    expect(result.modelContent).not.toContain('其他项目人物');
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(voice).not.toHaveBeenCalled();
    expect(useAppStore.getState().dramaAssets.characters[0].name).toBe('其他项目人物');
  });

  it.each(['drama_asset_list', 'drama_asset_get', 'drama_asset_upsert', 'drama_asset_delete'])(
    'rejects cancellation during global loading before %s reads or mutates a card', async (id) => {
      registerDramaAssetAgentTools();
      const controller = new AbortController();
      const save = vi.fn(async () => true);
      const remove = vi.fn(async () => true);
      useAppStore.setState({ globalCharacters: [character()], saveGlobalDramaAsset: save, deleteGlobalDramaAsset: remove,
        loadGlobalDramaAssets: vi.fn(async () => { controller.abort(); }) });
      const input = id === 'drama_asset_upsert' ? { scope: 'global', kind: 'character', assetId: 'char_1', summary: '更新' }
        : id === 'drama_asset_list' ? { scope: 'global' } : { scope: 'global', assetId: 'char_1' };
      const result = await getAgentTool(id)!.execute({ ...context(), signal: controller.signal }, input);
      expect(result.status).toBe('error');
      expect(result.modelContent).toContain('取消');
      expect(save).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it('keeps global metadata independent of the project changed during library loading', async () => {
    registerDramaAssetAgentTools();
    const save = vi.fn(async () => true);
    useAppStore.setState({ globalCharacters: [character()], saveGlobalDramaAsset: save,
      loadGlobalDramaAssets: vi.fn(async () => { useAppStore.setState({ currentProjectId: 'other' }); }) });
    const result = await getAgentTool('drama_asset_upsert')!.execute(context(),
      { scope: 'global', kind: 'character', assetId: 'char_1', summary: '跨项目共用设定' });
    expect(result.status).toBe('success');
    expect(save).toHaveBeenCalledOnce();
  });

  it('passes cancellation through the global delete action before its transaction commits', async () => {
    registerDramaAssetAgentTools();
    const controller = new AbortController();
    const commit = vi.fn();
    const remove = vi.fn(async (_kind, _id, options) => {
      await Promise.resolve();
      controller.abort();
      try { options.assertCurrent(); } catch { return false; }
      commit();
      return true;
    });
    useAppStore.setState({ globalCharacters: [character()], deleteGlobalDramaAsset: remove });
    const result = await getAgentTool('drama_asset_delete')!.execute({ ...context(), signal: controller.signal },
      { scope: 'global', assetId: 'char_1' });
    expect(result.status).toBe('error');
    expect(commit).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('character', 'char_1', { signal: controller.signal, assertCurrent: expect.any(Function) });
  });

  it('guards project character saving through the asynchronous persistence boundary', async () => {
    registerDramaAssetAgentTools();
    const commit = vi.fn();
    const save = vi.fn(async (_scope, _card, options) => {
      useAppStore.setState({ currentProjectId: 'other' });
      try { options.assertCurrent(); } catch { return false; }
      commit();
      return true;
    });
    useAppStore.setState({ saveCharacterCard: save });
    const result = await getAgentTool('drama_asset_upsert')!.execute(context(),
      { kind: 'character', assetId: 'char_1', summary: '不能写入其他项目' });
    expect(result.status).toBe('error');
    expect(commit).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith('project', expect.objectContaining({ id: 'char_1' }),
      { signal: undefined, assertCurrent: expect.any(Function) });
  });
});
