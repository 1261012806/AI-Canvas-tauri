import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findReferencePreviewSource,
  REFERENCE_PREVIEW_EVENT,
  requestReferencePreview,
} from '../../src/utils/referencePreviewEvents';
import type { ReferencePreviewSource } from '../../src/types/referencePreview';

/** 只模拟事件目标的祖先与属性，身份识别不依赖浏览器或画布 Store。 */
class PreviewElement extends EventTarget {
  readonly nodeType = 1;
  parentElement: PreviewElement | null = null;
  children: PreviewElement[] = [];
  childNodes: Array<PreviewElement | { nodeType: number; textContent: string }> = [];
  textContent = '';

  constructor(readonly attributes: Record<string, string> = {}, readonly tagName = 'SPAN') { super(); }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  hasAttribute(name: string) { return name in this.attributes; }
  append(child: PreviewElement) { child.parentElement = this; this.children.push(child); this.childNodes.push(child); return child; }
  appendText(textContent: string) { this.childNodes.push({ nodeType: 3, textContent }); }
  contains(child: PreviewElement): boolean { return child === this || this.children.some((item) => item.contains(child)); }
  matches(selector: string): boolean {
    return selector.split(',').some((value) => {
      const rule = value.trim();
      const tag = rule.match(/^[a-z]+/i)?.[0];
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      const className = rule.match(/\.([\w-]+)/)?.[1];
      if (className && !(this.attributes.class || '').split(' ').includes(className)) return false;
      return [...rule.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)]
        .every((match) => match[2] === undefined ? match[1] in this.attributes : this.attributes[match[1]] === match[2]);
    });
  }
  closest(selector: string): PreviewElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelector(selector: string): PreviewElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const result = child.querySelector(selector);
      if (result) return result;
    }
    return null;
  }
}

