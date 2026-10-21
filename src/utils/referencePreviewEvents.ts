import type { ReferencePreviewSource } from '../types/referencePreview';
import { serializeDOM } from '../components/nodes/shared/mentionEditorDom';

export const REFERENCE_PREVIEW_EVENT = 'ai-canvas:reference-preview-request';

const REFERENCE_SELECTOR = '[data-ref-id],[data-drama-id],[data-asset-path],[data-wf-id],[data-skill-id],[data-model-ref-id],[data-chat-image-file-name],[data-chat-reference-raw]';
const CHAT_IMAGE_NAME = /^chat-ref-[a-f0-9-]{36}\.(?:png|jpg|webp)$/;

export function requestReferencePreview(source: ReferencePreviewSource, doc: Document = document): void {
  doc.dispatchEvent(new CustomEvent<ReferencePreviewSource>(REFERENCE_PREVIEW_EVENT, { detail: source }));
}

function decodeLabel(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function chatReferenceSource(raw: string): ReferencePreviewSource | null {
  const node = /^@\{([^:}\r\n]+):([^}\r\n]+)\}$/.exec(raw);
  if (node) return { kind: 'node', id: node[1], label: node[2] };
  const drama = /^@drama\{([^:}\r\n]+):([^}\r\n]+)\}$/.exec(raw);
  if (drama) return { kind: 'drama', id: drama[1], label: drama[2] };
  const named = /^@(model|skill)\{([^|}\r\n]+)\|([^}\r\n]*)\}$/.exec(raw);
  if (named) return {
    kind: named[1] as 'model' | 'skill', id: named[2],
    label: named[1] === 'skill' ? decodeLabel(named[3]) || 'Skill' : named[3] || '模型',
  };
  const image = /^@image\{(chat-ref-[a-f0-9-]{36}\.(?:png|jpg|webp))\|([^}\r\n]*)\}$/.exec(raw);
  return image ? { kind: 'chat-image', id: image[1], label: decodeLabel(image[2]) || '参考图' } : null;
}

/** 仅真实引用胶囊参与；不把普通徽标、模型按钮或工作流值区的文字当引用。 */
export function findReferencePreviewSource(target: EventTarget | null): ReferencePreviewSource | null {
  const node = target && 'nodeType' in target ? target as Node : null;
  const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
  if (!element) return null;
  const chip = element.closest<HTMLElement>(REFERENCE_SELECTOR);
  if (!chip) return null;
  const control = element.closest('button, input, textarea, select, [role="button"], [data-reference-preview-ignore]');
  if (control && control !== chip && chip.contains(control)) return null;
  const valueArea = element.closest('.prompt-chip-wf-value');
  if (valueArea && chip.contains(valueArea)) return null;

  let source: ReferencePreviewSource | null = null;
  const nodeId = chip.getAttribute('data-ref-id');
  const dramaId = chip.getAttribute('data-drama-id');
  const path = chip.getAttribute('data-asset-path');
  const workflowId = chip.getAttribute('data-wf-id');
  const skillId = chip.getAttribute('data-skill-id');
  const modelId = chip.getAttribute('data-model-ref-id');
  const imageName = chip.getAttribute('data-chat-image-file-name');
  if (nodeId) source = { kind: 'node', id: nodeId, label: chip.getAttribute('data-ref-label') || '节点' };
  else if (dramaId) source = { kind: 'drama', id: dramaId, label: chip.getAttribute('data-drama-label') || '资产' };
  else if (path) source = { kind: 'asset', id: path, label: path.split(/[\\/]/).filter(Boolean).pop() || '素材' };
  else if (workflowId) {
    const workflowValue = chip.querySelector<HTMLElement>('.prompt-chip-wf-value');
    source = {
      kind: 'workflow', id: workflowId, label: chip.getAttribute('data-wf-title') || '工作流输入',
      value: chip.getAttribute('data-wf-preview-value') ?? (workflowValue ? serializeDOM(workflowValue) : undefined),
    };
  }
  else if (skillId) source = { kind: 'skill', id: skillId, label: chip.getAttribute('data-skill-name') || 'Skill' };
  else if (modelId) source = { kind: 'model', id: modelId, label: chip.getAttribute('data-model-ref-label') || '模型' };
  else if (imageName && CHAT_IMAGE_NAME.test(imageName)) source = {
    kind: 'chat-image', id: imageName, label: chip.getAttribute('data-chat-image-label') || '参考图',
  };
  else {
    const raw = chip.getAttribute('data-chat-reference-raw');
    if (raw) source = chatReferenceSource(raw);
  }
  if (!source) return null;
  const owner = chip.closest('[data-reference-owner-node-id],.react-flow__node[data-id]');
  const ownerNodeId = owner?.getAttribute('data-reference-owner-node-id') || owner?.getAttribute('data-id');
  return ownerNodeId ? { ...source, ownerNodeId } : source;
}
