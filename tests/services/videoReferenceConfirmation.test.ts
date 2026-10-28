import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIVideoGenParams } from '../../src/types/aiTypes';

const mocks = vi.hoisted(() => ({
  hasReferences: vi.fn<(params: AIVideoGenParams) => Promise<boolean>>(),
  confirm: vi.fn<() => Promise<boolean>>(),
  prepare: vi.fn(),
  submit: vi.fn(),
  execute: vi.fn(),
}));

// The collector owns media resolution. These tests exercise the manual gate
// without loading providers, uploading files or submitting a generation task.
vi.mock('../../src/services/ai/generateVideo', () => ({
  hasVideoReferenceContent: mocks.hasReferences,
  generateVideo: mocks.submit,
}));
vi.mock('../../src/services/aiService', () => ({
  generateVideo: mocks.submit, generateText: vi.fn(), generateImage: vi.fn(),
  generateImagesBatch: vi.fn(), generateAudio: vi.fn(), buildPanoramaPrompt: vi.fn(),
}));
vi.mock('../../src/services/generationService', () => ({ executeGeneration: mocks.execute }));
vi.mock('../../src/services/confirmDialog', () => ({ confirmAction: mocks.confirm }));
vi.mock('../../src/services/pollManager', () => ({
  prepareMediaNodeGeneration: mocks.prepare,
  prepareVideoNodeGeneration: mocks.prepare,
  cancelNodePolling: vi.fn(), clearProjectTasks: vi.fn(), resumePendingTasks: vi.fn(),
}));

import { useAppStore } from '../../src/store/useAppStore';
import { confirmVideoReferencesBeforeGeneration } from '../../src/services/videoReferenceConfirmation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function holdConfirmation() {
  const opened = deferred<void>();
  const reply = deferred<boolean>();
  mocks.confirm.mockImplementationOnce(() => { opened.resolve(); return reply.promise; });
  return { opened: opened.promise, reply: reply.resolve };
}

const writes = {
  updateNodeData: vi.fn(), updateNodeDataTransient: vi.fn(), commitToHistory: vi.fn(),
  recordOutputHistory: vi.fn(async () => undefined), incrementRevision: vi.fn(),
};

function expectNoGenerationEffects() {
  for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const mock of [...Object.values(mocks), ...Object.values(writes)]) mock.mockReset();
  mocks.hasReferences.mockResolvedValue(false);
  mocks.confirm.mockResolvedValue(true);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1', projectLoadStatus: 'ready', switchingProjectName: null,
    isCreatingProject: false, isReturningToStartPage: false,
    projects: [{ id: 'project-1', name: '视频确认测试', createdAt: 1, updatedAt: 1 }],
    nodes: [
      { id: 'video-1', type: 'ai-video', position: { x: 0, y: 0 }, data: {
        type: 'ai-video', label: '镜头一', prompt: '人物走进房间，固定机位。',
        model: 'general/video-test', provider: 'general', status: 'success', videoUrl: 'old-video.mp4',
      } },
      { id: 'image-1', type: 'source-image', position: { x: -300, y: 0 }, data: {
        type: 'source-image', label: '尚未添加图片',
      } },
    ],
    edges: [], workflows: [], customStyles: [],
    showToast: vi.fn(), getCurrentRevision: () => 7,
    ...writes,
  });
});

