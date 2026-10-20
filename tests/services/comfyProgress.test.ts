import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { createServer as createViteServer } from 'vite';
import viteConfig from '../../vite.config';
import { createComfyProgressSession, parseComfyProgressEvent } from '../../src/services/comfyProgress';
import { comfyFetch } from '../../src/services/comfyPolling';
import { connectNativeComfyProgress } from '../../src/services/comfyProgressTransport';
import { useAppStore } from '../../src/store/useAppStore';

vi.mock('../../src/services/comfyPolling', () => ({ comfyFetch: vi.fn() }));
vi.mock('../../src/services/comfyProgressTransport', () => ({ connectNativeComfyProgress: vi.fn() }));

const nativeConnections: Array<{
  options: Parameters<typeof connectNativeComfyProgress>[0];
  close: ReturnType<typeof vi.fn>;
}> = [];

class MockWebSocket {
  static CLOSING = 2;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

beforeEach(() => {
  vi.stubGlobal('window', { location: new URL('http://localhost:1420') });
  MockWebSocket.instances = [];
  nativeConnections.length = 0;
  vi.mocked(connectNativeComfyProgress).mockReset().mockImplementation((options) => {
    const close = vi.fn();
    nativeConnections.push({ options, close });
    return close;
  });
  vi.mocked(comfyFetch).mockReset();
  useAppStore.setState(useAppStore.getInitialState(), true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('parseComfyProgressEvent', () => {
  it('解析旧版 progress 的真实采样步数', () => {
    expect(parseComfyProgressEvent(JSON.stringify({
      type: 'progress',
      data: { prompt_id: 'prompt-1', node: '12', value: 7, max: 20 },
    }))).toEqual({
      eventType: 'progress',
      promptId: 'prompt-1',
      stage: 'running',
      executingNodeId: '12',
      value: 7,
      max: 20,
      percent: 35,
    });
  });

  it('解析新版 progress_state 中正在运行的节点', () => {
    expect(parseComfyProgressEvent({
      type: 'progress_state',
      data: {
        prompt_id: 'prompt-2',
        nodes: {
          '4': { state: 'finished', value: 1, max: 1 },
          '8': { state: 'running', value: 3, max: 8, display_node_id: '采样器' },
        },
      },
    })).toEqual({
      eventType: 'progress_state',
      promptId: 'prompt-2',
      stage: 'running',
      executingNodeId: '8',
      displayNodeId: '采样器',
      value: 3,
      max: 8,
      percent: 38,
    });
  });

  it('已报告节点全结束时仍等待下一节点，不把局部快照当成整个任务完成', () => {
    expect(parseComfyProgressEvent({
      type: 'progress_state',
      data: {
        prompt_id: 'prompt-3',
        nodes: {
          '4': { state: 'finished', value: 1, max: 1 },
          '8': { state: 'finished', value: 20, max: 20 },
        },
      },
    })).toEqual({ eventType: 'progress_state', promptId: 'prompt-3', stage: 'running' });
  });

  it('忽略格式错误、未知类型和无效总量', () => {
    expect(parseComfyProgressEvent('{bad json')).toBeNull();
    expect(parseComfyProgressEvent({ type: 'status', data: {} })).toBeNull();
    expect(parseComfyProgressEvent({
      type: 'progress',
      data: { value: 4, max: 0 },
    })).toEqual({
      eventType: 'progress',
      promptId: undefined,
      stage: 'running',
      executingNodeId: undefined,
    });
  });

  it('读取缓存节点和动态节点的显示身份，执行开始即进入运行态', () => {
    expect(parseComfyProgressEvent({ type: 'execution_start', data: { prompt_id: 'p1' } }))
      .toMatchObject({ stage: 'running', eventType: 'execution_start' });
    expect(parseComfyProgressEvent({ type: 'execution_cached', data: { prompt_id: 'p1', nodes: ['4', '4', 7, ''] } }))
      .toMatchObject({ cachedNodeIds: ['4', '4'] });
    expect(parseComfyProgressEvent({ type: 'executing', data: { prompt_id: 'p1', node: '8:1', display_node: '8' } }))
      .toMatchObject({ executingNodeId: '8:1', displayNodeId: '8' });
    expect(parseComfyProgressEvent({ type: 'executing', data: { prompt_id: 'p1', node: null } }))
      .toMatchObject({ stage: 'finalizing' });
    expect(parseComfyProgressEvent({ type: 'executing', data: { prompt_id: 'p1' } })).toBeNull();
  });
});

describe('createComfyProgressSession', () => {
  it.each([
    { dev: true, baseUrl: 'http://127.0.0.1:8188', page: 'http://localhost:1420', expected: 'ws://localhost:1420/api/comfyui/ws' },
    { dev: true, baseUrl: 'http://localhost:8188', page: 'https://localhost:1420', expected: 'wss://localhost:1420/api/comfyui/ws' },
    { dev: true, baseUrl: 'https://comfy.test/prefix', page: 'http://localhost:1420', expected: 'wss://comfy.test/prefix/ws' },
    { dev: true, baseUrl: 'http://127.0.0.1:8288', page: 'http://localhost:1420', expected: 'ws://127.0.0.1:8288/ws' },
  ])('进度连接选路 $baseUrl / dev=$dev', ({ dev, baseUrl, page, expected }) => {
    vi.stubEnv('DEV', dev);
    vi.stubGlobal('window', { location: new URL(page) });
    vi.stubGlobal('WebSocket', MockWebSocket);
    const session = createComfyProgressSession({ baseUrl, projectId: 'p1', nodeId: 'n1' });
    try {
      expect(MockWebSocket.instances[0].url).toBe(`${expected}?clientId=${session.clientId}`);
    } finally {
      session.close();
    }
  });

  it('没有可用 WebSocket 时通过 HTTP 继续查询真实队列状态', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DEV', false);
    vi.stubGlobal('WebSocket', undefined);
    vi.mocked(comfyFetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ queue_running: [[0, 'prompt-1']], queue_pending: [] }),
    } as Response).mockResolvedValueOnce({
      ok: true, json: async () => ({ queue_running: [], queue_pending: [[0, 'prompt-1']] }),
    } as Response);
    const session = createComfyProgressSession({ baseUrl: 'http://127.0.0.1:8188', projectId: 'p1', nodeId: 'n1' });
    await session.waitUntilReady();
    expect(MockWebSocket.instances).toHaveLength(0);
    session.bindPrompt('prompt-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ stage: 'running', transport: 'polling' });
    expect(comfyFetch).toHaveBeenCalledWith('http://127.0.0.1:8188/queue', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ stage: 'queued', queuePosition: 1 });
    session.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(comfyFetch).toHaveBeenCalledTimes(2);
  });

  it('按队列优先值计算等待序号，任务不在队列时清掉旧序号', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DEV', false);
    vi.stubGlobal('WebSocket', undefined);
    vi.mocked(comfyFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ queue_running: [[0, 'running']], queue_pending: [[1, 'first'], [8, 'last'], [4, 'mine'], [3, 'second']] }),
    } as Response).mockResolvedValueOnce({
      ok: true, json: async () => ({ queue_running: [], queue_pending: [] }),
    } as Response);
    const session = createComfyProgressSession({ baseUrl: 'http://127.0.0.1:8188', projectId: 'p1', nodeId: 'n1' });
    try {
      session.bindPrompt('mine');
      await vi.advanceTimersByTimeAsync(0);
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ stage: 'queued', queuePosition: 3 });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(useAppStore.getState().comfyNodeProgress.n1.queuePosition).toBeUndefined();
    } finally {
      session.close();
    }
  });

  it('名称只取工作流展示信息，同一节点保留计时和无 node 字段的采样身份', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
    vi.stubGlobal('WebSocket', MockWebSocket);
    const session = createComfyProgressSession({
      baseUrl: 'http://comfy.test', projectId: 'p1', nodeId: 'n1',
      workflow: { '8': { class_type: 'KSampler', _meta: { title: '第一轮\n采样' }, inputs: { secret: 'do-not-copy' } } },
    });
    const socket = MockWebSocket.instances[0];
    socket.readyState = 1;
    session.bindPrompt('p1');
    const emit = (type: string, data: Record<string, unknown>) => socket.onmessage?.({ data: JSON.stringify({ type, data: { prompt_id: 'p1', ...data } }) });
    try {
      emit('executing', { node: '8:1', display_node: '8' });
      const startedAt = useAppStore.getState().comfyNodeProgress.n1.nodeStartedAt;
      vi.setSystemTime(Date.now() + 5_000);
      emit('progress', { value: 3, max: 10 });
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({
        executingNodeId: '8:1', executingNodeLabel: '第一轮 采样', executingNodeType: 'KSampler',
        nodeStartedAt: startedAt, value: 3, max: 10, percent: 30,
      });
      expect(JSON.stringify(useAppStore.getState().comfyNodeProgress.n1)).not.toContain('do-not-copy');
      emit('executing', { node: '8:2', display_node: '8' });
      expect(useAppStore.getState().comfyNodeProgress.n1.nodeStartedAt).toBe(Date.now());
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBeUndefined();
      emit('execution_success', {});
      expect(useAppStore.getState().comfyNodeProgress.n1.executingNodeId).toBeUndefined();
      expect(useAppStore.getState().comfyNodeProgress.n1.nodeStartedAt).toBeUndefined();
    } finally {
      session.close();
    }
  });

  it('提交响应前累积缓存数和真实进度，并保持任务隔离', () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const session = createComfyProgressSession({ baseUrl: 'http://comfy.test', projectId: 'p1', nodeId: 'n1' });
    const socket = MockWebSocket.instances[0];
    socket.readyState = 1;
    const emit = (type: string, prompt_id: string, data: Record<string, unknown>) => socket.onmessage?.({ data: JSON.stringify({ type, data: { prompt_id, ...data } }) });
    try {
      emit('execution_cached', 'mine', { nodes: ['1', '2', '2'] });
      emit('progress', 'mine', { node: '8', value: 3, max: 8 });
      emit('execution_cached', 'other', { nodes: ['3', '4', '5'] });
      session.bindPrompt('mine');
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ cachedNodeCount: 2, percent: 38, executingNodeId: '8' });
      emit('execution_cached', 'mine', { nodes: ['2', '6'] });
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ cachedNodeCount: 3, percent: 38, executingNodeId: '8' });
    } finally {
      session.close();
    }
  });

  it('缺少 WebSocket 时明确降级为 HTTP 状态查询，不能伪造步骤百分比', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', undefined);
    vi.mocked(comfyFetch).mockResolvedValue({ ok: true, json: async () => ({ queue_running: [[1, 'mine']], queue_pending: [] }) } as Response);
    const session = createComfyProgressSession({ baseUrl: 'http://comfy.test', projectId: 'p1', nodeId: 'n1' });
    try {
      session.bindPrompt('mine');
      await vi.advanceTimersByTimeAsync(0);
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ stage: 'running', transport: 'polling' });
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBeUndefined();
    } finally {
      session.close();
    }
  });

  it('WebSocket 排队时补查序号，执行事件到达后停止额外查询并丢弃迟到快照', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    let finishQueue: ((value: Response) => void) | undefined;
    vi.mocked(comfyFetch).mockReturnValue(new Promise<Response>((resolve) => { finishQueue = resolve; }));
    const session = createComfyProgressSession({ baseUrl: 'http://comfy.test', projectId: 'p1', nodeId: 'n1' });
    const socket = MockWebSocket.instances[0];
    socket.readyState = 1;
    socket.onopen?.();
    session.bindPrompt('mine');
    try {
      expect(comfyFetch).toHaveBeenCalledTimes(1);
      socket.onmessage?.({ data: JSON.stringify({ type: 'progress', data: { prompt_id: 'mine', node: '8', value: 2, max: 8 } }) });
      finishQueue?.({ ok: true, json: async () => ({ queue_running: [], queue_pending: [[1, 'mine']] }) } as Response);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ stage: 'running', percent: 25, transport: 'websocket' });
      expect(useAppStore.getState().comfyNodeProgress.n1.queuePosition).toBeUndefined();
      expect(comfyFetch).toHaveBeenCalledTimes(1);
    } finally {
      session.close();
    }
  });

  it('新节点开始和整个任务收尾时清除上一节点的百分比', () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const session = createComfyProgressSession({ baseUrl: 'http://comfy.test', projectId: 'p1', nodeId: 'n1' });
    const socket = MockWebSocket.instances[0];
    session.bindPrompt('prompt-1');
    const emit = (type: string, data: Record<string, unknown>) => socket.onmessage?.({
      data: JSON.stringify({ type, data: { prompt_id: 'prompt-1', ...data } }),
    });
    try {
      emit('progress', { node: '12', value: 8, max: 8 });
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBe(100);
      emit('executing', { node: '13' });
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBeUndefined();
      emit('progress', { node: '13', value: 1, max: 4 });
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBe(25);
      emit('execution_success', {});
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ stage: 'finalizing', percent: undefined });
    } finally {
      session.close();
    }
  });

  it('提交响应晚于真实进度时，绑定 prompt 不退回排队或串入其他任务', () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const session = createComfyProgressSession({ baseUrl: 'http://comfy.test', projectId: 'p1', nodeId: 'n1' });
    const socket = MockWebSocket.instances[0];
    try {
      for (const [prompt_id, value] of [['prompt-1', 3], ['other', 7]] as const) {
        socket.onmessage?.({ data: JSON.stringify({ type: 'progress', data: { prompt_id, node: '12', value, max: 8 } }) });
      }
      session.bindPrompt('prompt-1');
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ promptId: 'prompt-1', stage: 'running', percent: 38 });
    } finally {
      session.close();
    }
  });

  it('断线后复用 clientId 重连，关闭会话后不再更新或重连', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const session = createComfyProgressSession({ baseUrl: 'http://comfy.test', projectId: 'p1', nodeId: 'n1' });
    const first = MockWebSocket.instances[0];
    first.readyState = 1;
    first.onopen?.();
    session.bindPrompt('prompt-1');
    first.onmessage?.({ data: JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 2, max: 8 } }) });
    first.close();
    expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBeUndefined();
    expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ transport: 'reconnecting', executingNodeId: undefined, nodeStartedAt: undefined });
    await vi.advanceTimersByTimeAsync(1000);
    try {
      expect(MockWebSocket.instances).toHaveLength(2);
      const second = MockWebSocket.instances[1];
      expect(second.url).toBe(first.url);
      second.readyState = 1;
      second.onopen?.();
      second.onmessage?.({ data: JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 4, max: 8 } }) });
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBe(50);
      first.onmessage?.({ data: JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 8, max: 8 } }) });
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBe(50);
    } finally {
      session.close();
    }
    await vi.advanceTimersByTimeAsync(10000);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(useAppStore.getState().comfyNodeProgress.n1).toBeUndefined();
  });

  it('使用专属 clientId，并在绑定 prompt 后过滤其他任务事件', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    useAppStore.setState({ currentProjectId: 'project-a' });

    const session = createComfyProgressSession({
      baseUrl: 'http://comfy.test:8188',
      projectId: 'project-a',
      nodeId: 'node-1',
    });
    const socket = MockWebSocket.instances[0];
    socket.readyState = 1;
    socket.onopen?.();
    await session.waitUntilReady();
    session.bindPrompt('prompt-1');

    expect(socket.url).toContain('/ws?clientId=ai-canvas-');
    socket.onmessage?.({
      data: JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-other', value: 9, max: 10 } }),
    });
    expect(useAppStore.getState().comfyNodeProgress['node-1'].stage).toBe('queued');

    socket.onmessage?.({
      data: JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 4, max: 10 } }),
    });
    expect(useAppStore.getState().comfyNodeProgress['node-1']).toMatchObject({
      promptId: 'prompt-1',
      stage: 'running',
      percent: 40,
    });

    session.close();
    expect(useAppStore.getState().comfyNodeProgress['node-1']).toBeUndefined();
  });

  it('连续连接失败最多重连三次，已中止的任务不再绑定进度', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    const controller = new AbortController();
    const session = createComfyProgressSession({ baseUrl: 'http://comfy.test', projectId: 'p1', nodeId: 'n1', signal: controller.signal });
    for (let index = 0; index < 4; index += 1) {
      MockWebSocket.instances[index].onerror?.();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(MockWebSocket.instances).toHaveLength(4);
    expect(useAppStore.getState().comfyNodeProgress.n1.transport).toBe('polling');
    controller.abort();
    session.bindPrompt('late-prompt');
    await vi.advanceTimersByTimeAsync(10000);
    expect(MockWebSocket.instances).toHaveLength(4);
    expect(useAppStore.getState().comfyNodeProgress.n1).toBeUndefined();
  });
});

