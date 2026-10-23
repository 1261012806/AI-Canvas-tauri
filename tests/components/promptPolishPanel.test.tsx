import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { PromptPolishOptions } from '../../src/services/promptPolishService';

const driver = vi.hoisted(() => ({
  index: 0, slots: [] as unknown[],
  run: vi.fn(), cancel: vi.fn(), apply: vi.fn(), undo: vi.fn(),
  updateConfig: vi.fn(), updateNodeData: vi.fn(),
  state: {
    config: { assistantModelId: 'text-default', generalModels: [{ id: 'text-default', category: 'text' }] },
    nodes: [{ id: 'video-a', data: { model: 'general/video', provider: 'general', prompt: '原始提示词' } }],
    userSkills: [], agentPackageSkills: [], subAgentProfiles: [], agentPackages: [],
  },
}));

// Match the repository's component interaction tests without adding a DOM runtime.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useId: () => 'prompt-polish',
  useEffect: () => {},
  useRef: <T,>(initial: T) => {
    const index = driver.index++;
    return driver.slots[index] ?? (driver.slots[index] = { current: initial });
  },
  useState: <T,>(initial: T | (() => T)) => {
    const index = driver.index++;
    if (!(index in driver.slots)) driver.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [driver.slots[index], (next: T) => { driver.slots[index] = next; }];
  },
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(driver.state), {
    getState: () => ({ ...driver.state, updateConfig: driver.updateConfig, updateNodeData: driver.updateNodeData }),
  }),
}));
vi.mock('../../src/services/promptPolishService', () => ({
  createPromptPolishSession: vi.fn(() => ({ run: driver.run, cancel: driver.cancel, apply: driver.apply, undo: driver.undo })),
  enablePromptPolishPackage: vi.fn(), isPromptPolishPackageSupported: () => true,
}));
vi.mock('../../src/services/skillPromptService', () => ({ isSkillUserInvocable: () => true }));
vi.mock('../../src/services/chat/subAgentProfileService', () => ({ mergeSubAgentProfiles: () => [] }));
vi.mock('../../src/services/ai/assistantStream', () => ({ resolveAssistantModel: () => ({ selectionId: 'text-default' }) }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/components/shared/Select', () => ({ default: 'select' }));
vi.mock('../../src/components/shared/PopupCloseButton', () => ({ default: 'close-button' }));
vi.mock('../../src/components/nodes/shared/MentionEditor', () => ({ default: 'mention-editor' }));
vi.mock('../../src/components/nodes/shared/ModelSelector', () => ({ default: 'model-selector' }));

import PromptPolishPanel from '../../src/components/nodes/shared/PromptPolishPanel';
import MentionEditor from '../../src/components/nodes/shared/MentionEditor';
import ModelSelector from '../../src/components/nodes/shared/ModelSelector';
import { createPromptPolishSession } from '../../src/services/promptPolishService';

interface Element { type: unknown; props: Record<string, unknown> & { children?: unknown } }
function elements(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as Element;
  return [element, ...elements(element.props.children)];
}
function render() {
  driver.index = 0;
  return elements(PromptPolishPanel({ nodeId: 'video-a', onClose: vi.fn() }));
}
function editor(tree: Element[]) {
  return tree.find((element) => element.type === MentionEditor)!.props as unknown as ComponentProps<typeof MentionEditor>;
}
function model(tree: Element[]) {
  return tree.find((element) => element.type === ModelSelector)!.props as unknown as ComponentProps<typeof ModelSelector>;
}
function button(tree: Element[], label: string) {
  return tree.find((element) => element.type === 'button' && element.props.children === label)!.props;
}

beforeEach(() => {
  driver.index = 0;
  driver.slots = [];
  vi.clearAllMocks();
  driver.run.mockReset().mockResolvedValue('润色结果');
});

describe('提示词润色面板', () => {
  it('将独立选择的文本模型和完整 @ 引用要求传给润色会话，保留配置及节点模型', async () => {
    const before = structuredClone(driver.state);
    let tree = render();
    expect(model(tree).nodeType).toBe('ai-text');
    expect(model(tree).selectedModel).toBe('general/text-default');
    expect(model(tree).persistPreference).toBe(false);
    expect(editor(tree).nodeId).toBe('video-a');
    expect(editor(tree).portalDropdown).toBe(true);
    expect(editor(tree).selectedWorkflowId).toBeUndefined();

    const instruction = '参考 @{image-a:角色图} 与 @drama{hero:主角}，保留动作和构图';
    editor(tree).onChange(instruction);
    model(tree).onSelect({ value: 'general/polish-text', label: '润色文本', provider: 'general', nodeTypes: ['ai-text'] });
    tree = render();
    expect(model(tree).selectedModel).toBe('general/polish-text');
    expect(editor(tree).value).toBe(instruction);
    (button(tree, '开始润色').onClick as () => void)();

    expect(createPromptPolishSession).toHaveBeenCalledExactlyOnceWith('video-a');
    expect(driver.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      modelId: 'general/polish-text', instruction,
    }));
    expect(driver.updateConfig).not.toHaveBeenCalled();
    expect(driver.updateNodeData).not.toHaveBeenCalled();
    expect(driver.state).toEqual(before);
    await Promise.resolve();
  });

  it('润色进行中禁用要求编辑和模型选择，停止后恢复且忽略已停止会话的完成', async () => {
    let complete!: (text: string) => void;
    driver.run.mockImplementation((options: PromptPolishOptions) => new Promise<string>((resolve) => {
      complete = resolve;
      options.onPreview('尚未完成的预览');
    }));
    (button(render(), '开始润色').onClick as () => void)();
    let tree = render();
    expect(editor(tree).disabled).toBe(true);
    expect(editor(tree).canSubmit).toBe(false);
    expect(model(tree).disabled).toBe(true);
    expect(button(tree, '应用到提示词').disabled).toBe(true);

    (button(tree, '停止').onClick as () => void)();
    expect(driver.cancel).toHaveBeenCalledOnce();
    complete('过期结果');
    await Promise.resolve();
    tree = render();
    expect(editor(tree).disabled).toBe(false);
    expect(editor(tree).canSubmit).toBe(true);
    expect(model(tree).disabled).toBe(false);
    expect(button(tree, '应用到提示词').disabled).toBe(true);
  });
});