describe('手动视频生成的参考素材确认', () => {
  it('取消时保留现有视频与节点状态，不 prepare、写历史或提交任务', async () => {
    mocks.confirm.mockResolvedValue(false);
    const initial = useAppStore.getState();

    await expect(confirmVideoReferencesBeforeGeneration('video-1')).resolves.toBe(false);

    expect(mocks.hasReferences).toHaveBeenCalledOnce();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(useAppStore.getState()).toBe(initial);
    expect(useAppStore.getState().nodes[0].data).toMatchObject({ status: 'success', videoUrl: 'old-video.mp4' });
    expectNoGenerationEffects();
  });

  it('已有有效参考时直接放行，不显示无参考确认框', async () => {
    mocks.hasReferences.mockResolvedValue(true);
    const initial = useAppStore.getState();

    await expect(confirmVideoReferencesBeforeGeneration('video-1')).resolves.toBe(true);

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toBe(initial);
    expectNoGenerationEffects();
  });

  it('没有参考时只有明确选择继续才放行，门禁自身不执行生成', async () => {
    await expect(confirmVideoReferencesBeforeGeneration('video-1')).resolves.toBe(true);

    expect(mocks.confirm).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      title: expect.any(String), okLabel: expect.any(String), cancelLabel: expect.any(String),
    }));
    expectNoGenerationEffects();
  });

  it('按本次覆盖提示词检查参考，不回写源节点提示词', async () => {
    const original = useAppStore.getState().nodes[0].data;
    const override = '只生成这次选中的镜头，缓慢推近。';

    await expect(confirmVideoReferencesBeforeGeneration('video-1', override)).resolves.toBe(true);

    expect(mocks.hasReferences).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'video-1', model: 'general/video-test', provider: 'general', prompt: override,
    }));
    expect(useAppStore.getState().nodes[0].data).toBe(original);
    expectNoGenerationEffects();
  });

  it.each(['dialog', 'collector'] as const)('%s 抛错时失败关闭，并释放下一次确认的占用', async (failure) => {
    const error = new Error('模拟确认或参考读取失败');
    if (failure === 'dialog') mocks.confirm.mockRejectedValueOnce(error);
    else mocks.hasReferences.mockRejectedValueOnce(error);

    await expect(confirmVideoReferencesBeforeGeneration('video-1')).rejects.toBe(error);
    expectNoGenerationEffects();

    await expect(confirmVideoReferencesBeforeGeneration('video-1')).resolves.toBe(true);
    expect(mocks.confirm).toHaveBeenCalledTimes(failure === 'dialog' ? 2 : 1);
    expectNoGenerationEffects();
  });

  it('等待确认时切换项目，即使继续也不能给旧请求放行', async () => {
    const dialog = holdConfirmation();
    const pending = confirmVideoReferencesBeforeGeneration('video-1');
    await dialog.opened;
    useAppStore.setState({ currentProjectId: 'project-2' });
    dialog.reply(true);

    await expect(pending).resolves.toBe(false);
    expect(useAppStore.getState().currentProjectId).toBe('project-2');
    expectNoGenerationEffects();
  });

  it('切走再切回相同项目和节点仍拒绝旧确认', async () => {
    const dialog = holdConfirmation();
    const pending = confirmVideoReferencesBeforeGeneration('video-1');
    await dialog.opened;
    useAppStore.setState({ currentProjectId: 'project-2' });
    useAppStore.setState({ currentProjectId: 'project-1' });
    dialog.reply(true);

    await expect(pending).resolves.toBe(false);
    expectNoGenerationEffects();
  });

  it('等待确认时修改源提示词，不能放行旧提示词或覆盖用户编辑', async () => {
    const dialog = holdConfirmation();
    const pending = confirmVideoReferencesBeforeGeneration('video-1');
    await dialog.opened;
    useAppStore.setState((state) => ({ nodes: state.nodes.map((node) => node.id === 'video-1'
      ? { ...node, data: { ...node.data, prompt: '用户后来修改的提示词' } } : node) }));
    dialog.reply(true);

    await expect(pending).resolves.toBe(false);
    expect(useAppStore.getState().nodes[0].data.prompt).toBe('用户后来修改的提示词');
    expectNoGenerationEffects();
  });

  it('参考检查期间关闭又重开节点弹窗，不弹出迟到的旧确认', async () => {
    useAppStore.setState({ activeNodeId: 'video-1' });
    const references = deferred<boolean>();
    mocks.hasReferences.mockReturnValueOnce(references.promise);
    const pending = confirmVideoReferencesBeforeGeneration('video-1');
    useAppStore.setState({ activeNodeId: null });
    useAppStore.setState({ activeNodeId: 'video-1' });
    references.resolve(false);

    await expect(pending).resolves.toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expectNoGenerationEffects();
  });

  it('等待确认时参考节点内容变化，即使视频节点和 revision 不变也拒绝', async () => {
    useAppStore.setState({ edges: [{ id: 'reference-edge', source: 'image-1', target: 'video-1' }] });
    const videoData = useAppStore.getState().nodes[0].data;
    const dialog = holdConfirmation();
    const pending = confirmVideoReferencesBeforeGeneration('video-1');
    await dialog.opened;
    useAppStore.setState((state) => ({ nodes: state.nodes.map((node) => node.id === 'image-1'
      ? { ...node, data: { ...node.data, imageUrl: 'https://example.test/new-reference.png' } } : node) }));
    dialog.reply(true);

    await expect(pending).resolves.toBe(false);
    expect(useAppStore.getState().nodes[0].data).toBe(videoData);
    expectNoGenerationEffects();
  });

  it.each([false, true])('等待异步参考检查时发生导航，结果为 %s 都不放行旧请求', async (hasReferences) => {
    const references = deferred<boolean>();
    mocks.hasReferences.mockReturnValueOnce(references.promise);
    const pending = confirmVideoReferencesBeforeGeneration('video-1');
    useAppStore.setState({ currentProjectId: 'project-2' });
    references.resolve(hasReferences);

    await expect(pending).resolves.toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expectNoGenerationEffects();
  });

  it('参考检查尚未结束时也拒绝同节点重复请求，不重复解析参考', async () => {
    const references = deferred<boolean>();
    mocks.hasReferences.mockReturnValueOnce(references.promise);
    const first = confirmVideoReferencesBeforeGeneration('video-1');

    await expect(confirmVideoReferencesBeforeGeneration('video-1')).resolves.toBe(false);
    expect(mocks.hasReferences).toHaveBeenCalledOnce();
    references.resolve(true);

    await expect(first).resolves.toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expectNoGenerationEffects();
  });

  it('同一节点等待期间拒绝重复许可，取消后下一次点击可重新确认', async () => {
    const dialog = holdConfirmation();
    const first = confirmVideoReferencesBeforeGeneration('video-1');
    await dialog.opened;

    await expect(confirmVideoReferencesBeforeGeneration('video-1')).resolves.toBe(false);
    expect(mocks.confirm).toHaveBeenCalledOnce();
    dialog.reply(false);
    await expect(first).resolves.toBe(false);

    await expect(confirmVideoReferencesBeforeGeneration('video-1')).resolves.toBe(true);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expectNoGenerationEffects();
  });
});
