import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWorkflowAgentTools } from '../../../src/services/chat/tools/workflowTools';
import { registerStyleAgentTools } from '../../../src/services/chat/tools/styleTools';
import { registerSkillAgentTools } from '../../../src/services/chat/tools/skillTools';
import { registerPresetAgentTools } from '../../../src/services/chat/tools/presetTools';
import { registerMemoryAgentTools } from '../../../src/services/chat/tools/memoryTools';
import { clearAgentToolRegistryForTests, getAvailableAgentTools, getAgentTool, type AgentToolContext } from '../../../src/services/chat/toolRegistry';
import { useAppStore } from '../../../src/store/useAppStore';
import { validateAgentToolInput } from '../../../src/services/chat/agentToolSchemas';
import type { UserPreset } from '../../../src/types';

function context(conversationId = 'mcp-control-project-1'): AgentToolContext {
  return { taskId: 'task-management', projectId: 'project-1', conversationId, mode: 'autonomous', baseRevision: 0, signal: new AbortController().signal };
}

let unregisters: Array<() => void> = [];

beforeEach(() => {
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'project-1', projects: [{ id: 'project-1', name: '项目', createdAt: 1, updatedAt: 1 }] });
  unregisters = [
    ...registerWorkflowAgentTools(), ...registerStyleAgentTools(), ...registerSkillAgentTools(),
    ...registerPresetAgentTools(), ...registerMemoryAgentTools(),
  ];
});

afterEach(() => {
  unregisters.forEach((unregister) => unregister());
  clearAgentToolRegistryForTests();
});

