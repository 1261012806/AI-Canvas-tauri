import { Children, createElement, isValidElement, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { renderMarkdownWithInlineSlots, renderTextWithInlineSlots } from '../../utils/renderMarkdown';
import { findPromptChipRanges, renderPromptWithChips } from '../nodes/shared/PromptChipViewer';
import { getNodeMetaMap } from '../nodes/shared/mentionEditorDom';
import { listGlobalDramaAssets } from '../../services/dramaAssetPrompt';
import type { DramaAsset } from '../../types/dramaAssets';

const MARKDOWN_ELEMENTS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'ul', 'ol', 'li', 'hr', 'br', 'a', 'img', 'strong', 'em', 'del', 'input', 'span']);
const MARKDOWN_ATTRIBUTES = ['href', 'src', 'alt', 'title', 'rel', 'type', 'aria-label'] as const;

/** 只转换既有安全 Markdown 渲染器的结构；原文不会成为属性或可执行 HTML。 */
function renderPreviewStructure(html: string, chips: ReactNode[]): ReactNode[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  const render = (node: Node, key: string): ReactNode => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node as HTMLElement;
    const slot = element.getAttribute('data-markdown-inline-slot');
    if (slot !== null) {
      const index = Number(slot);
      return Number.isSafeInteger(index) && index >= 0 ? chips[index] ?? null : null;
    }
    const children = Array.from(element.childNodes, (child, index) => render(child, `${key}.${index}`));
    const tag = element.tagName.toLowerCase();
    if (!MARKDOWN_ELEMENTS.has(tag)) return children;
    const props: Record<string, unknown> = { key };
    for (const attribute of MARKDOWN_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value !== null) props[attribute] = value;
    }
    if (element.className) props.className = element.className;
    if (tag === 'input') {
      props.disabled = true;
      props.checked = element.hasAttribute('checked');
      props.readOnly = true;
    }
    return createElement(tag, props, ...children);
  };
  return Array.from(template.content.childNodes, (node, index) => render(node, String(index)));
}

/** 全屏正文与侧栏共用；只订阅引用展示所需投影，不读取或展开引用全文。 */
export default function ReferencePreviewBody({ value, markdown = false, className = '' }: {
  value: string;
  markdown?: boolean;
  className?: string;
}) {
  const { nodes, dramaAssets, globalCharacters, globalScenes, globalProps } = useAppStore(useShallow((state) => ({
    nodes: state.nodes, dramaAssets: state.dramaAssets, globalCharacters: state.globalCharacters,
    globalScenes: state.globalScenes, globalProps: state.globalProps,
  })));
  const [loadedGlobalAssets, setLoadedGlobalAssets] = useState<DramaAsset[]>();
  const hasGlobalReferences = value.includes('@drama{global/');
  useEffect(() => {
    if (!hasGlobalReferences) return;
    let active = true;
    void import('../../services/globalDramaAssetService').then((service) => service.loadGlobalDramaAssetCards())
      .then((assets) => { if (active) setLoadedGlobalAssets(assets); }).catch(() => { /* 点击预览时提供读取错误。 */ });
    return () => { active = false; };
  }, [hasGlobalReferences, globalCharacters, globalScenes, globalProps]);
  const globalAssets = useMemo(() => loadedGlobalAssets ?? listGlobalDramaAssets({ globalCharacters, globalScenes, globalProps }),
    [loadedGlobalAssets, globalCharacters, globalScenes, globalProps]);
  const structure = useMemo(() => markdown ? renderMarkdownWithInlineSlots(value, findPromptChipRanges)
    : renderTextWithInlineSlots(value, findPromptChipRanges), [markdown, value]);
  const nodeMetaMap = useMemo(() => getNodeMetaMap(nodes), [nodes]);
  const body = useMemo(() => {
    const rendered = renderPromptWithChips(structure.tokens.join('\n'), {
      nodes, dramaAssets, globalAssets, nodeMetaMap, fallbackToTokenLabel: true,
    });
    // 一次渲染全部令牌，沿正文顺序统一编号，不能在每个段落重新从「图1」开始。
    const chips = Children.toArray(rendered).filter(isValidElement);
    return renderPreviewStructure(structure.html, chips);
  }, [dramaAssets, globalAssets, nodeMetaMap, nodes, structure]);
  return <div className={`${markdown ? 'markdown-rendered' : 'whitespace-pre-wrap'} break-words ${className}`}>{body}</div>;
}
