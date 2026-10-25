import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildComfyRefmodChipEl, buildWorkflowChipEl, ensureCaretSlotAfterChip, isChipEl,
  normalizeChipSlots, renderPromptToNodes, serializeDOM, ZWSP,
} from '../../src/components/nodes/shared/mentionEditorDom';
import { commitMentionChipDrop, findDraggableMentionChip, getMentionChipDropRange, startMentionChipDrag } from '../../src/components/nodes/shared/mentionEditorChipDrag';
import { buildComfyRefmodMention } from '../../src/utils/comfyRefmodMention';

const refmodSelection = {
  endpointFingerprint: 'a'.repeat(64), loaderType: 'minimax-h3' as const, fileName: '人物/女主角.safetensors',
  strength: 0.65, loaderNodeId: '42', slot: 1, workflowId: 'workflow', originalFileName: 'None',
};

// 最小 DOM/Range 驱动：验证顺序、引用身份、取消和事件生命周期，不启动原生文件拖放。
class TestNode extends EventTarget {
  parentNode: TestElement | null = null;
  childNodes: TestNode[] = [];
  nodeType: number;
  private text: string;
  constructor(nodeType: number, text = '') { super(); this.nodeType = nodeType; this.text = text; }
  get textContent(): string { return this.nodeType === 3 ? this.text : this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(value: string) { this.text = value; }
  get parentElement() { return this.parentNode; }
  get previousSibling(): TestNode | null { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) - 1] ?? null; }
  get nextSibling(): TestNode | null { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  contains(node: TestNode): boolean { return this === node || this.childNodes.some((child) => child.contains(node)); }
  remove() {
    if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  cloneNode(deep: boolean): TestNode {
    const clone = this instanceof TestElement ? new TestElement(this.tagName) : new TestNode(this.nodeType, this.text);
    if (clone instanceof TestElement && this instanceof TestElement) { clone.attrs = { ...this.attrs }; clone.className = this.className; }
    if (deep) for (const child of this.childNodes) (clone as TestElement).append(child.cloneNode(true));
    return clone;
  }
}
class TestElement extends TestNode {
  attrs: Record<string, string> = {};
  className = '';
  style: Record<string, string> = {};
  hidden = false;
  isConnected = true;
  scrollTop = 0;
  scrollHeight = 100;
  clientHeight = 100;
  ownerDocument!: typeof doc;
  focus = vi.fn();
  tagName: string;
  constructor(tagName = 'SPAN') { super(1); this.tagName = tagName; }
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
    remove: (...names: string[]) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); },
    toggle: (name: string, enabled: boolean) => { if (enabled) this.classList.add(name); else this.classList.remove(name); },
  };
  hasAttribute(name: string) { return name in this.attrs; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  closest<T = TestElement>(selector: string): T | null {
    const match = selector.startsWith('.') ? this.classList.contains(selector.slice(1))
      : [...selector.matchAll(/\[([^\]]+)\]/g)].some((item) => this.hasAttribute(item[1]));
    return (match ? this : this.parentNode?.closest(selector) ?? null) as T | null;
  }
  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): TestElement[] {
    const matches: TestElement[] = [];
    for (const child of this.childNodes) {
      if (!(child instanceof TestElement)) continue;
      const match = selector.startsWith('.') ? child.classList.contains(selector.slice(1))
        : [...selector.matchAll(/\[([^\]]+)\]/g)].some((item) => child.hasAttribute(item[1]));
      if (match) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
  append(...nodes: TestNode[]) { for (const node of nodes) this.insertBefore(node, null); }
  appendChild(node: TestNode) { this.append(node); return node; }
  insertBefore(node: TestNode, anchor: TestNode | null) {
    if (node === anchor) return;
    node.remove();
    this.childNodes.splice(anchor ? this.childNodes.indexOf(anchor) : this.childNodes.length, 0, node);
    node.parentNode = this;
    if (node instanceof TestElement) node.ownerDocument = this.ownerDocument;
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100 }; }
}
class TestRange {
  startContainer: TestNode;
  startOffset: number;
  constructor(node: TestNode, offset = 0) { this.startContainer = node; this.startOffset = offset; }
  setStart(node: TestNode, offset: number) { this.startContainer = node; this.startOffset = offset; }
  setStartBefore(node: TestNode) { this.setStart(node.parentNode!, node.parentNode!.childNodes.indexOf(node)); }
  setStartAfter(node: TestNode) { this.setStart(node.parentNode!, node.parentNode!.childNodes.indexOf(node) + 1); }
  selectNodeContents(node: TestNode) { this.setStart(node, 0); }
  collapse(start = true) { if (!start) this.startOffset = this.startContainer.childNodes.length; }
  getBoundingClientRect() { return { left: 30, right: 30, top: 20, height: 20 }; }
  insertNode(node: TestNode) {
    if (this.startContainer.nodeType === 3) {
      const text = this.startContainer;
      const after = new TestNode(3, text.textContent.slice(this.startOffset));
      text.textContent = text.textContent.slice(0, this.startOffset);
      text.parentNode!.insertBefore(after, text.nextSibling);
      text.parentNode!.insertBefore(node, after);
    } else (this.startContainer as TestElement).insertBefore(node, this.startContainer.childNodes[this.startOffset] ?? null);
  }
}
let doc: EventTarget & {
  defaultView: EventTarget & { getSelection: ReturnType<typeof vi.fn>; cancelAnimationFrame: ReturnType<typeof vi.fn>; requestAnimationFrame: ReturnType<typeof vi.fn> };
  body: TestElement;
  createElement: (tag: string) => TestElement;
  createElementNS: (namespace: string, tag: string) => TestElement;
  createTextNode: (text: string) => TestNode;
  createRange: () => TestRange;
  caretRangeFromPoint?: ReturnType<typeof vi.fn>;
  caretPositionFromPoint?: ReturnType<typeof vi.fn>;
};
let root: TestElement;
let a: TestElement;
let b: TestElement;
let change = vi.fn<() => void>();
const html = (node: TestElement) => node as unknown as HTMLElement;
const range = (node: TestNode, offset = 0) => new TestRange(node, offset) as unknown as Range;
const prompt = () => serializeDOM(html(root));
function chip(id: string): TestElement {
  const result = doc.createElement('span');
  result.setAttribute('data-ref-id', id);
  result.setAttribute('data-ref-label', id.toUpperCase());
  result.append(new TestNode(3, id.toUpperCase()));
  return result;
}
function pointer(type: string, extra: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: 1, clientX: 180, clientY: 40, ctrlKey: false, altKey: false, ...extra });
  doc.defaultView.dispatchEvent(event);
}
function start() {
  return startMentionChipDrag({ root: html(root), source: html(a), pointerId: 1, clientX: 10, clientY: 40, onCommit: () => change() });
}
beforeEach(() => {
  const body = new TestElement('BODY');
  doc = Object.assign(new EventTarget(), {
    body,
    defaultView: Object.assign(new EventTarget(), { getSelection: vi.fn(() => ({ removeAllRanges: vi.fn(), addRange: vi.fn() })), cancelAnimationFrame: vi.fn(), requestAnimationFrame: vi.fn(() => 1) }),
    createElement: (tag: string) => Object.assign(new TestElement(tag.toUpperCase()), { ownerDocument: doc }),
    createElementNS: (_namespace: string, tag: string) => Object.assign(new TestElement(tag.toUpperCase()), { ownerDocument: doc }),
    createTextNode: (text: string) => new TestNode(3, text),
    createRange: () => new TestRange(root),
    caretRangeFromPoint: vi.fn(() => new TestRange(root, root.childNodes.length)),
  });
  body.ownerDocument = doc;
  vi.stubGlobal('Node', Object.assign(TestNode, { ELEMENT_NODE: 1, TEXT_NODE: 3 }));
  vi.stubGlobal('Element', TestElement);
  vi.stubGlobal('document', doc);
  root = doc.createElement('div');
  a = chip('a'); b = chip('b');
  root.append(a, new TestNode(3, '说明'), b);
  change = vi.fn<() => void>();
});

