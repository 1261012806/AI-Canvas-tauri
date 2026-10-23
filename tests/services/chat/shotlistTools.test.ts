import { beforeEach, describe, expect, it, vi } from 'vitest';
const frames = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/shotlistFrameService', () => ({ generateShotlistFrames: frames, MAX_SHOTLIST_FRAME_BATCH: 12 }));
import { useAppStore } from '../../../src/store/useAppStore';
import { clearAgentToolRegistryForTests, getAgentTool, getAvailableAgentTools, prepareAgentToolCall, type AgentToolContext } from '../../../src/services/chat/toolRegistry';
import { registerShotlistAgentTools } from '../../../src/services/chat/tools/shotlistTools';
import { searchMcpToolCatalog } from '../../../src/services/mcp/mcpToolCatalog';

const context = (): AgentToolContext => ({ projectId: 'ep', conversationId: 'chat', taskId: 'task', mode: 'autonomous',
  baseRevision: useAppStore.getState().getCurrentRevision(), signal: new AbortController().signal });

beforeEach(() => {
  frames.mockReset();
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'ep', projectLoadStatus: 'ready', showToast: vi.fn(),
    projects: [{ id: 'ep', name: '集', parentId: 'series', createdAt: 1, updatedAt: 1, episodeScript: '正文', settings: { defaultModels: { image: 'general/image' } } }],
    nodes: [{ id: 'sheet', type: 'ai-shotlist', position: { x: 0, y: 0 }, data: { type: 'ai-shotlist', label: '分镜', shotlistRows: [
      { id: 'r1', shotNo: '1', content: '剧本'.repeat(300), frame: { nodeId: 'pic', kind: 'image', filePath: 'SECRET_PATH', url: 'SECRET_URL' },
        frameAnalysis: { secret: 'PRIVATE_ANALYSIS' } as never },
    ] } }],
  });
  registerShotlistAgentTools();
});

