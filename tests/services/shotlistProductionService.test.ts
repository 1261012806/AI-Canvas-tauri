import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { prepareShotlistProduction } from '../../src/services/shotlistProductionService';
import { updateShotlistRows } from '../../src/services/shotlistService';
import { clearAgentToolRegistryForTests, getAgentTool, getAvailableAgentTools, prepareAgentToolCall, type AgentToolContext } from '../../src/services/chat/toolRegistry';
import { registerShotlistAgentTools } from '../../src/services/chat/tools/shotlistTools';
import { searchMcpToolCatalog } from '../../src/services/mcp/mcpToolCatalog';

const scope = () => ({ projectId: 'ep', baseRevision: useAppStore.getState().getCurrentRevision() });
const context = (): AgentToolContext => ({ ...scope(), conversationId: 'mcp-control-ep', taskId: '', mode: 'autonomous', signal: new AbortController().signal });
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'ep', projectLoadStatus: 'ready', showToast: vi.fn(),
    projects: [{ id: 'ep', name: '集', createdAt: 1, updatedAt: 1, settings: { defaultModels: { audio: 'general/tts', video: 'general/video' } } }],
    nodes: [{ id: 'sheet', type: 'ai-shotlist', position: { x: 0, y: 0 }, data: { type: 'ai-shotlist', label: '镜头', prompt: '保留剧本引用', shotlistRows: [
      { id: 'r1', shotNo: '1', content: '林夏站在月台', dialogue: '终于等到你了', audio: '列车进站声', camera: '推近', duration: 4,
        frame: { nodeId: 'frame', kind: 'image', url: 'PRIVATE_URL', filePath: 'PRIVATE_PATH' } },
      { id: 'r2', shotNo: '2', content: '列车驶入' },
    ] } }, { id: 'frame', type: 'source-image', position: { x: -300, y: 0 }, data: { type: 'source-image', label: '参考画面', imageUrl: 'PRIVATE_URL' } }],
  });
  clearAgentToolRegistryForTests();
  registerShotlistAgentTools();
});