describe('Tauri 原生 ComfyUI 进度通道', () => {
  it.each([
    { dev: true, marker: '__TAURI_INTERNALS__', page: 'http://localhost:1420', baseUrl: 'http://127.0.0.1:8188' },
    { dev: false, marker: '__TAURI__', page: 'http://tauri.localhost', baseUrl: 'http://localhost:8188' },
    { dev: true, marker: '__TAURI__', page: 'http://localhost:1420', baseUrl: 'https://comfy.example.test/prefix' },
    { dev: false, marker: '__TAURI_INTERNALS__', page: 'http://tauri.localhost', baseUrl: 'https://comfy.example.test/prefix' },
    { dev: true, marker: '__TAURI_INTERNALS__', page: 'http://localhost:1420', baseUrl: 'http://192.168.1.2:8188/another-prefix' },
    { dev: false, marker: '__TAURI__', page: 'http://tauri.localhost', baseUrl: 'http://192.168.1.2:8188/another-prefix' },
  ])('桌面 dev=$dev 的 $baseUrl 由原生通道读取真实节点与采样进度', async ({ dev, marker, page, baseUrl }) => {
    vi.stubEnv('DEV', dev);
    vi.stubGlobal('window', { location: new URL(page), [marker]: {} });
    vi.stubGlobal('WebSocket', MockWebSocket);
    const session = createComfyProgressSession({
      baseUrl, projectId: 'p1', nodeId: 'n1',
      workflow: { '8': { class_type: 'KSampler', _meta: { title: '角色采样' } } },
    });
    const connection = nativeConnections[0];
    try {
      expect(MockWebSocket.instances).toHaveLength(0);
      expect(connection.options).toMatchObject({ baseUrl, clientId: session.clientId, requestId: `${session.requestId}.1` });
      connection.options.onOpen();
      await session.waitUntilReady();
      connection.options.onMessage({ type: 'execution_cached', data: { prompt_id: 'mine', nodes: ['1', '1'] } });
      connection.options.onMessage({ type: 'executing', data: { prompt_id: 'mine', node: '8:1', display_node: '8' } });
      connection.options.onMessage(JSON.stringify({ type: 'progress', data: { prompt_id: 'mine', node: '8:1', value: 4, max: 10 } }));
      connection.options.onMessage({ type: 'progress', data: { prompt_id: 'other', node: '12', value: 9, max: 10 } });
      session.bindPrompt('mine');
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({
        promptId: 'mine', stage: 'running', transport: 'websocket', executingNodeId: '8:1',
        executingNodeLabel: '角色采样', executingNodeType: 'KSampler', cachedNodeCount: 1,
        value: 4, max: 10, percent: 40,
      });
      connection.options.onMessage({ type: 'progress', data: { prompt_id: 'other', value: 10, max: 10 } });
      expect(useAppStore.getState().comfyNodeProgress.n1.percent).toBe(40);
      expect(comfyFetch).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('原生重连保持 clientId、更换连接 requestId，并立即拒绝已关闭连接的回调', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    vi.stubGlobal('WebSocket', MockWebSocket);
    const session = createComfyProgressSession({ baseUrl: 'http://127.0.0.1:8188', projectId: 'p1', nodeId: 'n1' });
    const first = nativeConnections[0];
    try {
      first.options.onOpen();
      first.options.onMessage({ type: 'progress', data: { prompt_id: 'mine', node: '8', value: 1, max: 10 } });
      session.bindPrompt('mine');
      first.options.onClose();
      first.options.onMessage({ type: 'progress', data: { prompt_id: 'mine', node: '8', value: 10, max: 10 } });
      first.options.onOpen();
      first.options.onClose();
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ transport: 'reconnecting', percent: undefined, executingNodeId: undefined });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(nativeConnections).toHaveLength(2);
      const second = nativeConnections[1];
      expect(second.options.clientId).toBe(first.options.clientId);
      expect(second.options.requestId).not.toBe(first.options.requestId);
      second.options.onOpen();
      second.options.onMessage({ type: 'progress', data: { prompt_id: 'mine', node: '8', value: 3, max: 10 } });
      first.options.onError(403);
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ percent: 30, connectionIssue: undefined });
      for (let index = 1; index < 4; index += 1) {
        nativeConnections[index].options.onClose();
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(nativeConnections).toHaveLength(4);
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ transport: 'polling', percent: undefined });
      expect(new Set(nativeConnections.map(({ options }) => options.clientId)).size).toBe(1);
      expect(new Set(nativeConnections.map(({ options }) => options.requestId)).size).toBe(4);
      expect(MockWebSocket.instances).toHaveLength(0);
    } finally {
      session.close();
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(nativeConnections).toHaveLength(4);
  });

  it.each([
    { status: 401, connectionIssue: 'unauthorized' },
    { status: 403, connectionIssue: 'forbidden' },
  ])('真实 HTTP $status 拒绝后保留结果查询并停止无效重连', async ({ status, connectionIssue }) => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.mocked(comfyFetch).mockResolvedValue({ ok: true, json: async () => ({ queue_running: [[0, 'mine']], queue_pending: [] }) } as Response);
    const session = createComfyProgressSession({ baseUrl: 'https://comfy.example.test/prefix', projectId: 'p1', nodeId: 'n1' });
    const connection = nativeConnections[0];
    try {
      session.bindPrompt('mine');
      connection.options.onError(status);
      connection.options.onClose();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(nativeConnections).toHaveLength(1);
      expect(MockWebSocket.instances).toHaveLength(0);
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ stage: 'running', transport: 'polling', connectionIssue, percent: undefined });
      expect(comfyFetch).toHaveBeenCalled();
      expect(vi.mocked(comfyFetch).mock.calls.every(([url]) => url === 'https://comfy.example.test/prefix/queue')).toBe(true);
    } finally {
      session.close();
    }
  });

  it('同一画布节点的新请求不受旧原生回调或关闭影响', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const oldSession = createComfyProgressSession({ baseUrl: 'http://127.0.0.1:8188', projectId: 'p1', nodeId: 'n1' });
    const oldConnection = nativeConnections[0];
    oldConnection.options.onOpen();
    oldSession.bindPrompt('old-prompt');
    const newSession = createComfyProgressSession({ baseUrl: 'http://127.0.0.1:8188', projectId: 'p1', nodeId: 'n1' });
    const newConnection = nativeConnections[1];
    try {
      newConnection.options.onOpen();
      newSession.bindPrompt('new-prompt');
      newConnection.options.onMessage({ type: 'progress', data: { prompt_id: 'new-prompt', node: '8', value: 5, max: 10 } });
      oldConnection.options.onMessage({ type: 'progress', data: { prompt_id: 'old-prompt', node: '8', value: 9, max: 10 } });
      oldSession.close();
      oldConnection.options.onOpen();
      oldConnection.options.onError(403);
      oldConnection.options.onClose();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(nativeConnections).toHaveLength(2);
      expect(useAppStore.getState().comfyNodeProgress.n1).toMatchObject({ requestId: newSession.requestId, promptId: 'new-prompt', percent: 50, transport: 'websocket' });
      expect(oldConnection.close).toHaveBeenCalledTimes(1);
    } finally {
      oldSession.close();
      newSession.close();
    }
    expect(newConnection.close).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().comfyNodeProgress.n1).toBeUndefined();
  });
});