describe('引用胶囊的文本光标落点', () => {
  it('只有一个引用时，渲染尾部保留文本落点且不改变提示词', () => {
    const value = '@{a:A}';
    root.childNodes = [];
    for (const node of renderPromptToNodes(value, new Map())) root.append(node as unknown as TestNode);

    const tail = root.childNodes.at(-1)!;
    expect(tail.nodeType).toBe(Node.TEXT_NODE);
    expect(tail.textContent).toBe(ZWSP);
    expect(isChipEl(tail.previousSibling as unknown as Node)).toBe(true);
    expect(tail.parentNode).toBe(root);
    expect(prompt()).toBe(value);
  });

  it('胶囊后已有正文时复用原文本，不插入或改写正文', () => {
    root.childNodes = [];
    for (const node of renderPromptToNodes('@{a:A}原有正文', new Map())) root.append(node as unknown as TestNode);
    const renderedChip = root.childNodes.find((node) => isChipEl(node as unknown as Node))!;
    const body = renderedChip.nextSibling!;
    const count = root.childNodes.length;

    expect(ensureCaretSlotAfterChip(renderedChip as unknown as Node)).toBe(body);
    normalizeChipSlots(html(root));

    expect(root.childNodes).toHaveLength(count);
    expect(body.textContent).toBe('原有正文');
    expect(root.childNodes.at(-1)).toBe(body);
    expect(prompt()).toBe('@{a:A}原有正文');
  });

  it.each(['空尾文本', '换行', '连续胶囊'])('%s 归一化后两侧都有文本，重复处理不累加占位', (mode) => {
    root.childNodes = [];
    const empty = doc.createTextNode('');
    if (mode === '空尾文本') root.append(a, empty);
    else if (mode === '换行') root.append(a, doc.createElement('br'), b);
    else root.append(a, b);
    const before = prompt();

    normalizeChipSlots(html(root));
    const nodes = [...root.childNodes];
    const contents = nodes.map((node) => node.textContent);
    normalizeChipSlots(html(root));
    normalizeChipSlots(html(root));

    expect(root.childNodes).toEqual(nodes);
    expect(root.childNodes.map((node) => node.textContent)).toEqual(contents);
    expect(prompt()).toBe(before);
    for (const node of root.childNodes.filter((item) => isChipEl(item as unknown as Node))) {
      expect(node.previousSibling?.nodeType).toBe(Node.TEXT_NODE);
      expect(node.nextSibling?.nodeType).toBe(Node.TEXT_NODE);
    }
    for (const node of root.childNodes.filter((item) => item.nodeType === Node.TEXT_NODE)) expect(node.textContent).toBe(ZWSP);
    if (mode === '空尾文本') expect(a.nextSibling).toBe(empty);
    if (mode === '连续胶囊') expect(root.childNodes).toHaveLength(5);
  });

  it('工作流值区保留可编辑正文和内层引用，外层占位不进入值区', () => {
    const workflow = buildWorkflowChipEl('1', '提示词', 'prompt') as unknown as TestElement;
    const value = workflow.querySelector('.prompt-chip-wf-value')!;
    value.childNodes = [];
    const body = doc.createTextNode('内部正文');
    const nested = chip('nested');
    value.append(body, nested);
    root.childNodes = [];
    root.append(workflow);
    const before = prompt();

    normalizeChipSlots(html(root));
    const valueNodes = [...value.childNodes];
    normalizeChipSlots(html(root));

    expect(html(value).contentEditable).toBe('true');
    expect(value.childNodes[0]).toBe(body);
    expect(body.textContent).toBe('内部正文');
    expect(value.childNodes).toEqual(valueNodes);
    expect(workflow.nextSibling?.nodeType).toBe(Node.TEXT_NODE);
    expect(workflow.nextSibling?.parentNode).toBe(root);
    expect(nested.nextSibling?.nodeType).toBe(Node.TEXT_NODE);
    expect(prompt()).toBe(before);
    expect(prompt()).toBe('@wf{1|提示词|prompt}(内部正文@{nested:NESTED})');
  });
});

