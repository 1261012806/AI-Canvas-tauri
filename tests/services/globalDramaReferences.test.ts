import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DramaAsset, DramaCharacter, DramaProp, DramaScene } from '../../src/types/dramaAssets';
import { emptyDramaAssetLibrary } from '../../src/types/dramaAssets';
import { useAppStore } from '../../src/store/useAppStore';
import {
  findDramaAsset, listGlobalDramaAssets, preferDramaLibraryReferences,
  preferredDramaMentionForNode, resolveDramaAssetImageRef,
} from '../../src/services/dramaAssetPrompt';
import { resolveDramaMentionItems } from '../../src/components/nodes/shared/mentionEditorSources';
import { resolveDramaMentionPreview } from '../../src/components/nodes/shared/mentionEditorPreview';
import { resolvePromptToChatContent, resolvePromptWithMediaRefs } from '../../src/services/ai/promptResolver';
import { resolveNodeReferencesAsync } from '../../src/services/nodeReferenceService';
import { resolveReferencePreview } from '../../src/services/referencePreviewService';
import { videoInputFingerprint } from '../../src/services/videoBatchPlanning';

const mocks = vi.hoisted(() => ({ load: vi.fn<() => Promise<DramaAsset[]>>() }));
vi.mock('../../src/services/globalDramaAssetService', () => ({ loadGlobalDramaAssetCards: mocks.load }));

const sceneImage = 'data:image/png;base64,c2NlbmU=';
const otherImage = 'data:image/png;base64,b3RoZXI=';
const base = { key: 'asset', summary: '', visualNotes: '', importance: 'supporting' as const,
  confirmed: true, createdAt: 1, updatedAt: 1, source: 'manual' as const };
const scene = (patch: Partial<DramaScene> = {}): DramaScene => ({
  ...base, id: 'scene', name: '宫殿', kind: 'scene', imageUrl: sceneImage, ...patch,
});
const prop = (patch: Partial<DramaProp> = {}): DramaProp => ({
  ...base, id: 'prop', name: '玉玺', kind: 'prop', summary: '缺了一角的旧玉玺', ...patch,
});

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  mocks.load.mockReset().mockResolvedValue([]);
});