describe('引用全屏预览事件', () => {
  beforeEach(() => vi.stubGlobal('Node', { ELEMENT_NODE: 1, TEXT_NODE: 3 }));
  afterEach(() => vi.unstubAllGlobals());

  it('向指定文档派发实际身份，不读取内容或执行模型', () => {
    const doc = new EventTarget();
    const requests: ReferencePreviewSource[] = [];
    doc.addEventListener(REFERENCE_PREVIEW_EVENT, (event) => requests.push((event as CustomEvent<ReferencePreviewSource>).detail));
    const source: ReferencePreviewSource = { kind: 'model', id: 'model-a', label: '模型 A' };
    requestReferencePreview(source, doc as unknown as Document);
    expect(requests).toEqual([source]);
  });

  it('匹配内层节点或库胶囊，保留单格与指定参考图身份', () => {
    const workflow = new PreviewElement({ 'data-wf-id': '6' });
    const value = workflow.append(new PreviewElement({ class: 'prompt-chip-wf-value' }));
    const node = value.append(new PreviewElement({ 'data-ref-id': 'board/cell/3', 'data-ref-label': '第四格' }));
    const image = node.append(new PreviewElement({}, 'IMG'));
    expect(findReferencePreviewSource(image)).toEqual({ kind: 'node', id: 'board/cell/3', label: '第四格' });
    const drama = value.append(new PreviewElement({ 'data-drama-id': 'global/person#side', 'data-drama-label': '侧面图' }));
    expect(findReferencePreviewSource(drama)).toEqual({ kind: 'drama', id: 'global/person#side', label: '侧面图' });
  });

  it('文件只暴露文件名为标题，工作流头部读取当前值及宿主节点', () => {
    const owner = new PreviewElement({ 'data-reference-owner-node-id': 'generator' });
    const workflow = owner.append(new PreviewElement({ 'data-wf-id': '6', 'data-wf-title': '正向提示词' }));
    const header = workflow.append(new PreviewElement({ class: 'prompt-chip-wf-prefix' }));
    const value = workflow.append(new PreviewElement({ class: 'prompt-chip-wf-value' }));
    value.appendText('当前编辑内容');
    expect(findReferencePreviewSource(header)).toEqual({ kind: 'workflow', id: '6', label: '正向提示词', value: '当前编辑内容', ownerNodeId: 'generator' });
    expect(findReferencePreviewSource(new PreviewElement({ 'data-asset-path': 'C:\\assets\\测试.md' })))
      .toEqual({ kind: 'asset', id: 'C:\\assets\\测试.md', label: '测试.md' });
    const flow = new PreviewElement({ class: 'react-flow__node', 'data-id': 'canvas-node' });
    const skill = flow.append(new PreviewElement({ 'data-skill-id': 'story', 'data-skill-name': '分镜' }));
    expect(findReferencePreviewSource(skill)).toEqual({ kind: 'skill', id: 'story', label: '分镜', ownerNodeId: 'canvas-node' });
  });

  it('工作流当前值序列化保留内嵌节点和资产身份，不使用可见编号文字', () => {
    const workflow = new PreviewElement({ 'data-wf-id': '6' });
    const value = workflow.append(new PreviewElement({ class: 'prompt-chip-wf-value' }));
    value.appendText('参考 ');
    const reference = value.append(new PreviewElement({ 'data-ref-id': 'node-image', 'data-ref-label': '角色图' }));
    reference.textContent = '#10';
    value.appendText(' 与 ');
    const drama = value.append(new PreviewElement({ 'data-drama-id': 'global/person#side', 'data-drama-label': '侧面' }));
    drama.textContent = '侧面（图2）';
    expect(findReferencePreviewSource(workflow)?.value).toBe('参考 @{node-image:角色图} 与 @drama{global/person#side:侧面}');
  });

  it('只读工作流使用原序列化值，显式空值不退回可见文字', () => {
    const serialized = '参考 @{node-image:角色图}';
    const workflow = new PreviewElement({ 'data-wf-id': '6', 'data-wf-preview-value': serialized });
    const value = workflow.append(new PreviewElement({ class: 'prompt-chip-wf-value' }));
    value.appendText('可见标题');
    expect(findReferencePreviewSource(workflow)?.value).toBe(serialized);
    workflow.attributes['data-wf-preview-value'] = '';
    expect(findReferencePreviewSource(workflow)?.value).toBe('');
  });

  it('工作流无当前值区时保留 undefined，由宿主读取真实输入', () => {
    const owner = new PreviewElement({ 'data-reference-owner-node-id': 'generator' });
    const workflow = owner.append(new PreviewElement({ 'data-wf-id': '6', 'data-wf-title': '输入' }));
    expect(findReferencePreviewSource(workflow)).toEqual({
      kind: 'workflow', id: '6', label: '输入', value: undefined, ownerNodeId: 'generator',
    });
  });

  it('工作流值区普通文字保留选词，嵌套引用仍可打开', () => {
    const workflow = new PreviewElement({ 'data-wf-id': '6' });
    const value = workflow.append(new PreviewElement({ class: 'prompt-chip-wf-value' }));
    const text = value.append(new PreviewElement());
    expect(findReferencePreviewSource(value)).toBeNull();
    expect(findReferencePreviewSource(text)).toBeNull();
    const textNode = Object.assign(new EventTarget(), { nodeType: 3, parentElement: value });
    expect(findReferencePreviewSource(textNode)).toBeNull();
    const inner = value.append(new PreviewElement({ 'data-ref-id': 'inner' }));
    expect(findReferencePreviewSource(inner)).toEqual({ kind: 'node', id: 'inner', label: '节点' });
  });

  it('不把移除按钮、普通标签和模型选择按钮当引用，引用自身按钮可用', () => {
    const chip = new PreviewElement({ 'data-ref-id': 'node', 'data-ref-label': '参考图' }, 'BUTTON');
    expect(findReferencePreviewSource(chip)).toEqual({ kind: 'node', id: 'node', label: '参考图' });
    const remove = chip.append(new PreviewElement({ 'aria-label': '移除' }, 'BUTTON'));
    const removeIcon = remove.append(new PreviewElement({}, 'SVG'));
    expect(findReferencePreviewSource(removeIcon)).toBeNull();
    const ignore = chip.append(new PreviewElement({ 'data-reference-preview-ignore': '' }));
    expect(findReferencePreviewSource(ignore)).toBeNull();
    expect(findReferencePreviewSource(new PreviewElement({ class: 'ui-tag' }))).toBeNull();
    expect(findReferencePreviewSource(new PreviewElement({ 'data-model-id': 'button-model' }, 'BUTTON'))).toBeNull();
    expect(findReferencePreviewSource(new EventTarget())).toBeNull();
    expect(findReferencePreviewSource(null)).toBeNull();
  });

  it.each<[string, ReferencePreviewSource]>([
    ['@{node/shot/row%2F1:镜头}', { kind: 'node', id: 'node/shot/row%2F1', label: '镜头' }],
    ['@drama{global/person#ref:人物}', { kind: 'drama', id: 'global/person#ref', label: '人物' }],
    ['@model{provider/model|模型}', { kind: 'model', id: 'provider/model', label: '模型' }],
    ['@skill{script|%E5%89%A7%E6%9C%AC}', { kind: 'skill', id: 'script', label: '剧本' }],
    ['@image{chat-ref-12345678-1234-1234-1234-123456789abc.png|%E5%8F%82%E8%80%83%E5%9B%BE}', { kind: 'chat-image', id: 'chat-ref-12345678-1234-1234-1234-123456789abc.png', label: '参考图' }],
  ])('识别聊天真实令牌 %s', (raw, expected) => {
    expect(findReferencePreviewSource(new PreviewElement({ 'data-chat-reference-raw': raw }))).toEqual(expected);
  });

  it('拒绝非完整令牌和伪造聊天文件路径', () => {
    for (const raw of ['前缀 @{node:图}', '@{node:图} 后缀', '/分镜', '@image{../image.png|图}', '@image{chat-ref-123.png|图}']) {
      expect(findReferencePreviewSource(new PreviewElement({ 'data-chat-reference-raw': raw }))).toBeNull();
    }
    expect(findReferencePreviewSource(new PreviewElement({ 'data-chat-image-file-name': '../image.png' }))).toBeNull();
  });
});
