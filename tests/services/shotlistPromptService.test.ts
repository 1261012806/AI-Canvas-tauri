import { describe, expect, it } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import { buildShotlistRowMentionId, parseShotlistRowMentionId } from '../../src/types/shotlist';
import { expandShotlistRowMentions, resolveSingleShotlistRowReference } from '../../src/services/shotlistPromptService';
import { useAppStore } from '../../src/store/useAppStore';
import { resolvePromptToChatContent, resolvePromptWithMediaRefs } from '../../src/services/ai/promptResolver';
import { resolveNodeReferences } from '../../src/services/nodeReferenceService';

const sheet = (): { id: string; data: BaseNodeData } => ({ id: 'sheet', data: {
  type: 'ai-shotlist', label: '本集分镜', shotlistRows: [
    { id: 'stable-row', shotNo: '1', shotSize: '近景', camera: '缓慢推近', content: '她放下杯子。@drama{character:小绘}',
      dialogue: '小绘：先别删。', audio: '杯子轻响，音乐渐弱', duration: 4, note: '保持同一空间',
      frame: { nodeId: 'frame', kind: 'image' } },
    { id: 'other-row', shotNo: '2', content: '另一个镜头，不应展开' },
  ],
} });
const frame: { id: string; data: BaseNodeData } = { id: 'frame', data: {
  type: 'source-image', label: '桌面', imageUrl: 'private-image-url', filePath: 'private-file-path',
} };
const mention = '@{sheet/shot/stable-row:本集分镜·第1镜}';