describe('引用胶囊拖动', () => {
  it('RefMod 胶囊往返保留服务、槽位和强度，额外路径字段在 DOM 构建时清除', () => {
    const canonical = buildComfyRefmodMention(refmodSelection, '女主角');
    const untrusted = `@refmod{${encodeURIComponent(JSON.stringify({ v: 1, ref: { ...refmodSelection, path: 'private-extra-field' }, label: '女主角' }))}}`;
    const built = buildComfyRefmodChipEl(untrusted);
    expect(built.getAttribute('data-refmod-raw')).toBe(canonical);
    expect(isChipEl(built)).toBe(true);
    root.childNodes = [];
    for (const node of renderPromptToNodes(`左 ${canonical} 右`, new Map())) root.append(node as unknown as TestNode);
    expect(prompt()).toBe(`左 ${canonical} 右`);
    const broken = '@refmod{%bad}';
    root.childNodes = [];
    for (const node of renderPromptToNodes(broken, new Map())) root.append(node as unknown as TestNode);
    expect(prompt()).toBe(broken);
  });
  it('RefMod 可以移动或复制，但不会成为工作流输入值区的一部分', () => {
    const token = buildComfyRefmodMention(refmodSelection, '女主角');
    const refmod = buildComfyRefmodChipEl(token) as unknown as TestElement;
    root.append(refmod);
    expect(findDraggableMentionChip(html(root), refmod)).toBe(refmod);
    expect(commitMentionChipDrop(html(root), html(refmod), range(root, 0), true)).toBe(true);
    expect(prompt().split(token)).toHaveLength(3);
    const workflow = doc.createElement('span'); workflow.setAttribute('data-wf-id', '1');
    const value = doc.createElement('span'); value.className = 'prompt-chip-wf-value'; workflow.append(value); root.append(workflow);
    expect(commitMentionChipDrop(html(root), html(refmod), range(value), false)).toBe(false);
    doc.caretRangeFromPoint!.mockImplementation(() => new TestRange(value));
    const drop = getMentionChipDropRange(html(root), html(refmod), 50, 40)!;
    expect(drop.startContainer).toBe(root);
  });
  it('移动保留原引用身份和文字顺序，不增加副本', () => {
    expect(commitMentionChipDrop(html(root), html(a), range(root, 3), false)).toBe(true);
    expect(prompt()).toBe('说明@{b:B}@{a:A}');
    expect(root.childNodes.filter((node) => node === a)).toHaveLength(1);
  });
  it('可插入文字中间且不吞掉文字', () => {
    expect(commitMentionChipDrop(html(root), html(a), range(root.childNodes[1], 1), false)).toBe(true);
    expect(prompt()).toBe('说@{a:A}明@{b:B}');
  });
  it('跨行移动保留换行', () => {
    root.insertBefore(doc.createElement('br'), b);
    commitMentionChipDrop(html(root), html(a), range(root, root.childNodes.length), false);
    expect(prompt()).toBe('说明\n@{b:B}@{a:A}');
  });
  it.each(['ctrlKey', 'altKey'])('按住 %s 拖动复制完整引用，原件留在原位置', (modifier) => {
    start(); pointer('pointermove', { [modifier]: true }); pointer('pointerup', { [modifier]: true });
    expect(prompt()).toBe('@{a:A}说明@{b:B}@{a:A}');
    expect(root.childNodes[0]).toBe(a);
    const clone = root.childNodes.filter((node) => isChipEl(node as unknown as Node)).at(-1) as TestElement;
    expect(clone).not.toBe(a); expect(clone.attrs).toEqual(a.attrs);
    expect(clone.classList.contains('is-chip-drag-source')).toBe(false);
    expect(change).toHaveBeenCalledOnce(); expect(doc.body.childNodes).toHaveLength(0);
  });
  it('普通拖动只发出一次变更，结束后不再响应指针', () => {
    start(); pointer('pointermove'); pointer('pointerup'); pointer('pointerup');
    expect(prompt()).toBe('说明@{b:B}@{a:A}'); expect(change).toHaveBeenCalledOnce();
    expect(root.classList.contains('is-chip-dragging')).toBe(false);
  });
  it('切换项目后即使旧 DOM 仍在，也拒绝回写', () => {
    let current = true;
    startMentionChipDrag({ root: html(root), source: html(a), pointerId: 1, clientX: 10, clientY: 40,
      isCurrent: () => current, onCommit: () => change() });
    pointer('pointermove'); current = false; pointer('pointerup');
    expect(prompt()).toBe('@{a:A}说明@{b:B}'); expect(change).not.toHaveBeenCalled();
    expect(doc.body.childNodes).toHaveLength(0);
  });
  it('按下后小幅移动保持点击，不修改内容', () => {
    start(); pointer('pointermove', { clientX: 12 }); pointer('pointerup', { clientX: 12 });
    expect(prompt()).toBe('@{a:A}说明@{b:B}'); expect(change).not.toHaveBeenCalled();
  });
  it.each(['click', 'drag', 'cancel', 'changed'])('只有静止且仍有效的释放可进入双击预览：%s', (mode) => {
    const clicked = vi.fn();
    const dragged = vi.fn();
    startMentionChipDrag({ root: html(root), source: html(a), pointerId: 1, clientX: 10, clientY: 40,
      onCommit: () => change(), onClick: clicked, onDragStart: dragged });
    if (mode === 'drag') pointer('pointermove');
    if (mode === 'cancel') pointer('pointercancel');
    if (mode === 'changed') root.append(new TestNode(3, '新编辑'));
    pointer('pointerup', mode === 'drag' ? {} : { clientX: 10, clientY: 40 });
    expect(clicked).toHaveBeenCalledTimes(mode === 'click' ? 1 : 0);
    expect(dragged).toHaveBeenCalledTimes(mode === 'drag' ? 1 : 0);
    if (mode !== 'drag') expect(change).not.toHaveBeenCalled();
  });
  it.each(['escape', 'cancel', 'blur', 'outside', 'changed', 'removed', 'unmount'])('%s 取消并清理预览，保留其他内容', (reason) => {
    const cancel = start(); pointer('pointermove');
    if (reason === 'escape') doc.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    if (reason === 'cancel') pointer('pointercancel');
    if (reason === 'blur') doc.defaultView.dispatchEvent(new Event('blur'));
    if (reason === 'changed') root.append(new TestNode(3, '新编辑'));
    if (reason === 'removed') a.remove();
    if (reason === 'unmount') cancel();
    pointer('pointerup', reason === 'outside' ? { clientX: 350 } : {});
    expect(change).not.toHaveBeenCalled();
    expect(doc.body.childNodes).toHaveLength(0);
    expect(prompt()).toContain('说明@{b:B}');
    expect(root.classList.contains('is-chip-dragging')).toBe(false);
  });
  it('胶囊内部命中归一化到左右边界', () => {
    doc.caretRangeFromPoint!.mockImplementation(() => new TestRange(b.childNodes[0]));
    const before = getMentionChipDropRange(html(root), html(a), 30, 40)!;
    const after = getMentionChipDropRange(html(root), html(a), 250, 40)!;
    expect(before.startContainer).toBe(root); expect(before.startOffset).toBe(2);
    expect(after.startContainer).toBe(root); expect(after.startOffset).toBe(3);
  });
  it('工作流值区可选文字及拖动内层引用，禁止嵌套工作流', () => {
    const workflow = doc.createElement('span'); workflow.setAttribute('data-wf-id', '1');
    const value = doc.createElement('span'); value.className = 'prompt-chip-wf-value';
    const nested = chip('nested'); value.append(nested); workflow.append(value); root.append(workflow);
    expect(findDraggableMentionChip(html(root), value)).toBeNull();
    expect(findDraggableMentionChip(html(root), nested)).toBe(nested);
    expect(commitMentionChipDrop(html(root), html(workflow), range(value), true)).toBe(false);
    expect(commitMentionChipDrop(html(root), html(a), range(value), false)).toBe(true);
  });
  it('兼容 caretPositionFromPoint，输入框外不能接收引用', () => {
    doc.caretRangeFromPoint = undefined;
    doc.caretPositionFromPoint = vi.fn(() => ({ offsetNode: root.childNodes[1], offset: 1 }));
    const drop = getMentionChipDropRange(html(root), html(a), 50, 40)!;
    expect(drop.startOffset).toBe(1); expect(drop.startContainer).toBe(root.childNodes[1]);
    expect(getMentionChipDropRange(html(root), html(a), -10, 40)).toBeNull();
  });
});