it('真实 Vite HTTP 与 WebSocket 代理保留同源校验，继续拒绝跨站请求', async () => {
  const received: Array<{ host?: string; origin?: string; url?: string }> = [];
  const receivedHttp: Array<{ host?: string; origin?: string; url?: string; method?: string }> = [];
  const sockets = new Set<Socket>();
  const forbiddenOrigin = (req: IncomingMessage) => req.headers['sec-fetch-site'] === 'cross-site'
    || (!!req.headers.origin && new URL(req.headers.origin).host !== req.headers.host);
  const backend = createServer((req, res) => {
    receivedHttp.push({ host: req.headers.host, origin: req.headers.origin, url: req.url, method: req.method });
    req.resume();
    // 模拟默认来源中间件；不依赖 --enable-cors-header 放开外部来源。
    res.writeHead(forbiddenOrigin(req) ? 403 : 200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const event = JSON.stringify({ type: 'progress', data: { prompt_id: 'p1', node: '12', value: 3, max: 8 } });
  backend.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  backend.on('upgrade', (req, socket) => {
    received.push({ host: req.headers.host, origin: req.headers.origin, url: req.url });
    // 复现 ComfyUI origin_only_middleware 的本地 Host/Origin 校验。
    if (!req.headers.origin || forbiddenOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const headers = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
    socket.write(Buffer.concat([Buffer.from(headers), Buffer.from([0x81, Buffer.byteLength(event)]), Buffer.from(event)]));
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendPort = (backend.address() as { port: number }).port;
  const proxy = viteConfig.server?.proxy?.['/api/comfyui/ws'];
  const httpProxy = viteConfig.server?.proxy?.['/api/comfyui'];
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  try {
    expect(proxy).toBeTypeOf('object');
    if (!proxy || typeof proxy === 'string') throw new Error('缺少 ComfyUI WebSocket 代理');
    if (!httpProxy || typeof httpProxy === 'string') throw new Error('缺少 ComfyUI HTTP 代理');
    vite = await createViteServer({
      configFile: false, appType: 'custom', logLevel: 'silent',
      server: {
        host: '127.0.0.1', port: 0, hmr: false, watch: null,
        proxy: {
          '/api/comfyui/ws': { ...proxy, target: `http://127.0.0.1:${backendPort}` },
          '/api/comfyui': { ...httpProxy, target: `http://127.0.0.1:${backendPort}` },
        },
      },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await vite.listen();
    const port = (vite.httpServer?.address() as { port: number }).port;
    const connect = (origin: string, fetchSite = 'same-origin') => new Promise<{ status: number; frame?: Buffer }>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port, path: '/api/comfyui/ws?clientId=test-client',
        headers: {
          Host: 'localhost:1420', Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-Fetch-Site': fetchSite,
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
        },
      });
      req.setTimeout(3000, () => req.destroy(new Error('WebSocket 代理连接超时')));
      req.on('error', reject);
      req.on('response', (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      });
      req.on('upgrade', (response, socket, head) => {
        const complete = (frame: Buffer) => {
          socket.destroy();
          resolve({ status: response.statusCode ?? 0, frame });
        };
        if (head.length) complete(head);
        else socket.once('data', complete);
      });
      req.end();
    });
    const sendHttp = (method: 'GET' | 'POST', origin?: string, fetchSite = 'same-origin') => new Promise<number>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port, method,
        path: method === 'POST' ? '/api/comfyui/prompt' : '/api/comfyui/queue',
        headers: {
          Host: 'localhost:1420', ...(origin ? { Origin: origin } : {}),
          'Sec-Fetch-Site': fetchSite, 'Content-Type': 'application/json',
        },
      });
      req.setTimeout(3_000, () => req.destroy(new Error('HTTP 代理连接超时')));
      req.on('error', reject);
      req.on('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      req.end(method === 'POST' ? JSON.stringify({ prompt: {} }) : undefined);
    });

    expect(await sendHttp('POST', 'http://localhost:1420')).toBe(200);
    expect(await sendHttp('GET', 'http://localhost:1420')).toBe(200);
    expect(await sendHttp('GET')).toBe(200);
    expect(receivedHttp.slice(0, 2)).toEqual([
      { host: 'localhost:1420', origin: 'http://localhost:1420', url: '/prompt', method: 'POST' },
      { host: 'localhost:1420', origin: 'http://localhost:1420', url: '/queue', method: 'GET' },
    ]);
    expect(await sendHttp('POST', 'https://untrusted.example')).toBe(403);
    expect(await sendHttp('GET', 'http://localhost:1420', 'cross-site')).toBe(403);

    const accepted = await connect('http://localhost:1420');
    expect(accepted.status).toBe(101);
    expect(parseComfyProgressEvent(accepted.frame?.subarray(2).toString())).toMatchObject({ value: 3, max: 8, percent: 38 });
    expect(received[0]).toEqual({ host: 'localhost:1420', origin: 'http://localhost:1420', url: '/ws?clientId=test-client' });
    expect((await connect('https://untrusted.example')).status).toBe(403);
    expect((await connect('http://localhost:1420', 'cross-site')).status).toBe(403);
  } finally {
    for (const socket of sockets) socket.destroy();
    await vite?.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});
