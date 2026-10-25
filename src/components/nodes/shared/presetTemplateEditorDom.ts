/** DOM glue for readable shortcut placeholders; persisted templates remain plain text. */
export interface PresetTemplateVariable {
  key: string;
  label: string;
}

export type PresetTemplatePart = { type: 'text'; text: string }
  | { type: 'variable'; key: string; raw: string };

const ZWSP = '\u200B';
const CHIP_SELECTOR = '[data-preset-variable]';
const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function splitPresetTemplate(template: string): PresetTemplatePart[] {
  const parts: PresetTemplatePart[] = [];
  let end = 0;
  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    if (match.index > end) parts.push({ type: 'text', text: template.slice(end, match.index) });
    parts.push({ type: 'variable', key: match[1].trim(), raw: match[0] });
    end = match.index + match[0].length;
  }
  if (end < template.length) parts.push({ type: 'text', text: template.slice(end) });
  return parts;
}

export function createPresetTemplateFragment(
  document: Document,
  template: string,
  variables: PresetTemplateVariable[],
  unknownLabel: string,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const labels = new Map(variables.map((variable) => [variable.key, variable.label]));
  for (const part of splitPresetTemplate(template)) {
    if (part.type === 'text') fragment.appendChild(document.createTextNode(part.text));
    else {
      const chip = document.createElement('span');
      chip.className = 'preset-placeholder-pill';
      chip.contentEditable = 'false';
      chip.draggable = false;
      chip.setAttribute('data-preset-variable', part.key);
      chip.setAttribute('data-preset-token', part.raw);
      chip.textContent = labels.get(part.key) || unknownLabel;
      chip.title = chip.textContent;
      fragment.appendChild(document.createTextNode(ZWSP));
      fragment.appendChild(chip);
      fragment.appendChild(document.createTextNode(ZWSP));
    }
  }
  return fragment;
}

export function refreshPresetTemplateLabels(
  root: HTMLElement,
  variables: PresetTemplateVariable[],
  unknownLabel: string,
): boolean {
  const labels = new Map(variables.map((variable) => [variable.key, variable.label]));
  let changed = false;
  for (const chip of root.querySelectorAll<HTMLElement>(CHIP_SELECTOR)) {
    const label = labels.get(chip.getAttribute('data-preset-variable') || '') || unknownLabel;
    if (chip.textContent !== label) { chip.textContent = label; changed = true; }
    if (chip.title !== label) changed = true;
    chip.title = label;
  }
  return changed;
}

export function serializePresetTemplateDom(root: Node): string {
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return (node.textContent || '').split(ZWSP).join('');
    if (node.nodeType !== 1 && node.nodeType !== 11) return '';
    const element = node as HTMLElement;
    if (node.nodeType === 1 && element.hasAttribute('data-preset-variable')) {
      return element.getAttribute('data-preset-token') || '{{' + element.getAttribute('data-preset-variable') + '}}';
    }
    if (element.tagName === 'BR') return '\n';
    let result = '';
    for (const child of Array.from(node.childNodes)) {
      const childElement = child as HTMLElement;
      if (child.nodeType === 1 && ['DIV', 'P'].includes(childElement.tagName) && result && !result.endsWith('\n')) result += '\n';
      result += walk(child);
    }
    return result;
  };
  // WebView leaves one BR behind after removing the last character.
  if (root.nodeType === 1 && root.childNodes.length === 1) {
    const first = root.firstChild as HTMLElement;
    if (first.tagName === 'BR' || (['DIV', 'P'].includes(first.tagName)
      && first.childNodes.length === 1 && (first.firstChild as HTMLElement).tagName === 'BR')) return '';
  }
  return walk(root);
}

/** Convert newly typed token syntax without disturbing the caret in surrounding text. */
export function normalizePresetTemplateChips(root: HTMLElement, variables: PresetTemplateVariable[], unknownLabel: string): void {
  const template = serializePresetTemplateDom(root);
  const count = splitPresetTemplate(template).filter((part) => part.type === 'variable').length;
  if (count === root.querySelectorAll(CHIP_SELECTOR).length) return;
  const selection = root.ownerDocument.getSelection();
  const offsetAt = (node: Node | null, offset: number): number | null => {
    if (!node || !root.contains(node)) return null;
    const prefix = root.ownerDocument.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(node, offset);
    return serializePresetTemplateDom(prefix.cloneContents()).length;
  };
  const anchor = selection && offsetAt(selection.anchorNode, selection.anchorOffset);
  const focus = selection && offsetAt(selection.focusNode, selection.focusOffset);
  const focused = root.contains(root.ownerDocument.activeElement);
  root.replaceChildren(createPresetTemplateFragment(root.ownerDocument, template, variables, unknownLabel));
  if (!focused || !selection || anchor == null || focus == null) return;
  const pointAt = (offset: number): { node: Node; offset: number } => {
    for (let index = 0; index < root.childNodes.length; index += 1) {
      const node = root.childNodes[index];
      if (node.nodeType === 3) {
        const text = node.textContent || '';
        for (let position = 0; position < text.length; position += 1) {
          if (offset === 0) return { node, offset: position };
          if (text[position] !== ZWSP) offset -= 1;
        }
      } else {
        const length = (node as HTMLElement).getAttribute('data-preset-token')?.length || 0;
        if (offset <= length) return { node: root, offset: index + (offset > 0 ? 1 : 0) };
        offset -= length;
      }
    }
    return { node: root, offset: root.childNodes.length };
  };
  const start = pointAt(anchor);
  const end = pointAt(focus);
  selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
}

export function getPresetTemplateRange(root: HTMLElement, fallback?: Range | null): Range {
  const selection = root.ownerDocument.getSelection();
  const current = selection?.rangeCount ? selection.getRangeAt(0) : fallback;
  const range = current && root.contains(current.commonAncestorContainer) ? current.cloneRange()
    : fallback && root.contains(fallback.commonAncestorContainer) ? fallback.cloneRange()
      : root.ownerDocument.createRange();
  if (!root.contains(range.commonAncestorContainer)) {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  // A noneditable capsule is a single unit, including programmatic partial selections.
  const start = range.startContainer.nodeType === 1 ? range.startContainer as HTMLElement : range.startContainer.parentElement;
  const end = range.endContainer.nodeType === 1 ? range.endContainer as HTMLElement : range.endContainer.parentElement;
  const firstChip = start?.closest<HTMLElement>(CHIP_SELECTOR);
  const lastChip = end?.closest<HTMLElement>(CHIP_SELECTOR);
  if (firstChip && root.contains(firstChip)) range.setStartBefore(firstChip);
  if (lastChip && root.contains(lastChip)) range.setEndAfter(lastChip);
  return range;
}

export function selectPresetTemplateRange(root: HTMLElement, range: Range): void {
  const selection = root.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function deleteAdjacentPresetTemplateChip(root: HTMLElement, backward: boolean): boolean {
  const range = getPresetTemplateRange(root);
  if (!range.collapsed) return false;
  const prefix = root.ownerDocument.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const offset = serializePresetTemplateDom(prefix.cloneContents()).length;
  for (const chip of root.querySelectorAll<HTMLElement>(CHIP_SELECTOR)) {
    prefix.selectNodeContents(root);
    prefix.setEndBefore(chip);
    const start = serializePresetTemplateDom(prefix.cloneContents()).length;
    const length = chip.getAttribute('data-preset-token')?.length || 0;
    if (backward ? start + length !== offset : start !== offset) continue;
    range.selectNode(chip);
    range.deleteContents();
    range.collapse(true);
    selectPresetTemplateRange(root, range);
    return true;
  }
  return false;
}