describe('分镜工具', () => {
  it('读取稳定 ID 与分段文字，不泄漏画面路径、URL 或拉片内部数据', async () => {
    const read = getAgentTool('shotlist_read')!;
    const result = await read.execute(context(), { nodeId: 'sheet' });
    expect(result.status).toBe('success');
    expect(result.modelContent).not.toMatch(/SECRET_|PRIVATE_ANALYSIS/);
    const data = JSON.parse(result.modelContent);
    expect(data.rows[0]).toMatchObject({ id: 'r1', mention: '@{sheet/shot/r1:分镜 · 镜1}', frame: { nodeId: 'pic', kind: 'image' }, truncatedFields: ['content'] });
    expect(data.rows[0].content).toHaveLength(400);
    const next = await read.execute(context(), { nodeId: 'sheet', textOffset: 400 });
    expect(JSON.parse(next.modelContent).rows[0].content).toHaveLength(200);
  });

  it('读取独立成片的稳定身份/就绪状态，实时源优先于快照且不泄漏路径', async () => {
    const state = useAppStore.getState();
    const sheet = state.nodes[0];
    useAppStore.setState({ nodes: [{ ...sheet, data: { ...sheet.data, shotlistRows: [
      { id: 'ready', shotNo: '1', video: { nodeId: 'ready-source', kind: 'video', filePath: 'SECRET_PATH', url: 'SECRET_SNAPSHOT' } },
      { id: 'pending', shotNo: '2', video: { nodeId: 'pending-source', kind: 'video', url: 'SECRET_OLD_VIDEO' } },
      { id: 'fallback', shotNo: '3', video: { nodeId: 'deleted-source', kind: 'video', url: 'SECRET_FALLBACK' } },
      { id: 'unbound', shotNo: '4', video: null },
      { id: 'new', shotNo: '5' },
    ] } },
    { id: 'ready-source', type: 'source-video', position: { x: 0, y: 0 }, data: { type: 'source-video', label: 'ready', videoUrl: 'SECRET_REAL_VIDEO' } },
    { id: 'pending-source', type: 'ai-video', position: { x: 0, y: 0 }, data: { type: 'ai-video', label: 'pending' } },
    ] });
    const result = await getAgentTool('shotlist_read')!.execute(context(), { nodeId: 'sheet' });
    expect(result.status).toBe('success');
    expect(result.modelContent).not.toContain('SECRET_');
    const rows = JSON.parse(result.modelContent).rows;
    expect(rows.map((row: { video?: unknown }) => row.video)).toEqual([
      { nodeId: 'ready-source', kind: 'video', ready: true },
      { nodeId: 'pending-source', kind: 'video', ready: false },
      { nodeId: 'deleted-source', kind: 'video', ready: true }, null, undefined,
    ]);
  });

  it('写工具本地 schema 拒绝媒体字段，旧 revision 不写画布', async () => {
    const invalid = prepareAgentToolCall({ callId: 'call', toolId: 'shotlist_update_rows', input: { nodeId: 'sheet', mode: 'update', rows: [{ id: 'r1', frame: { url: 'bad' } }] } }, context());
    expect(invalid.ok).toBe(false);
    expect(prepareAgentToolCall({ callId: 'video', toolId: 'shotlist_update_rows', input: { nodeId: 'sheet', mode: 'update',
      rows: [{ id: 'r1', video: { nodeId: 'fake', kind: 'video' } }] } }, context()).ok).toBe(false);
    const result = await getAgentTool('shotlist_update_rows')!.execute({ ...context(), baseRevision: -1 }, { nodeId: 'sheet', mode: 'update', rows: [{ id: 'r1', content: 'bad' }] });
    expect(result.status).toBe('error');
    expect(useAppStore.getState().nodes[0].data.shotlistRows?.[0].content).not.toBe('bad');
  });

  it('Plan 只暴露读取与差异检查；MCP 发现不依赖真实 taskId', () => {
    expect(getAvailableAgentTools({ ...context(), mode: 'plan' }).map((tool) => tool.id)).toEqual(['shotlist_script_changes', 'shotlist_read']);
    expect(getAvailableAgentTools({ ...context(), taskId: '' }).map((tool) => tool.id)).toContain('shotlist_generate_frames');
    expect(getAgentTool('shotlist_generate_frames')!.effect).toBe('media_generation');
    expect(getAgentTool('shotlist_update_rows')!.effect).toBe('canvas_write');
    const catalog = searchMcpToolCatalog(context(), { query: '补图', category: 'shotlist' });
    expect(catalog.tools.map((tool) => tool.name)).toContain('shotlist_generate_frames');
  });

  it('协作模式没有本轮模型引用时拒绝生成，MCP 自主模式可用项目默认', async () => {
    const tool = getAgentTool('shotlist_generate_frames')!;
    const input = { nodeId: 'sheet', rowIds: ['r1'] };
    const resolved = tool.resolveInput!(input, context()) as typeof input & { modelRef: string };
    expect(resolved.modelRef).toBe('general/image');
    expect(tool.authorize!({ ...context(), mode: 'collaborative' }, resolved).allowed).toBe(false);
    expect(tool.authorize!({ ...context(), taskId: '' }, resolved).allowed).toBe(true);
    frames.mockResolvedValue([{ rowId: 'r1', status: 'error' }]);
    const result = await tool.execute(context(), resolved);
    expect(result.status).toBe('error');
    expect(result.retryable).toBe(false);
    expect(frames).toHaveBeenCalledTimes(1);
  });

  it('省略工具模型参数时优先使用本轮显式引用，并拒绝与该引用不一致的模型', () => {
    const task = useAppStore.getState().createAgentTask({ projectId: 'ep', conversationId: 'chat', userMessageId: 'user',
      mode: 'collaborative', goal: '用 @model{general/selected|本轮模型} 补齐空镜' });
    const toolContext = { ...context(), taskId: task.id, mode: 'collaborative' as const };
    const prepared = prepareAgentToolCall({ callId: 'selected', toolId: 'shotlist_generate_frames',
      input: { nodeId: 'sheet', rowIds: ['r1'] } }, toolContext);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('Expected prepared tool');
    expect(prepared.prepared.input).toMatchObject({ modelRef: 'general/selected' });
    const tool = getAgentTool('shotlist_generate_frames')!;
    expect(tool.authorize!(toolContext, prepared.prepared.input).allowed).toBe(true);
    expect(tool.authorize!(toolContext, { nodeId: 'sheet', rowIds: ['r1'], modelRef: 'general/image' }).allowed).toBe(false);
  });
});
