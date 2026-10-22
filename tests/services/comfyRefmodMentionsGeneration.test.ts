import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComfyRefmodSelection } from '../../src/types/comfyRefmod';
import { useAppStore } from '../../src/store/useAppStore';
import { buildComfyRefmodMention } from '../../src/utils/comfyRefmodMention';

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../src/services/comfyWorkflowService', () => ({ executeComfyUIVideoGenerate: mocks.execute }));
import { generateVideo } from '../../src/services/ai/generateVideo';

const ref: ComfyRefmodSelection = { endpointFingerprint: 'a'.repeat(64), loaderType: 'minimax-h3', fileName: 'alice', strength: 0.8,
  workflowId: 'wf', loaderNodeId: '12', slot: 1, originalFileName: '(none)' };
const token = buildComfyRefmodMention(ref, '女主');
const options = { prompt: `走向镜头 ${token}`, provider: 'comfyui', model: 'comfyui/workflow', workflowId: 'wf', nodeId: 'v' };

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'p', nodes: [{ id: 'v', type: 'ai-video', position: { x: 0, y: 0 }, data: {
    type: 'ai-video', label: '视频', ...options,
  } }], workflows: [{ id: 'wf', name: 'H3', category: 'ai-video', fileName: 'h3.json', createdAt: 1,
    fileContent: JSON.stringify({ '12': { class_type: 'MiniMaxH3RefModsLoader', inputs: { mod_1: '(none)', strength_1: 1 } } }) }] });
  mocks.execute.mockReset();
  mocks.execute.mockImplementation(async (_params, _signal, _audio, _media, beforeSubmit) => {
    await beforeSubmit?.();
    return { url: 'https://cdn.example/video.mp4' };
  });
});

describe('RefMod token 视频提交', () => {
  it('只有 token 的引用也注入本地模型参数，原文与 IO token 不进入媒体上传', async () => {
    await generateVideo({ ...options, workflowInputs: { '2': token } });
    const [params, , audio, media, beforeSubmit] = mocks.execute.mock.calls[0];
    expect(params.comfyRefmods).toEqual([ref]);
    expect(params.prompt).not.toContain('@refmod');
    expect(params.workflowInputs['2']).toBe(' ');
    expect(audio).toEqual([]);
    expect(media).toEqual({ imageUrls: [], videoUrls: [] });
    expect(beforeSubmit).toBeTypeOf('function');
  });

  it('token 删除后不继续沿用上一轮引用', async () => {
    await generateVideo({ ...options, prompt: '走向镜头' });
    expect(mocks.execute.mock.calls[0][0].comfyRefmods).toBeUndefined();
  });

  it('异步准备期间删除引用会在最终提交前拒绝，不重投', async () => {
    let submitted = 0;
    mocks.execute.mockImplementation(async (_params, _signal, _audio, _media, beforeSubmit) => {
      useAppStore.getState().updateNodeDataTransient('v', { prompt: '角色引用已删除' });
      await beforeSubmit();
      submitted += 1;
      return { url: 'https://cdn.example/video.mp4' };
    });
    await expect(generateVideo(options)).rejects.toThrow('已变化');
    expect(submitted).toBe(0);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('切换项目或把 token 用于远端模型时拒绝提交', async () => {
    await expect(generateVideo({ ...options, workflowId: undefined, provider: 'general', model: 'general/test' })).rejects.toThrow('仅能用于本地');
    expect(mocks.execute).not.toHaveBeenCalled();
    mocks.execute.mockImplementation(async (_params, _signal, _audio, _media, beforeSubmit) => {
      useAppStore.setState({ currentProjectId: 'other' });
      await beforeSubmit();
      return { url: 'https://cdn.example/video.mp4' };
    });
    await expect(generateVideo(options)).rejects.toThrow('已变化');
  });

  it('切换本地工作流后不能沿用旧 token 的槽位授权', async () => {
    const state = useAppStore.getState();
    useAppStore.setState({ workflows: [{ ...state.workflows[0], id: 'other' }] });
    useAppStore.getState().updateNodeDataTransient('v', { workflowId: 'other' });
    await expect(generateVideo({ ...options, workflowId: 'other' })).rejects.toThrow('属于其他工作流');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
