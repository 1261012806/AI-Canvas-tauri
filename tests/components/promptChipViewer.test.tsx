import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { findPromptChipRanges, renderPromptWithChips } from '../../src/components/nodes/shared/PromptChipViewer';
import { renderMarkdownWithInlineSlots } from '../../src/utils/renderMarkdown';
import { buildComfyRefmodMention } from '../../src/utils/comfyRefmodMention';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}

describe('renderPromptWithChips', () => {
  it('RefMod 只显示角色名及只读参数，不展示内部编码或占用图片编号', () => {
    const token = buildComfyRefmodMention({ endpointFingerprint: 'a'.repeat(64), loaderType: 'minimax-h3', fileName: 'people/Alice', strength: 0.8,
      workflowId: 'wf', loaderNodeId: '12', slot: 1, originalFileName: '(none)' }, '女主');
    const prompt = `${token} @{image:场景}`;
    const tree = renderPromptWithChips(prompt);
    const rendered = elements(tree);
    expect(rendered.find((el) => String(el.props.title).includes('ComfyUI 角色'))?.props.title).toContain('强度 0.8');
    expect(rendered.some((el) => el.props.children === '女主')).toBe(true);
    expect(rendered.filter((el) => String(el.props.className).includes('prompt-chip-image-index')).map((el) => el.props.children)).toEqual(['(图1)']);
    expect(Array.isArray(tree) && tree.some((item) => typeof item === 'string' && item.includes('@refmod{'))).toBe(false);
    expect(findPromptChipRanges(prompt)[0]).toEqual({ start: 0, end: token.length });
    const broken = elements(renderPromptWithChips('@refmod{invalid}'));
    expect(broken.some((el) => el.props.children === 'ComfyUI 角色（引用无效）')).toBe(true);
  });

  it('returns plain text unchanged when there are no mention tags', () => {
    expect(renderPromptWithChips('夕阳下的街道')).toBe('夕阳下的街道');
    expect(renderPromptWithChips('', { emptyText: '无提示词' })).toBe('无提示词');
  });

  it('renders node mentions as prompt chips with correct styling and index', () => {
    const nodes = [
      { id: 'node-c90a1u5s7', data: { label: '生成图像', type: 'ai-image', imageUrl: 'https://images.test/img.png', displayId: 5 } },
    ];
    const tree = renderPromptWithChips('美女跳舞 @{node-c90a1u5s7:生成图像}', {
      nodes: nodes as never,
    });

    const rendered = elements(tree);
    const chip = rendered.find((el) => el.props.className && String(el.props.className).includes('prompt-chip-node'));
    expect(chip).toBeDefined();
    expect(chip?.props['data-ref-id']).toBe('node-c90a1u5s7');
    expect(chip?.props.title).toBe('生成图像 (#5)');

    // 检查编号
    const indexLabel = rendered.find((el) => el.props.className && String(el.props.className).includes('prompt-chip-image-index'));
    expect(indexLabel?.props.children).toBe('(图1)');

    // 双击由窗口统一处理；第一次单击不提前打开另一层图片弹窗。
    expect(chip?.props.onClick).toBeUndefined();
    expect(chip?.props.role).toBe('button');
    expect(chip?.props.tabIndex).toBe(0);
  });

  it('renders asset, drama, skill, and workflow chips', () => {
    const dramaAssets = {
      characters: [
        { id: 'char_1', name: '林小满', kind: 'character' as const, imageUrl: 'https://images.test/lin.png' },
      ],
      scenes: [],
      props: [],
    };
    const prompt = '前缀 @asset{%2Fassets%2Fhero.png} @drama{char_1:林小满} @skill{gen|图像润色} @wf{io-1|输入提示词|prompt} 后缀';
    const tree = renderPromptWithChips(prompt, {
      dramaAssets: dramaAssets as never,
    });

    const rendered = elements(tree);
    expect(rendered.some((el) => el.props['data-asset-path'] === '/assets/hero.png')).toBe(true);
    expect(rendered.some((el) => el.props['data-drama-id'] === 'char_1')).toBe(true);
    expect(rendered.some((el) => el.props['data-skill-id'] === 'gen')).toBe(true);
    expect(rendered.some((el) => el.props['data-wf-id'] === 'io-1')).toBe(true);
  });

  it('视频胶囊保留视频图标与双击身份，不把旧视频封面地址交给 img', () => {
    const videoUrl = 'https://media.test/clip.mp4';
    const rendered = elements(renderPromptWithChips('@{video:参考视频}', {
      nodes: [{ id: 'video', data: { type: 'source-video', videoUrl, thumbnailUrl: videoUrl } }],
    }));
    expect(rendered.find((element) => element.props['data-ref-id'] === 'video')?.props).toMatchObject({
      role: 'button', tabIndex: 0, 'data-ref-label': '参考视频',
    });
    expect(rendered.some((element) => element.type === 'svg')).toBe(true);
    expect(rendered.some((element) => element.type === 'img' || element.type === 'video')).toBe(false);
  });

  it('单镜胶囊显示实时镜号和表名，保持稳定引用且不占图片编号，失效可辨认', () => {
    const nodes = [{ id: 'sheet', data: { type: 'ai-shotlist', label: '新表名', displayId: 47,
      shotlistRows: [{ id: 'row/a', shotNo: '9', content: '新内容' }],
    } }];
    const rendered = elements(renderPromptWithChips('@{sheet/shot/row%2Fa:旧表名 · 镜1}', { nodes }));
    const chip = rendered.find((el) => el.props['data-ref-id'] === 'sheet/shot/row%2Fa');
    expect(chip?.props.title).toBe('镜9 · 新表名');
    expect(chip?.props['data-ref-label']).toBe('旧表名 · 镜1');
    expect(chip?.props.className).toContain('chip-text');
    expect(rendered.some((el) => String(el.props.className).includes('prompt-chip-image-index'))).toBe(false);
    const missing = elements(renderPromptWithChips('@{sheet/shot/gone:删除镜头}', { nodes }))
      .find((el) => el.props['data-ref-id'] === 'sheet/shot/gone');
    expect(missing?.props.title).toBe('删除镜头（镜头已失效）');
  });

  it('只读工作流胶囊保留完整输入身份与值，不以展示标题冒充实际内容', () => {
    const text = '@{image:参考图}\n保持固定机位';
    const rendered = elements(renderPromptWithChips(`@wf{12|镜头提示词|prompt}(${text}) @skill{writer|对白润色}`));
    const workflow = rendered.find((el) => el.props['data-wf-id'] === '12');
    expect(workflow?.props['data-wf-title']).toBe('镜头提示词');
    expect(workflow?.props['data-wf-preview-value']).toBe(text);
    expect(rendered.find((el) => el.props['data-skill-id'] === 'writer')?.props['data-skill-name']).toBe('对白润色');
  });

  it('嵌套括号和内嵌引用保留为完整工作流值，后续媒体编号与 Skill 不错位', () => {
    const value = '人物(微笑(克制)，静止)，参考 @{inside:角色图}\n保留(所有括号)';
    const nodes = [
      { id: 'before', data: { type: 'ai-image', imageUrl: 'before.png' } },
      { id: 'after', data: { type: 'ai-image', imageUrl: 'after.png' } },
    ];
    const rendered = elements(renderPromptWithChips(`@{before:首图} @wf{6|正向|prompt}(${value}) @skill{writer|对白润色} @{after:尾图}`, { nodes }));
    expect(rendered.find((el) => el.props['data-wf-id'] === '6')?.props['data-wf-preview-value']).toBe(value);
    expect(rendered.find((el) => el.props.className === 'prompt-chip-wf-value')?.props.children).toBe(value);
    expect(rendered.some((el) => el.props['data-ref-id'] === 'inside')).toBe(false);
    expect(rendered.find((el) => el.props['data-skill-id'] === 'writer')?.props['data-skill-name']).toBe('对白润色');
    const indices = rendered.filter((el) => String(el.props.className).includes('prompt-chip-image-index')).map((el) => el.props.children);
    expect(indices).toEqual(['(图1)', '(图2)']);
  });

  it('显式空工作流值保持为空，无值与未闭合括号不吞掉后续令牌', () => {
    const empty = elements(renderPromptWithChips('@wf{6|正向|prompt}()')).find((el) => el.props['data-wf-id'] === '6');
    expect(empty?.props['data-wf-preview-value']).toBe('');
    const noValue = elements(renderPromptWithChips('@wf{6|正向|prompt} @skill{writer|写作}'));
    expect(noValue.find((el) => el.props['data-wf-id'] === '6')?.props['data-wf-preview-value']).toBeUndefined();
    expect(noValue.some((el) => el.props.className === 'prompt-chip-wf-value')).toBe(false);
    expect(noValue.find((el) => el.props.className === 'prompt-chip-wf-title')?.props.children).toBe('正向');
    expect(noValue.some((el) => el.props['data-skill-id'] === 'writer')).toBe(true);
    const broken = elements(renderPromptWithChips('@wf{6|正向|prompt}(未闭合 @skill{writer|写作}'));
    expect(broken.find((el) => el.props['data-wf-id'] === '6')?.props['data-wf-preview-value']).toBeUndefined();
    expect(broken.some((el) => el.props['data-skill-id'] === 'writer')).toBe(true);
  });

  it('Markdown 中的完整工作流值与引用标签不会被星号、管道和括号拆开', () => {
    const workflow = '@wf{6|镜头*提示*|prompt}(人物(微笑)，保留 `代码` 和 @{inside:参考|图})';
    const image = '@{after:角色**定稿**|三视图}';
    const prepared = renderMarkdownWithInlineSlots(`| 提示词 | 参考 |\n| --- | --- |\n| ${workflow} | ${image} |`, findPromptChipRanges);
    expect(prepared.tokens).toEqual([workflow, image]);
    expect(prepared.html.match(/<td /g)).toHaveLength(2);
    const rendered = elements(renderPromptWithChips(prepared.tokens.join('\n')));
    expect(rendered.find((el) => el.props['data-wf-id'] === '6')?.props['data-wf-preview-value'])
      .toBe('人物(微笑)，保留 `代码` 和 @{inside:参考|图}');
    expect(rendered.find((el) => el.props['data-ref-id'] === 'after')?.props['data-ref-label']).toBe('角色**定稿**|三视图');
  });

  it('全局角色只读取全局展示素材，模型和聊天图片保留可再次预览的身份', () => {
    const imageId = 'chat-ref-11111111-1111-1111-1111-111111111111.png';
    const rendered = elements(renderPromptWithChips(`@drama{global/hero:全局人物} @model{general/h3|MiniMax H3} @image{${imageId}|聊天参考图}`, {
      nodes: [{ id: 'local', data: { type: 'ai-image', imageUrl: 'wrong-local.png' } }],
      dramaAssets: { version: 2, characters: [], scenes: [], props: [] },
      globalCharacters: [{ id: 'hero', name: '全局人物', kind: 'character', imageNodeId: 'local', imageUrl: 'global.png' }] as never,
    }));
    expect(rendered.find((el) => el.props['data-drama-id'] === 'global/hero')).toBeDefined();
    expect(rendered.some((el) => el.props.src === 'global.png')).toBe(true);
    expect(rendered.some((el) => el.props.src === 'wrong-local.png')).toBe(false);
    expect(rendered.find((el) => el.props['data-model-ref-id'] === 'general/h3')?.props['data-model-ref-label']).toBe('MiniMax H3');
    expect(rendered.find((el) => el.props['data-chat-image-file-name'] === imageId)?.props['data-chat-image-label']).toBe('聊天参考图');
  });

  it('独立窗口缺少单镜完整元数据时保留标签和稳定身份，实际失效由主窗解析', () => {
    const raw = '@{sheet/shot/row:镜12 · 分镜表}';
    const rendered = elements(renderPromptWithChips(raw, {
      nodes: [{ id: 'sheet', data: { type: 'ai-shotlist', label: '缩略投影' } }], fallbackToTokenLabel: true,
    }));
    const chip = rendered.find((el) => el.props['data-ref-id'] === 'sheet/shot/row');
    expect(chip?.props.title).toBe('镜12 · 分镜表');
    expect(chip?.props['data-ref-label']).toBe('镜12 · 分镜表');
  });
});