describe('全局人物、场景、道具引用消费', () => {
  it('候选与精确查找保留全局身份，音频入口只接受有声音的人物', () => {
    const character: DramaCharacter = { ...base, id: 'hero', name: '人物', kind: 'character', identity: '', voiceClips: [
      { id: 'voice', kind: 'timbre', audioUrl: 'voice.wav', transcript: '', createdAt: 1, updatedAt: 1 },
    ] };
    const assets = listGlobalDramaAssets({ globalCharacters: [character], globalScenes: [scene()], globalProps: [prop()] });
    const library = { ...emptyDramaAssetLibrary(), scenes: [scene({ name: '项目宫殿' })] };
    expect(findDramaAsset(library, 'scene', assets)?.name).toBe('项目宫殿');
    expect(findDramaAsset(library, 'global/scene', assets)).toMatchObject({ kind: 'scene', name: '宫殿' });
    expect(findDramaAsset(library, 'global/prop', assets)?.kind).toBe('prop');
    expect(findDramaAsset(library, 'prop', assets)).toBeUndefined();
    expect(resolveDramaMentionItems(library, 'global/', 'ai-image', assets).map((item) => item.id))
      .toEqual(['global/hero', 'global/scene', 'global/prop']);
    expect(resolveDramaMentionItems(library, '', 'ai-audio', assets).map((item) => item.id)).toEqual(['global/hero']);
  });

  it('冷引用可经文本、媒体和工作流展开，全局场景不串读同 ID 项目节点', async () => {
    mocks.load.mockResolvedValue([scene({ imageNodeId: 'local' }), prop()]);
    useAppStore.setState({
      dramaAssets: { ...emptyDramaAssetLibrary(), scenes: [scene({ summary: '无关项目设定', imageUrl: otherImage })] },
      nodes: [{ id: 'local', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', label: '项目图', imageUrl: otherImage } }],
    });
    const token = '@drama{global/scene:宫殿} @drama{global/prop:玉玺}';
    const snapshot = useAppStore.getState();
    const chat = await resolvePromptToChatContent(token);
    expect(chat.content).toContainEqual({ type: 'image_url', image_url: { url: sceneImage } });
    expect(chat.textContent).toContain('缺了一角的旧玉玺');
    expect(chat.textContent).not.toContain('无关项目设定');
    const media = await resolvePromptWithMediaRefs(token, { preserveBindings: true });
    expect(media.imageUrls).toEqual([sceneImage]);
    expect(media.segments?.filter((segment) => typeof segment !== 'string').every((segment) => !segment.character)).toBe(true);
    expect(await resolveNodeReferencesAsync(token)).toBe(`${sceneImage} 玉玺，缺了一角的旧玉玺`);
    expect(useAppStore.getState()).toBe(snapshot);
    expect(mocks.load).toHaveBeenCalled();
  });

  it('只读与悬浮预览支持场景和无图道具，不将它们当成有声音或动作的人物', async () => {
    const assets = [scene(), prop()];
    mocks.load.mockResolvedValue(assets);
    const library = emptyDramaAssetLibrary();
    expect(resolveDramaMentionPreview(library, assets, [], 'global/scene', '旧名称'))
      .toMatchObject({ label: '宫殿', thumbnailUrl: sceneImage, description: '全局创作资产库 · 场景参考图' });
    expect(resolveDramaMentionPreview(library, assets, [], 'global/prop', '旧名称'))
      .toMatchObject({ missing: false, description: '全局创作资产库 · 道具简介（暂无图片）' });
    expect(await resolveReferencePreview({ kind: 'drama', id: 'global/prop', label: '玉玺' }))
      .toMatchObject({ kind: 'markdown', title: '玉玺', text: expect.stringContaining('缺了一角') });
    await expect(resolvePromptWithMediaRefs('@drama{global/scene#voice/voice:宫殿}')).rejects.toThrow('音频引用已失效');
    await expect(resolvePromptWithMediaRefs('@drama{global/prop#action/action/media:玉玺}')).rejects.toThrow('动作素材引用已失效');
  });

  it('唯一图片优先项目库，多个全局卡片匹配时保留节点引用', () => {
    const nodes = [{ id: 'image', data: { type: 'ai-image', imageUrl: sceneImage } }];
    const library = emptyDramaAssetLibrary();
    expect(preferredDramaMentionForNode('image', nodes, library, [scene()])).toBe('@drama{global/scene:宫殿}');
    expect(preferDramaLibraryReferences('@{image:旧图}', nodes, library, [scene(), prop({ imageUrl: sceneImage })]))
      .toBe('@{image:旧图}');
    expect(preferredDramaMentionForNode('image', nodes, { ...library, props: [prop({ imageUrl: sceneImage })] }, [scene()]))
      .toBe('@drama{prop:玉玺}');
  });

  it('失效的指定参考图不会从人物主图或项目节点取得另一张图片', () => {
    const character: DramaCharacter = { ...base, id: 'global/hero', name: '人物', kind: 'character', identity: '',
      imageNodeId: 'local', imageUrl: otherImage, referenceImages: [
        { id: 'empty', kind: 'primary', imageUrl: '', prompt: '', createdAt: 1, updatedAt: 1 },
      ] };
    const nodes = [{ id: 'local', data: { imageUrl: otherImage } }];
    expect(resolveDramaAssetImageRef(character, nodes, 'deleted')).toBeNull();
    expect(resolveDramaAssetImageRef(character, nodes, 'empty')).toBeNull();
  });

  it('批次指纹捕获被引全局场景变化，忽略无关全局道具', () => {
    useAppStore.setState({ globalScenes: [scene()], globalProps: [prop()], nodes: [{ id: 'video', type: 'ai-video',
      position: { x: 0, y: 0 }, data: { type: 'ai-video', label: '视频', prompt: '@drama{global/scene:宫殿}' } }] });
    const first = useAppStore.getState();
    const original = videoInputFingerprint(first.nodes[0], first);
    useAppStore.setState({ globalProps: [prop({ summary: '无关变化' })] });
    const unrelated = useAppStore.getState();
    expect(videoInputFingerprint(unrelated.nodes[0], unrelated)).toBe(original);
    useAppStore.setState({ globalScenes: [scene({ imageUrl: otherImage })] });
    const changed = useAppStore.getState();
    expect(videoInputFingerprint(changed.nodes[0], changed)).not.toBe(original);
  });
});
