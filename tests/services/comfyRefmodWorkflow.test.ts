import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '../../src/types';
import type { ComfyRefmodCatalog, ComfyRefmodSelection } from '../../src/types/comfyRefmod';

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(), identity: vi.fn(),
  state: { workflows: [] as WorkflowDefinition[] },
  server: { baseUrl: 'http://comfy.test:8188' },
}));
vi.mock('../../src/services/comfyRefmodService', () => ({
  loadComfyRefmodCatalog: mocks.catalog,
  resolveComfyRefmodServerIdentity: mocks.identity,
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state } }));
vi.mock('../../src/services/comfyServers', () => ({ resolveComfyServerSelection: () => mocks.server }));

import { applyComfyRefmodsToWorkflow, assertComfyRefmodSubmissionFresh, prepareComfyRefmodSelections } from '../../src/services/comfyRefmodWorkflow';

const fingerprint = 'a'.repeat(64);
const catalog: ComfyRefmodCatalog = {
  serverName: '默认服务器', endpointFingerprint: fingerprint, fetchedAt: 1, warnings: [], entries: [],
  loaders: [{ loaderType: 'minimax-h3', classType: 'MiniMaxH3RefModsLoader', label: 'RefMods',
    slots: Array.from({ length: 8 }, (_, index) => ({ slot: index + 1, fileField: `mod_${index + 1}`,
      strengthField: `strength_${index + 1}`, strengthMin: 0, strengthMax: 1,
      allowedNames: ['alice', 'nested/bob'], emptyNames: ['(none)'] })) },
  { loaderType: 'h3-refmods', classType: 'H3RefModLoader', label: 'H3RefMods', slots: [{
    slot: 1, fileField: 'mod', allowedNames: ['alice'], emptyNames: [],
    strengthField: 'weight', additionalStrengthFields: ['video_weight', 'audio_weight'], strengthMin: 0, strengthMax: 10,
  }] },
  { loaderType: 'refmods-lab', classType: 'H3RefModLabLoad', label: 'Lab', slots: [{
    slot: 1, fileField: 'filename', allowedNames: ['alice.safetensors'], emptyNames: [],
  }] }],
};

function loaderInputs() {
  return Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
    [`mod_${index + 1}`, '(none)'], [`strength_${index + 1}`, 1], [`copies_${index + 1}`, 2],
  ]).flat());
}
function workflow(graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = { '12': { class_type: 'MiniMaxH3RefModsLoader', inputs: loaderInputs() } }): WorkflowDefinition {
  return { id: 'wf', name: 'H3', fileName: 'h3.json', category: 'ai-video', createdAt: 1, fileContent: JSON.stringify(graph) };
}
function reference(patch: Partial<ComfyRefmodSelection> = {}): ComfyRefmodSelection {
  return { endpointFingerprint: fingerprint, loaderType: 'minimax-h3', fileName: 'alice', strength: 0.4, ...patch };
}
function boundReference(patch: Partial<ComfyRefmodSelection> = {}): ComfyRefmodSelection {
  return reference({ loaderNodeId: '12', slot: 1, workflowId: 'wf', originalFileName: '(none)', ...patch });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalog.mockResolvedValue(catalog);
  mocks.identity.mockResolvedValue({ serverName: '默认服务器', endpointFingerprint: fingerprint });
  mocks.state.workflows = [];
  mocks.server.baseUrl = 'http://comfy.test:8188';
});

