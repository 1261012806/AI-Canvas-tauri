import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderPromptWithChips } from '../../src/components/nodes/shared/PromptChipViewer';

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.props.children)];
}

describe('renderPromptWithChips', () => {
  it('returns plain text unchanged when there are no mention tags', () => {
    expect(renderPromptWithChips('夕阳下的街道')).toBe('夕阳下的街道');
    expect(renderPromptWithChips('', { emptyText: '无提示词' })).toBe('无提示词');
  });

  it('renders node mentions as prompt chips with correct styling and index', () => {
    const preview = vi.fn();
    const nodes = [
      { id: 'node-c90a1u5s7', data: { label: '生成图像', type: 'ai-image', imageUrl: 'https://images.test/img.png', displayId: 5 } },
    ];
    const tree = renderPromptWithChips('美女跳舞 @{node-c90a1u5s7:生成图像}', {
      nodes: nodes as never,
      onPreviewImage: preview,
    });

    const rendered = elements(tree);
    const chip = rendered.find((el) => el.props.className && String(el.props.className).includes('prompt-chip-node'));
    expect(chip).toBeDefined();
    expect(chip?.props['data-ref-id']).toBe('node-c90a1u5s7');
    expect(chip?.props.title).toBe('生成图像 (#5)');

    // 检查编号
    const indexLabel = rendered.find((el) => el.props.className && String(el.props.className).includes('prompt-chip-image-index'));
    expect(indexLabel?.props.children).toBe('(图1)');

    // 点击芯片支持预览图片
    (chip?.props.onClick as (() => void) | undefined)?.();
    expect(preview).toHaveBeenCalledWith({ url: 'https://images.test/img.png', name: '生成图像' });
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
});