describe('镜头制作准备', () => {
  it('分镜时长向上取整，新节点自动跟随；MCP 修改和撤销同时恢复分镜与视频', async () => {
    updateShotlistRows(scope(), 'sheet', 'update', [{ id: 'r1', duration: 4.3 }]);
    const [result] = prepareShotlistProduction(scope(), 'sheet', ['r1'], 'video');
    const video = () => useAppStore.getState().nodes.find((n) => n.id === result.nodeId)!;
    expect(video().data.seedanceDuration).toBe(5);
    useAppStore.getState().updateNodeDataTransient(result.nodeId, { videoUrl: 'keep.mp4', status: 'success' });
    updateShotlistRows(scope(), 'sheet', 'update', [{ id: 'r1', duration: 8.1 }]);
    expect(video().data).toMatchObject({ seedanceDuration: 9, videoUrl: 'keep.mp4', status: 'success' });
    await useAppStore.getState().undo();
    expect(video().data.seedanceDuration).toBe(5);
    expect(useAppStore.getState().nodes.find((n) => n.id === 'sheet')!.data.shotlistRows![0].duration).toBe(4.3);
    await useAppStore.getState().redo();
    expect(video().data.seedanceDuration).toBe(9);
  });

  it('界面瞬时编辑同步，但视频手动时长永久保留，其他镜头不变', () => {
    const results = prepareShotlistProduction(scope(), 'sheet', ['r1', 'r2'], 'video');
    const video = (i: number) => useAppStore.getState().nodes.find((n) => n.id === results[i].nodeId)!;
    const edit = (duration: number | undefined) => {
      const rows = useAppStore.getState().nodes.find((n) => n.id === 'sheet')!.data.shotlistRows!;
      useAppStore.getState().updateNodeDataTransient('sheet', { shotlistRows: rows.map((r) => r.id === 'r1' ? { ...r, duration } : r) });
    };
    expect(video(1).data.seedanceDuration).toBeUndefined();
    edit(6.2);
    expect(video(0).data.seedanceDuration).toBe(7);
    edit(undefined);
    edit(0);
    expect(video(0).data.seedanceDuration).toBe(7);
    useAppStore.getState().updateNodesDataBatch([results[0].nodeId], { seedanceDuration: 12 });
    edit(12);
    edit(8.1);
    expect(video(0).data.seedanceDuration).toBe(12);
    expect(video(0).data.shotlistProductionSource?.durationSync).toBe('manual');
    expect(video(1).data.seedanceDuration).toBeUndefined();
    expect(prepareShotlistProduction(scope(), 'sheet', ['r1'], 'video')[0].status).toBe('reused');
    expect(video(0).data.seedanceDuration).toBe(12);
  });

  it('旧节点仅在仍匹配旧分镜时同步；无来源节点不按名称猜测', () => {
    const [result] = prepareShotlistProduction(scope(), 'sheet', ['r1'], 'video');
    useAppStore.getState().updateNodeDataTransient(result.nodeId, {
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'r1', kind: 'video' },
    });
    updateShotlistRows(scope(), 'sheet', 'update', [{ id: 'r1', duration: 9.3 }]);
    expect(useAppStore.getState().nodes.find((n) => n.id === result.nodeId)!.data.seedanceDuration).toBe(10);
    useAppStore.getState().updateNodeDataTransient(result.nodeId, { shotlistProductionSource: undefined });
    updateShotlistRows(scope(), 'sheet', 'update', [{ id: 'r1', duration: 6 }]);
    expect(useAppStore.getState().nodes.find((n) => n.id === result.nodeId)!.data.seedanceDuration).toBe(10);
  });
  it('配音只放对白和语音用途，一次历史，重复定位保留人工修改', () => {
    const commit = vi.fn(useAppStore.getState().commitToHistory);
    useAppStore.setState({ commitToHistory: commit });
    const [result] = prepareShotlistProduction(scope(), 'sheet', ['r1'], 'voiceover');
    const node = useAppStore.getState().nodes.find((item) => item.id === result.nodeId)!;
    expect(node.data).toMatchObject({ type: 'ai-audio', status: 'idle', prompt: '终于等到你了', audioPurpose: 'speech', model: 'general/tts',
      shotlistProductionSource: { nodeId: 'sheet', rowId: 'r1', kind: 'voiceover' } });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().edges).not.toContainEqual(expect.objectContaining({ source: node.id, target: 'sheet' }));
    expect(useAppStore.getState().nodes.find((item) => item.id === 'sheet')!.data.prompt).toBe('保留剧本引用');
    useAppStore.getState().updateNodeDataTransient(node.id, { prompt: '人工对白' });
    expect(prepareShotlistProduction(scope(), 'sheet', ['r1'], 'voiceover')[0]).toMatchObject({ nodeId: node.id, status: 'reused' });
    expect(useAppStore.getState().nodes.find((item) => item.id === node.id)!.data.prompt).toBe('人工对白');
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('视频引用真实画面节点，不把快照路径复制进提示词', () => {
    const [result] = prepareShotlistProduction(scope(), 'sheet', ['r1'], 'video');
    const state = useAppStore.getState();
    const node = state.nodes.find((item) => item.id === result.nodeId)!;
    expect(node.data.prompt).toContain('推近，林夏站在月台');
    expect(node.data.prompt).toContain('对白：终于等到你了');
    expect(node.data.prompt).toContain('音效/音乐：列车进站声');
    expect(node.data.prompt).toContain('@{frame:参考画面}');
    expect(node.data.prompt).not.toContain('PRIVATE_');
    expect(state.edges).toContainEqual(expect.objectContaining({ source: 'frame', target: node.id }));
    expect(state.edges).not.toContainEqual(expect.objectContaining({ source: node.id, target: 'sheet' }));
    expect(state.nodes.find((item) => item.id === 'sheet')!.data.prompt).toBe('保留剧本引用');
    expect(node.data.model).toBe('general/video');
  });

  it('导演台带独立镜头说明且位置不重叠，不伪造场景或成果', async () => {
    const before = structuredClone(useAppStore.getState().nodes);
    const [result] = prepareShotlistProduction(scope(), 'sheet', ['r1'], 'director');
    const state = useAppStore.getState();
    const director = state.nodes.find((item) => item.id === result.nodeId)!;
    const brief = state.nodes.find((item) => item.type === 'source-text')!;
    expect(brief.data.output).toContain('林夏站在月台');
    expect(brief.position.x + 320).toBeLessThan(director.position.x);
    expect(director.data.directorScene).toBeUndefined();
    expect(director.data.directorResultManifest).toBeUndefined();
    expect(director.data.directorStatus).toBe('idle');
    expect(state.edges).toContainEqual(expect.objectContaining({ source: brief.id, target: director.id }));
    await state.undo();
    expect(useAppStore.getState().nodes.map((item) => item.id)).toEqual(before.map((item) => item.id));
    await useAppStore.getState().redo();
    expect(useAppStore.getState().nodes.find((item) => item.id === director.id)!.data.shotlistProductionSource?.rowId).toBe('r1');
  });

  it('无对白、重复 ID、已删镜头和跨项目全部拒绝且不留下部分节点', () => {
    const before = useAppStore.getState().nodes;
    for (const ids of [['r1', 'r2'], ['r1', 'r1'], ['r1', 'missing'], []]) {
      expect(() => prepareShotlistProduction(scope(), 'sheet', ids, 'voiceover')).toThrow();
      expect(useAppStore.getState().nodes).toBe(before);
    }
    expect(() => prepareShotlistProduction({ projectId: 'other' }, 'sheet', ['r1'], 'video')).toThrow();
    expect(() => prepareShotlistProduction({ ...scope(), baseRevision: -1 }, 'sheet', ['r1'], 'video')).toThrow();
  });

  it('同镜头存在多个同类制作节点时不猜测或覆盖', () => {
    const [result] = prepareShotlistProduction(scope(), 'sheet', ['r1'], 'video');
    const node = useAppStore.getState().nodes.find((item) => item.id === result.nodeId)!;
    useAppStore.getState().addNode({ ...structuredClone(node), id: 'duplicate' });
    const count = useAppStore.getState().nodes.length;
    expect(() => prepareShotlistProduction(scope(), 'sheet', ['r1'], 'video')).toThrow('多个制作节点');
    expect(useAppStore.getState().nodes).toHaveLength(count);
  });

  it('助手与 MCP 发现和调用同一画布写工具；Plan 不开放，读取可追溯节点', async () => {
    const tool = getAgentTool('shotlist_prepare_production')!;
    expect(tool.effect).toBe('canvas_write');
    expect(getAvailableAgentTools({ ...context(), mode: 'plan' }).map((item) => item.id)).not.toContain(tool.id);
    expect(searchMcpToolCatalog(context(), { query: 'shotlist_prepare_production', category: 'shotlist' }).tools.map((item) => item.name)).toContain(tool.id);
    expect(prepareAgentToolCall({ callId: 'bad', toolId: tool.id, input: { nodeId: 'sheet', rowIds: ['r1'], kind: 'arbitrary' } }, context()).ok).toBe(false);
    expect((await tool.execute({ ...context(), baseRevision: -1 }, { nodeId: 'sheet', rowIds: ['r1'], kind: 'video' })).status).toBe('error');
    expect((await tool.execute(context(), { nodeId: 'sheet', rowIds: ['r1'], kind: 'voiceover' })).status).toBe('success');
    const read = await getAgentTool('shotlist_read')!.execute(context(), { nodeId: 'sheet' });
    expect(JSON.parse(read.modelContent).rows[0].productionNodes[0]).toMatchObject({ kind: 'voiceover', status: 'idle' });
    expect(read.modelContent).not.toContain('PRIVATE_');
  });
});