describe('RefMod 工作流槽位绑定', () => {
  it('优先复用同文件的槽位，保持副本数量和源工作流不变', async () => {
    const inputs = { ...loaderInputs(), mod_2: 'alice' };
    const wf = workflow({ '12': { class_type: 'MiniMaxH3RefModsLoader', inputs } });
    const selected = await prepareComfyRefmodSelections(wf, [reference()]);
    expect(selected[0]).toMatchObject({ loaderNodeId: '12', slot: 2 });
    const execution = JSON.parse(wf.fileContent);
    await applyComfyRefmodsToWorkflow(wf, execution, selected);
    expect(execution['12'].inputs).toMatchObject({ mod_1: '(none)', mod_2: 'alice', strength_2: 0.4, copies_2: 2 });
    expect(JSON.parse(wf.fileContent)['12'].inputs.strength_2).toBe(1);
    expect(mocks.catalog).toHaveBeenLastCalledWith(undefined, { signal: undefined, fresh: true, includeDetails: false });
  });

  it('多个同格式加载器必须明确目标，不能猜测人物顺序', async () => {
    const wf = workflow({ '12': { class_type: 'MiniMaxH3RefModsLoader', inputs: loaderInputs() },
      '34': { class_type: 'MiniMaxH3RefModsLoader', inputs: loaderInputs() } });
    await expect(prepareComfyRefmodSelections(wf, [reference()])).rejects.toThrow('多个');
    await expect(prepareComfyRefmodSelections(wf, [reference({ loaderNodeId: '34' })])).resolves.toMatchObject([{ loaderNodeId: '34', slot: 1 }]);
    const existing = [boundReference()];
    await expect(prepareComfyRefmodSelections(wf, [reference({ loaderNodeId: '34' })], existing)).resolves.toMatchObject([
      { loaderNodeId: '12', slot: 1 }, { loaderNodeId: '34', slot: 1 },
    ]);
  });

  it('不自动覆盖原模型，明确指定槽位后才允许替换', async () => {
    const inputs = Object.fromEntries(Object.entries(loaderInputs()).map(([key, value]) => [key, key.startsWith('mod_') ? 'nested/bob' : value]));
    const wf = workflow({ '12': { class_type: 'MiniMaxH3RefModsLoader', inputs } });
    await expect(prepareComfyRefmodSelections(wf, [reference()])).rejects.toThrow('没有可用');
    await expect(prepareComfyRefmodSelections(wf, [boundReference({ originalFileName: 'nested/bob' })])).rejects.toThrow('已有其他');
    await expect(prepareComfyRefmodSelections(wf, [boundReference({ originalFileName: 'nested/bob', replaceExisting: true })])).resolves.toHaveLength(1);
  });

  it('文件槽与强度槽的连线都不能被明确替换覆盖', async () => {
    for (const field of ['mod_1', 'strength_1']) {
      const wf = workflow({ '12': { class_type: 'MiniMaxH3RefModsLoader', inputs: { ...loaderInputs(), [field]: ['99', 0] } } });
      await expect(prepareComfyRefmodSelections(wf, [boundReference({ replaceExisting: true })])).rejects.toThrow('连线');
    }
  });

  it('拒绝错误服务器、端点变化、缺失文件与原插件范围之外的强度', async () => {
    const wf = workflow();
    for (const ref of [reference({ serverId: 'other' }), reference({ endpointFingerprint: 'b'.repeat(64) }), reference({ fileName: 'Alice' }), reference({ strength: 1.2 })]) {
      await expect(prepareComfyRefmodSelections(wf, [ref])).rejects.toThrow();
    }
  });

  it('所有选择校验完成前不修改执行图', async () => {
    const wf = workflow();
    const execution = JSON.parse(wf.fileContent);
    await expect(applyComfyRefmodsToWorkflow(wf, execution, [reference(), reference({ fileName: 'missing' })])).rejects.toThrow();
    expect(JSON.stringify(execution)).toBe(wf.fileContent);
  });

  it('Francky 支持真实 0..10 范围并同步视觉与音频权重', async () => {
    const graph = { '5': { class_type: 'H3RefModLoader', inputs: { mod: 'alice', weight: 1, video_weight: 1, audio_weight: 1 } } };
    const wf: WorkflowDefinition = { ...workflow(), fileContent: JSON.stringify(graph) };
    const selected = [boundReference({ loaderType: 'h3-refmods', loaderNodeId: '5', slot: 1, strength: 4, originalFileName: 'alice' })];
    await applyComfyRefmodsToWorkflow(wf, graph, selected);
    expect(graph['5'].inputs).toMatchObject({ weight: 4, video_weight: 4, audio_weight: 4 });
  });

  it('Lab 仅改文件名，保留 Combine 中的组合强度', async () => {
    const graph = { '5': { class_type: 'H3RefModLabLoad', inputs: { filename: 'alice.safetensors' } },
      '6': { class_type: 'H3RefModLabCombineV2', inputs: { strengths: '[0.7]' } } };
    const wf: WorkflowDefinition = { ...workflow(), fileContent: JSON.stringify(graph) };
    await applyComfyRefmodsToWorkflow(wf, graph, [boundReference({ loaderType: 'refmods-lab', fileName: 'alice.safetensors', loaderNodeId: '5', slot: 1, originalFileName: 'alice.safetensors' })]);
    expect(graph['6'].inputs.strengths).toBe('[0.7]');
    expect(graph['5'].inputs).not.toHaveProperty('strength');
  });

  it('最终提交前拒绝源工作流或服务地址变化', async () => {
    const wf = workflow();
    mocks.state.workflows = [wf];
    await expect(assertComfyRefmodSubmissionFresh(wf, [reference()], mocks.server.baseUrl)).resolves.toBeUndefined();
    mocks.state.workflows = [{ ...wf, name: '替换后的工作流' }];
    await expect(assertComfyRefmodSubmissionFresh(wf, [reference()], mocks.server.baseUrl)).rejects.toThrow('已变化');
    mocks.state.workflows = [wf];
    await expect(assertComfyRefmodSubmissionFresh(wf, [reference()], 'http://old.test:8188')).rejects.toThrow('已变化');
  });

  it('明确替换授权不能跨工作流或沿用到已更改原值的槽位', async () => {
    const wf = workflow();
    for (const selected of [boundReference({ workflowId: 'other', replaceExisting: true }),
      boundReference({ originalFileName: 'old-file', replaceExisting: true }),
      reference({ loaderNodeId: '12', slot: 1, replaceExisting: true })]) {
      await expect(applyComfyRefmodsToWorkflow(wf, JSON.parse(wf.fileContent), [selected])).rejects.toThrow('已变化');
    }
  });

  it('未绑定参考包时不加载目录或修改原有默认值', async () => {
    const wf = workflow();
    const execution = JSON.parse(wf.fileContent);
    await applyComfyRefmodsToWorkflow(wf, execution, undefined);
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(JSON.stringify(execution)).toBe(wf.fileContent);
  });

  it('部分目录读取失败时拒绝提交，保留引用与执行图', async () => {
    mocks.catalog.mockResolvedValue({ ...catalog, loaders: [], failedLoaderTypes: ['minimax-h3'] });
    const wf = workflow();
    const execution = JSON.parse(wf.fileContent);
    const selections = [boundReference()];
    await expect(applyComfyRefmodsToWorkflow(wf, execution, selections)).rejects.toThrow('尚未验证');
    expect(selections).toHaveLength(1);
    expect(JSON.stringify(execution)).toBe(wf.fileContent);
  });
});