describe('MCP management tool coverage', () => {
  it('registers complete CRUD effects and keeps dedicated domains MCP-only', () => {
    const expected = {
      workflow_list: 'read', workflow_get: 'read', workflow_create: 'config_write', workflow_update: 'config_write', workflow_delete: 'permanent_delete',
      style_list: 'read', style_get: 'read', style_create: 'config_write', style_update: 'config_write', style_delete: 'permanent_delete',
      skill_list: 'read', skill_get: 'read', skill_create: 'file_write', skill_update: 'file_write', skill_delete: 'permanent_delete',
      preset_delete: 'permanent_delete', memory_list: 'read', memory_get: 'read', memory_update: 'memory_write', memory_delete: 'permanent_delete',
    } as const;
    for (const [id, effect] of Object.entries(expected)) expect(getAgentTool(id)).toMatchObject({ effect });
    expect(getAvailableAgentTools(context('conversation-1')).some((tool) => tool.id === 'workflow_list')).toBe(false);
    expect(getAvailableAgentTools(context()).some((tool) => tool.id === 'workflow_list')).toBe(true);
  });

  it('creates, updates and deletes workflows through Store actions', async () => {
    const addWorkflow = vi.fn(async (workflow) => useAppStore.setState((state) => ({ workflows: [...state.workflows, workflow] })));
    const updateWorkflow = vi.fn(async (id, changes) => useAppStore.setState((state) => ({ workflows: state.workflows.map((item) => item.id === id ? { ...item, ...changes } : item) })));
    const deleteWorkflow = vi.fn(async (id) => useAppStore.setState((state) => ({ workflows: state.workflows.filter((item) => item.id !== id) })));
    useAppStore.setState({ addWorkflow, updateWorkflow, deleteWorkflow });

    const created = await getAgentTool('workflow_create')!.execute(context(), { name: '测试流', category: 'ai-image', fileContent: '{"1":{"class_type":"KSampler"}}' });
    const id = JSON.parse(created.modelContent).workflow.id as string;
    await getAgentTool('workflow_update')!.execute(context(), { workflowId: id, name: '更新流' });
    await getAgentTool('workflow_delete')!.execute(context(), { workflowId: id });

    expect(addWorkflow).toHaveBeenCalledTimes(1);
    expect(updateWorkflow).toHaveBeenCalledWith(id, expect.objectContaining({ name: '更新流' }));
    expect(deleteWorkflow).toHaveBeenCalledWith(id);
  });

  it('preserves preset execution mode and reference sources through create, update, list and get', async () => {
    const addUserPreset = vi.fn(async (preset: UserPreset) => useAppStore.setState((state) => ({ userPresets: [...state.userPresets, preset] })));
    const updateUserPreset = vi.fn(async (id: string, changes: Partial<UserPreset>) => useAppStore.setState((state) => ({ userPresets: state.userPresets.map((preset) => preset.id === id ? { ...preset, ...changes } : preset) })));
    useAppStore.setState({ addUserPreset, updateUserPreset });
    const steps = [
      { name: '产品特写', nodeType: 'ai-image', promptTemplate: '保持产品外观，生成产品特写', referenceSource: 'source' },
      { name: '使用场景', nodeType: 'ai-image', promptTemplate: '{{previousResult}} 生成使用场景', referenceSource: 'source' },
    ];

    const created = await getAgentTool('preset_create')!.execute(context(), {
      name: '产品系列', nodeType: 'ai-image', mode: 'advanced', advanced: { executionMode: 'parallel', parameters: [], steps },
    });
    expect(created.status).toBe('success');
    const id = JSON.parse(created.modelContent).preset.id as string;
    expect(addUserPreset).toHaveBeenCalledWith(expect.objectContaining({ advanced: {
      executionMode: 'parallel', parameters: [], steps: steps.map((step) => expect.objectContaining(step)),
    } }));
    const listed = await getAgentTool('preset_list')!.execute(context(), {});
    expect(JSON.parse(listed.modelContent).presets[0].advanced.executionMode).toBe('parallel');
    expect(JSON.parse(listed.modelContent).presets[0].advanced.steps.map((step: { referenceSource: string }) => step.referenceSource)).toEqual(['source', 'source']);

    useAppStore.setState({ nodes: [{ id: 'source', type: 'ai-image', position: { x: 0, y: 0 }, data: { type: 'ai-image', label: '产品图', role: 'source' } }] });
    const started = await getAgentTool('preset_start_run')!.execute(context(), { presetId: id, sourceNodeId: 'source' });
    expect(started.status).toBe('success');
    const run = JSON.parse(started.modelContent);
    expect(run.executionMode).toBe('sequential');
    expect(getAgentTool('preset_run_media_step')!.authorize!(context(), {
      runId: run.runId, nodeId: run.steps[1].nodeId,
    }).allowed).toBe(false);

    const changedSteps = [steps[0], { ...steps[1], referenceSource: 'previous' }];
    const updated = await getAgentTool('preset_update')!.execute(context(), {
      presetId: id, advanced: { executionMode: 'sequential', parameters: [], steps: changedSteps },
    });
    expect(updated.status).toBe('success');
    await getAgentTool('preset_update')!.execute(context(), { presetId: id, name: '更新名称' });
    const fetched = await getAgentTool('preset_get')!.execute(context(), { presetId: id });
    expect(JSON.parse(fetched.modelContent).preset.advanced.executionMode).toBe('sequential');
    expect(JSON.parse(fetched.modelContent).preset.advanced.steps.map((step: { referenceSource: string }) => step.referenceSource)).toEqual(['source', 'previous']);
    expect(updateUserPreset).toHaveBeenCalledTimes(2);
  });

  it('validates preset execution modes and reference sources in the Agent and MCP input schema', () => {
    const schema = getAgentTool('preset_create')!.inputSchema;
    const input = (referenceSource?: string, executionMode?: string) => ({
      name: '产品系列', nodeType: 'ai-image', mode: 'advanced',
      advanced: { ...(executionMode === undefined ? {} : { executionMode }), parameters: [], steps: [{ name: '步骤 1', nodeType: 'ai-image', promptTemplate: '产品特写', ...(referenceSource === undefined ? {} : { referenceSource }) }] },
    });
    for (const referenceSource of [undefined, 'source', 'previous']) {
      expect(validateAgentToolInput(schema, input(referenceSource)).valid).toBe(true);
    }
    for (const executionMode of ['sequential', 'parallel']) {
      expect(validateAgentToolInput(schema, input('source', executionMode)).valid).toBe(true);
    }
    expect(validateAgentToolInput(schema, input('other')).valid).toBe(false);
    expect(validateAgentToolInput(schema, input('source', 'other')).valid).toBe(false);
  });

  it('manages project memory without leaking source message ids', async () => {
    const memory = useAppStore.getState().createProjectMemory({ projectId: 'project-1', kind: 'fact', content: '主角叫小洛', source: { conversationId: 'private-conversation', messageId: 'private-message' } });
    const list = await getAgentTool('memory_list')!.execute(context(), {});
    const updated = await getAgentTool('memory_update')!.execute(context(), { memoryId: memory.id, enabled: false });
    const deleted = await getAgentTool('memory_delete')!.execute(context(), { memoryId: memory.id });

    expect(list.modelContent).not.toContain('private-message');
    expect(updated.status).toBe('success');
    expect(deleted.status).toBe('success');
  });
});