describe('分镜表精确镜头提示词', () => {
  it('只融合所选镜头并保留额外要求和真实素材引用，不复制路径或整表', () => {
    const result = expandShotlistRowMentions(`${mention}\n补充：保持暖光`, [sheet(), frame]);
    for (const value of ['景别：近景', '运镜：缓慢推近', '她放下杯子', '小绘：先别删。', '杯子轻响', '镜头时长：4秒', '保持同一空间', '补充：保持暖光']) {
      expect(result).toContain(value);
    }
    expect(result).toContain('@drama{character:小绘}');
    expect(result).toContain('@{frame:桌面}');
    expect(result).not.toMatch(/另一个镜头|private-/);
    expect(expandShotlistRowMentions(`@{sheet:整表} ${mention}\n保持暖光`, [sheet(), frame])).not.toContain('另一个镜头');
  });

  it('按稳定 ID 读取最新内容，重排和改镜号不串镜，实际视频时长可覆盖计划时长', () => {
    const node = sheet();
    node.data.shotlistRows = [node.data.shotlistRows![1], { ...node.data.shotlistRows![0], shotNo: '7', dialogue: '小绘：留着吧。' }];
    const result = expandShotlistRowMentions(mention, [node, frame], { durationSeconds: 12 });
    expect(result).toContain('镜头：7');
    expect(result).toContain('小绘：留着吧。');
    expect(result).toContain('镜头时长：12秒');
    expect(result).not.toContain('镜头时长：4秒');
  });

  it('成片回填不会把自己的视频当输入，缺失或未就绪参考图片明确报错', () => {
    const node = sheet();
    node.data.shotlistRows![0].frame = { nodeId: 'made-video', kind: 'video' };
    expect(expandShotlistRowMentions(mention, [node])).not.toContain('made-video');
    node.data.shotlistRows![0].frame = { nodeId: 'missing-image', kind: 'image' };
    expect(() => expandShotlistRowMentions(mention, [node])).toThrow('参考图片');
    expect(() => expandShotlistRowMentions(mention, [sheet(), { ...frame, data: { ...frame.data, imageUrl: '' } }])).toThrow('尚未就绪');
  });

  it('删表、删镜、循环和畸形 ID 不会退化成整表或静默漏引用', () => {
    expect(() => expandShotlistRowMentions(mention, [])).toThrow('已删除');
    expect(() => expandShotlistRowMentions('@{sheet/shot/missing:不存在}', [sheet()])).toThrow('已删除');
    expect(() => expandShotlistRowMentions('@{sheet/shot/%ZZ:坏编码}', [sheet()])).toThrow('格式无效');
    const node = sheet();
    node.data.shotlistRows![0].frame = null;
    node.data.shotlistRows![0].content = mention;
    expect(() => expandShotlistRowMentions(mention, [node])).toThrow('循环');
    node.data.shotlistRows![0].content = '@{sheet:所属整表}';
    expect(() => expandShotlistRowMentions(mention, [node])).toThrow('循环');
    expect(() => expandShotlistRowMentions('@{sheet/shot/stable-row}', [node])).toThrow('格式无效');
  });

  it('标识支持编码、空展示标签和重复同镜引用，多镜不猜时长来源', () => {
    const id = buildShotlistRowMentionId('sheet', 'row/含:标记');
    expect(parseShotlistRowMentionId(id)).toEqual({ nodeId: 'sheet', rowId: 'row/含:标记' });
    expect(resolveSingleShotlistRowReference(`${mention} ${mention}`, [sheet()])).toMatchObject({ nodeId: 'sheet', rowId: 'stable-row' });
    expect(resolveSingleShotlistRowReference(`${mention} @{sheet/shot/other-row:2}`, [sheet()])).toBeUndefined();
    expect(expandShotlistRowMentions('@{sheet/shot/stable-row:}', [sheet(), frame])).toContain('运镜：缓慢推近');
    expect(expandShotlistRowMentions('普通 /shot/ 说明', [])).toBe('普通 /shot/ 说明');
  });

  it('视频、对话和旧工作流解析同一镜时，保留库图与节点图的顺序且不带入其他镜头', async () => {
    // 内联图片不产生文件读取、下载或上传，三条路径均使用真实解析器。
    const urls = { character: 'data:image/png;base64,Y2hhcmFjdGVy', frame: 'data:image/png;base64,ZnJhbWU=',
      other: 'data:image/png;base64,b3RoZXI=' };
    const source = sheet();
    source.data.shotlistRows![0].content = '@drama{character:小绘} 放下杯子，桌面构图参考 @{frame:桌面}。';
    source.data.shotlistRows![1].content = '另一个镜头不应展开 @{other-image:别的画面}';
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ currentProjectId: 'episode', nodes: [
      { ...source, type: 'ai-shotlist', position: { x: 0, y: 0 } },
      { id: 'frame', type: 'source-image', position: { x: 0, y: 0 },
        data: { type: 'source-image', label: '桌面', imageUrl: urls.frame } },
      { id: 'character-image', type: 'source-image', position: { x: 0, y: 0 },
        data: { type: 'source-image', label: '小绘参考', imageUrl: urls.character } },
      { id: 'other-image', type: 'source-image', position: { x: 0, y: 0 },
        data: { type: 'source-image', label: '别的画面', imageUrl: urls.other } },
    ], dramaAssets: { version: 2, scenes: [], props: [], characters: [
      { id: 'character', kind: 'character', name: '小绘', key: '小绘', identity: '女主角', summary: '', visualNotes: '',
        importance: 'main', confirmed: true, createdAt: 1, updatedAt: 1, source: 'manual', imageNodeId: 'character-image' },
    ] } });

    const video = await resolvePromptWithMediaRefs(`${mention}\n补充：暖光`, { preserveBindings: true });
    expect(video.imageUrls).toEqual([urls.character, urls.frame]);
    expect(video.references.map((reference) => reference.sourceNodeId)).toEqual(['character-image', 'frame']);
    const boundUrls = video.segments?.flatMap((segment) => typeof segment === 'string' ? [] : [segment.reference.url]);
    expect(boundUrls).toEqual([urls.character, urls.frame]);
    expect(video.prompt.indexOf('图片1')).toBeLessThan(video.prompt.indexOf('图片2'));

    const chat = await resolvePromptToChatContent(`${mention}\n补充：暖光`);
    expect(Array.isArray(chat.content)).toBe(true);
    if (Array.isArray(chat.content)) {
      expect(chat.content.flatMap((part) => part.image_url ? [part.image_url.url] : []))
        .toEqual([urls.character, urls.frame]);
    }
    expect(chat.textContent.indexOf('图片1')).toBeLessThan(chat.textContent.indexOf('图片2'));

    const workflow = resolveNodeReferences(`${mention}\n补充：暖光`);
    expect(workflow).toContain(urls.character);
    expect(workflow).toContain(urls.frame);
    for (const prompt of [video.prompt, chat.textContent, workflow]) {
      expect(prompt).toContain('小绘：先别删。');
      expect(prompt).toContain('杯子轻响，音乐渐弱');
      expect(prompt).toContain('补充：暖光');
      expect(prompt).not.toMatch(/另一个镜头|别的画面|other-image|@drama\{|\/shot\//);
    }
  });
});
