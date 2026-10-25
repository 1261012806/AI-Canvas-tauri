import { describe, expect, it } from 'vitest';
import {
  createPresetTemplateFragment,
  refreshPresetTemplateLabels,
  serializePresetTemplateDom,
  splitPresetTemplate,
} from '../../src/components/nodes/shared/presetTemplateEditorDom';

/** Only the DOM construction/serialization contract is exercised; no browser is launched. */
class TestNode {
  readonly attributes = new Map<string, string>();
  childNodes: TestNode[] = [];
  className = '';
  contentEditable = '';
  draggable = true;
  title = '';
  private content = '';

  constructor(readonly nodeType: number, readonly tagName = '', text = '') { this.content = text; }
  get firstChild(): TestNode | null { return this.childNodes[0] ?? null; }
  get textContent(): string { return this.childNodes.length ? this.childNodes.map((child) => child.textContent).join('') : this.content; }
  set textContent(text: string) { this.content = text; this.childNodes = []; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  appendChild(child: TestNode) {
    if (child.nodeType === 11) { this.childNodes.push(...child.childNodes); child.childNodes = []; }
    else this.childNodes.push(child);
    return child;
  }
  querySelectorAll() {
    const found: TestNode[] = [];
    const visit = (node: TestNode) => {
      for (const child of node.childNodes) {
        if (child.hasAttribute('data-preset-variable')) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

function testDocument() {
  const tags: string[] = [];
  return {
    tags,
    document: {
      createTextNode: (text: string) => new TestNode(3, '', text),
      createDocumentFragment: () => new TestNode(11),
      createElement: (tag: string) => { tags.push(tag); return new TestNode(1, tag.toUpperCase()); },
    } as unknown as Document,
  };
}

function editor(value: string, variables = [{ key: 'productInfo', label: '产品信息' }]) {
  const { document, tags } = testDocument();
  const root = new TestNode(1, 'DIV');
  root.appendChild(createPresetTemplateFragment(document, value, variables, '未定义内容') as unknown as TestNode);
  return { root, tags };
}

describe('preset template capsule DOM', () => {
  it('普通文字、原始变量拼写、空行与末尾换行可无损往返', () => {
    const value = '产品：{{ productInfo }}\n\n{{productInfo}}\n';
    const { root } = editor(value);
    expect(root.querySelectorAll().map((chip) => chip.textContent)).toEqual(['产品信息', '产品信息']);
    expect(serializePresetTemplateDom(root as unknown as Node)).toBe(value);
    expect(root.querySelectorAll().every((chip) => chip.contentEditable === 'false')).toBe(true);
  });

  it('名称改动和切换语言仅刷新显示，不更改身份或旧模板格式', () => {
    const { root } = editor('参考 {{ productInfo }}');
    const chip = root.querySelectorAll()[0];
    refreshPresetTemplateLabels(root as unknown as HTMLElement, [{ key: 'productInfo', label: 'Product information' }], 'Unknown field');
    expect(root.querySelectorAll()[0]).toBe(chip);
    expect(chip.textContent).toBe('Product information');
    expect(serializePresetTemplateDom(root as unknown as Node)).toBe('参考 {{ productInfo }}');
    refreshPresetTemplateLabels(root as unknown as HTMLElement, [{ key: 'productInfo', label: '我的自定义内容' }], '未定义内容');
    expect(chip.textContent).toBe('我的自定义内容');
  });

  it('未知变量使用可读提示但保留原始引用，稍后定义后可正常显示', () => {
    const { root } = editor('{{ notAdded }}');
    expect(root.querySelectorAll()[0].textContent).toBe('未定义内容');
    expect(serializePresetTemplateDom(root as unknown as Node)).toBe('{{ notAdded }}');
    refreshPresetTemplateLabels(root as unknown as HTMLElement, [{ key: 'notAdded', label: '新增资料' }], '未定义内容');
    expect(root.querySelectorAll()[0].textContent).toBe('新增资料');
  });

  it('标签和普通文本只按文本构造，不将粘贴内容或参数名称解释为 HTML', () => {
    const value = '<img src=x onerror=alert(1)> {{productInfo}}';
    const { root, tags } = editor(value, [{ key: 'productInfo', label: '<script>hello</script>' }]);
    expect(tags).toEqual(['span']);
    expect(root.querySelectorAll()[0].textContent).toBe('<script>hello</script>');
    expect(serializePresetTemplateDom(root as unknown as Node)).toBe(value);
  });

  it('保留未完成模板文字，并识别中文变量名和相邻变量', () => {
    expect(splitPresetTemplate('前{{中文内容}}{{ next }}后{{未完成')).toEqual([
      { type: 'text', text: '前' },
      { type: 'variable', key: '中文内容', raw: '{{中文内容}}' },
      { type: 'variable', key: 'next', raw: '{{ next }}' },
      { type: 'text', text: '后{{未完成' },
    ]);
  });

  it('序列化浏览器产生的块级换行，空编辑器占位 BR 不变成正文', () => {
    const root = new TestNode(1, 'DIV');
    for (const text of ['第一行', '第二行']) {
      const block = new TestNode(1, 'DIV');
      block.appendChild(new TestNode(3, '', text));
      root.appendChild(block);
    }
    expect(serializePresetTemplateDom(root as unknown as Node)).toBe('第一行\n第二行');
    const empty = new TestNode(1, 'DIV');
    empty.appendChild(new TestNode(1, 'BR'));
    expect(serializePresetTemplateDom(empty as unknown as Node)).toBe('');
    const emptyBlock = new TestNode(1, 'DIV');
    emptyBlock.appendChild(empty);
    expect(serializePresetTemplateDom(emptyBlock as unknown as Node)).toBe('');
    const selectedLineBreak = new TestNode(11);
    selectedLineBreak.appendChild(new TestNode(1, 'BR'));
    expect(serializePresetTemplateDom(selectedLineBreak as unknown as Node)).toBe('\n');
  });
});