describe('MCP ComfyUI 默认输入', () => {
  const content = JSON.stringify({ '19': { class_type: 'PrimitiveString', inputs: { value: '提示词' } }, '101': { class_type: 'LoadImage', inputs: { image: '' } } });
  function storeActions() {
    const addWorkflow = vi.fn(async (workflow) => useAppStore.setState((state) => ({ workflows: [...state.workflows, workflow] })));
    const updateWorkflow = vi.fn(async (id, changes) => useAppStore.setState((state) => ({ workflows: state.workflows.map((workflow) => workflow.id === id ? { ...workflow, ...changes } : workflow) })));
    useAppStore.setState({ addWorkflow, updateWorkflow });
    return { addWorkflow, updateWorkflow };
  }
  it('创建时识别IO，默认提示词19可持久化；省略保留，空对象清空', async () => {
    storeActions();
    const created = await getAgentTool('workflow_create')!.execute(context(), { name: 'flow', category: 'ai-video', fileContent: content, defaultNodes: { prompt: '19' } });
    expect(created.status).toBe('success');
    const workflowId = JSON.parse(created.modelContent).workflow.id;
    const renamed = await getAgentTool('workflow_update')!.execute(context(), { workflowId, name: 'new' });
    expect(JSON.parse(renamed.modelContent).workflow.defaultNodes).toEqual({ prompt: '19' });
    const replaced = await getAgentTool('workflow_update')!.execute(context(), { workflowId, defaultNodes: { image: '101' } });
    expect(JSON.parse(replaced.modelContent).workflow.defaultNodes).toEqual({ image: '101' });
    const cleared = await getAgentTool('workflow_update')!.execute(context(), { workflowId, defaultNodes: {} });
    expect(JSON.parse(cleared.modelContent).workflow.defaultNodes).toEqual({});
  });
  it.each([{ prompt: '101' }, { image: 'missing' }])('类型不匹配或节点不存在时拒绝写入：%j', async (defaultNodes) => {
    const actions = storeActions();
    const result = await getAgentTool('workflow_create')!.execute(context(), { name: 'flow', category: 'ai-video', fileContent: content, defaultNodes });
    expect(result.status).toBe('error');
    expect(actions.addWorkflow).not.toHaveBeenCalled();
  });
  it('更新默认值和改图时都校验目标，失败不写Store', async () => {
    const actions = storeActions();
    const created = await getAgentTool('workflow_create')!.execute(context(), { name: 'flow', category: 'ai-video', fileContent: content, defaultNodes: { prompt: '19' } });
    const workflowId = JSON.parse(created.modelContent).workflow.id;
    for (const changes of [{ defaultNodes: { prompt: '101' } }, { fileContent: '{"101":{"class_type":"LoadImage","inputs":{"image":""}}}' }]) {
      const result = await getAgentTool('workflow_update')!.execute(context(), { workflowId, ...changes });
      expect(result.status).toBe('error');
    }
    expect(actions.updateWorkflow).not.toHaveBeenCalled();
  });
});

it('MCP 默认输入不能靠错误 IO 标签把图片字段当成提示词', async () => {
  const addWorkflow = vi.fn();
  useAppStore.setState({ addWorkflow });
  const result = await getAgentTool('workflow_create')!.execute(context(), {
    name: 'bad', category: 'ai-image', fileContent: '{"1":{"class_type":"LoadImage","inputs":{"image":""}}}',
    ioNodes: [{ nodeId: '1', type: 'prompt', title: 'incorrect' }], defaultNodes: { prompt: '1' },
  });
  expect(result.status).toBe('error');
  expect(addWorkflow).not.toHaveBeenCalled();
});
