import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { ComfyRefmodSelection } from '../../src/types/comfyRefmod';
import { buildComfyRefmodMention } from '../../src/utils/comfyRefmodMention';

const mocks = vi.hoisted(() => ({
  state: {} as AppState,
  prepare: vi.fn(),
  MappingRequired: class extends Error {},
}));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state } }));
vi.mock('../../src/services/workflowExecutionService', () => ({ isCloudWorkflow: () => false }));
vi.mock('../../src/services/canvasDerivationGuard', () => ({
  registerCanvasDerivation: (state: AppState) => ({ projectId: state.currentProjectId }),
  isCanvasDerivationFresh: (guard: { projectId: string }, state: AppState) => guard.projectId === state.currentProjectId,
  completeCanvasDerivation: vi.fn(),
}));
vi.mock('../../src/services/comfyRefmodWorkflow', () => ({
  prepareComfyRefmodSelections: mocks.prepare,
  ComfyRefmodMappingRequiredError: mocks.MappingRequired,
}));
import { appendRefmodsToVideoNode } from '../../src/services/comfyRefmodNodeService';

const fingerprint = 'a'.repeat(64);
function ref(fileName = 'alice', slot?: number): ComfyRefmodSelection {
  return { endpointFingerprint: fingerprint, loaderType: 'minimax-h3', fileName, strength: 1,
    ...(slot === undefined ? {} : { loaderNodeId: '12', slot, workflowId: 'wf', originalFileName: '(none)' }) };
}
beforeEach(() => {
  mocks.prepare.mockReset();
  mocks.state = { currentProjectId: 'project', workflows: [{ id: 'wf', name: 'H3', category: 'ai-video', fileName: 'h3.json', fileContent: '{}', createdAt: 1 }],
    nodes: [{ id: 'v', type: 'ai-video', position: { x: 0, y: 0 }, data: { type: 'ai-video', label: 'H3', workflowId: 'wf', provider: 'comfyui', prompt: '' } }],
    updateNodeData: vi.fn(),
  } as unknown as AppState;
});

describe('RefMod 资源添加的调用方映射与身份边界', () => {
  it('提示词胶囊参与占槽，但不会被自动转换为手工绑定', async () => {
    const token = ref('bob', 1);
    mocks.state.nodes[0].data.prompt = buildComfyRefmodMention(token, 'Bob');
    mocks.prepare.mockResolvedValue([token, ref('alice', 2)]);
    await appendRefmodsToVideoNode('v', [ref()], 'project');
    expect(mocks.prepare.mock.calls[0][2]).toEqual([token]);
    expect(mocks.state.updateNodeData).toHaveBeenCalledWith('v', { comfyRefmods: [ref('alice', 2)] });
  });

  it('仅可消解的槽位歧义打开映射，最终保存 fresh 校验结果', async () => {
    const mapped = { ...ref('alice', 2), strength: 0.3 };
    mocks.prepare.mockRejectedValueOnce(new mocks.MappingRequired('请选择槽位')).mockResolvedValueOnce([mapped]);
    const resolve = vi.fn().mockResolvedValue([mapped]);
    await appendRefmodsToVideoNode('v', [ref()], 'project', resolve);
    expect(resolve).toHaveBeenCalledOnce();
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(mocks.state.updateNodeData).toHaveBeenCalledWith('v', { comfyRefmods: [mapped] });
  });

  it('网络错误不转入映射，取消或替换文件身份不写入', async () => {
    const resolve = vi.fn();
    mocks.prepare.mockRejectedValueOnce(new Error('服务离线'));
    await expect(appendRefmodsToVideoNode('v', [ref()], 'project', resolve)).rejects.toThrow('离线');
    expect(resolve).not.toHaveBeenCalled();
    mocks.prepare.mockRejectedValueOnce(new mocks.MappingRequired('请选择'));
    resolve.mockRejectedValueOnce(new Error('已取消'));
    await expect(appendRefmodsToVideoNode('v', [ref()], 'project', resolve)).rejects.toThrow('已取消');
    mocks.prepare.mockRejectedValueOnce(new mocks.MappingRequired('请选择'));
    resolve.mockResolvedValueOnce([ref('bob', 2)]);
    await expect(appendRefmodsToVideoNode('v', [ref()], 'project', resolve)).rejects.toThrow('映射已变化');
    expect(mocks.state.updateNodeData).not.toHaveBeenCalled();
  });

  it('目录或映射等待期间切项目，不打开迟到弹窗或写入旧节点', async () => {
    const resolve = vi.fn();
    mocks.prepare.mockImplementationOnce(async () => {
      mocks.state.currentProjectId = 'other';
      throw new mocks.MappingRequired('请选择');
    });
    await expect(appendRefmodsToVideoNode('v', [ref()], 'project', resolve)).rejects.toThrow('画布或工作流');
    expect(resolve).not.toHaveBeenCalled();
    expect(mocks.state.updateNodeData).not.toHaveBeenCalled();
  });

  it('映射窗口打开后提示词变化，即使同一节点也拒绝迟到结果', async () => {
    mocks.prepare.mockRejectedValueOnce(new mocks.MappingRequired('请选择'));
    const resolve = vi.fn().mockImplementation(async () => {
      mocks.state.nodes[0].data.prompt = '新的提示词';
      return [ref('alice', 2)];
    });
    await expect(appendRefmodsToVideoNode('v', [ref()], 'project', resolve)).rejects.toThrow('画布或工作流');
    expect(mocks.state.updateNodeData).not.toHaveBeenCalled();
  });
});
