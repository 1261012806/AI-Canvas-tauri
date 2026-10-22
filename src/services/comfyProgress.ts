import { useAppStore } from '../store/useAppStore';
import type { ComfyNodeProgressStage } from '../types/comfyProgress';
import { comfyFetch } from './comfyPolling';
import { withComfyQueryTimeout } from './comfyQuery';
import { connectNativeComfyProgress } from './comfyProgressTransport';

const SOCKET_READY_TIMEOUT_MS = 1_000;
const SOCKET_CONNECT_TIMEOUT_MS = 5_000;
const SOCKET_RECONNECT_DELAY_MS = 1_000;
const MAX_SOCKET_RECONNECTS = 3;
const MAX_EVENT_TEXT_LENGTH = 1_048_576;
const QUEUE_POLL_INTERVAL_MS = 2_000;
const MAX_TRACKED_NODES = 10_000;

export interface ParsedComfyProgress {
  eventType: 'progress' | 'progress_state' | 'execution_start' | 'executing' | 'execution_cached' | 'execution_success';
  promptId?: string;
  stage: ComfyNodeProgressStage;
  value?: number;
  max?: number;
  percent?: number;
  executingNodeId?: string;
  displayNodeId?: string;
  cachedNodeIds?: string[];
}

export interface ComfyProgressSession {
  clientId: string;
  requestId: string;
  waitUntilReady: () => Promise<void>;
  bindPrompt: (promptId: string) => void;
  close: () => void;
}

interface CreateComfyProgressSessionOptions {
  baseUrl: string;
  projectId: string;
  nodeId: string;
  signal?: AbortSignal;
  workflow?: Record<string, Record<string, unknown>>;
}

interface ProgressStateNode {
  value?: unknown;
  max?: unknown;
  state?: unknown;
  node_id?: unknown;
  display_node_id?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numericProgress(value: unknown, max: unknown): Pick<ParsedComfyProgress, 'value' | 'max' | 'percent'> {
  const safeValue = finiteNumber(value);
  const safeMax = finiteNumber(max);
  if (safeValue === undefined || safeValue < 0 || safeMax === undefined || safeMax <= 0) return {};
  return {
    value: safeValue,
    max: safeMax,
    percent: Math.max(0, Math.min(100, Math.round((safeValue / safeMax) * 100))),
  };
}

/** 将 ComfyUI 新旧 WebSocket 事件收敛为节点可显示的真实执行状态。 */
export function parseComfyProgressEvent(raw: unknown): ParsedComfyProgress | null {
  let message: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_EVENT_TEXT_LENGTH) return null;
    try {
      message = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(message) || typeof message.type !== 'string' || !isRecord(message.data)) return null;

  const { type, data } = message;
  const promptId = stringValue(data.prompt_id);

  if (type === 'progress') {
    return {
      eventType: type,
      promptId,
      stage: 'running',
      executingNodeId: stringValue(data.node),
      ...numericProgress(data.value, data.max),
    };
  }

  if (type === 'progress_state' && isRecord(data.nodes)) {
    const nodes = Object.entries(data.nodes)
      .filter((entry): entry is [string, ProgressStateNode] => isRecord(entry[1]));
    const running = nodes.find(([, node]) => node.state === 'running');
    if (running) {
      const [nodeKey, node] = running;
      return {
        eventType: type,
        promptId,
        stage: 'running',
        executingNodeId: stringValue(node.node_id) ?? nodeKey,
        displayNodeId: stringValue(node.display_node_id),
        ...numericProgress(node.value, node.max),
      };
    }
    // 此快照不包含 pending 节点；暂时全 finished 也可能只是下一节点尚未启动。
    return { eventType: type, promptId, stage: 'running' };
  }

  if (type === 'execution_start') return { eventType: type, promptId, stage: 'running' };
  if (type === 'executing') {
    if (data.node === null) return { eventType: type, promptId, stage: 'finalizing' };
    const executingNodeId = stringValue(data.node);
    if (!executingNodeId) return null;
    return { eventType: type, promptId, stage: 'running', executingNodeId, displayNodeId: stringValue(data.display_node) };
  }
  if (type === 'execution_cached' && Array.isArray(data.nodes)) {
    return {
      eventType: type, promptId, stage: 'running',
      cachedNodeIds: data.nodes.slice(0, MAX_TRACKED_NODES).filter((id): id is string => typeof id === 'string' && id.length > 0),
    };
  }
  if (type === 'execution_success') return { eventType: type, promptId, stage: 'finalizing' };
  return null;
}

function createRequestId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return randomUuid ? randomUuid() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildSocketUrl(baseUrl: string, clientId: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  let url = new URL(`${normalized}/ws`);
  // Vite 的固定本地代理同时服务浏览器和 Tauri dev；生产和其他服务器保持原地址。
  if (import.meta.env.DEV && typeof window !== 'undefined'
    && /^https?:$/.test(window.location?.protocol ?? '')
    && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port === '8188' && url.pathname === '/ws') {
    url = new URL('/api/comfyui/ws', window.location.origin);
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else throw new Error('ComfyUI WebSocket 地址协议无效');
  url.searchParams.set('clientId', clientId);
  return url.toString();
}

function queueContainsPrompt(value: unknown, promptId: string): boolean {
  return Array.isArray(value) && value.some((item) => Array.isArray(item) && item[1] === promptId);
}

function pendingQueuePosition(value: unknown, promptId: string): number | undefined {
  if (!Array.isArray(value) || !value.every((item) => Array.isArray(item)
    && finiteNumber(item[0]) !== undefined && typeof item[1] === 'string')) return undefined;
  // ComfyUI 返回的是 heap 的内部数组，数组下标不代表实际执行顺序。
  const ordered = [...value].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const index = ordered.findIndex((item) => item[1] === promptId);
  return index < 0 ? undefined : index + 1;
}

function displayText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return Array.from(value, (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char)
    .join('').replace(/\s+/g, ' ').trim().slice(0, 100) || undefined;
}

/**
 * 为一次画布节点生成建立独立的 ComfyUI 进度通道。
 * 通道不可用时只退化为不确定进度，不影响 /prompt 与 /history 主流程。
 */
export function createComfyProgressSession({
  baseUrl,
  projectId,
  nodeId,
  signal,
  workflow,
}: CreateComfyProgressSessionOptions): ComfyProgressSession {
  const requestId = createRequestId();
  const clientId = `ai-canvas-${requestId}`;
  const store = useAppStore.getState();
  const useNativeProgress = typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
  let transport: 'websocket' | 'polling' | 'reconnecting' = 'websocket';
  let connectionIssue: 'forbidden' | 'unauthorized' | undefined;
  store.beginComfyNodeProgress({
    projectId,
    nodeId,
    requestId,
    clientId,
    stage: 'connecting',
    transport,
  });

  // 仅保留展示名称，不把工作流输入、提示词或模型路径复制到运行时进度。
  const nodeLabels = new Map(Object.entries(workflow ?? {}).slice(0, MAX_TRACKED_NODES).map(([id, node]) => {
    const nodeType = displayText(node?.class_type);
    const title = isRecord(node?._meta) ? displayText(node._meta.title) : undefined;
    return [id, { label: title ?? nodeType, nodeType }] as const;
  }));
  type ProgressPatch = Parameters<typeof store.updateComfyNodeProgress>[2];
  type ProgressAccumulator = { state: ProgressPatch & { stage: ComfyNodeProgressStage }; cachedIds: Set<string> };
  const createAccumulator = (stage: ComfyNodeProgressStage): ProgressAccumulator => ({ state: { stage }, cachedIds: new Set() });
  let currentProgress = createAccumulator('connecting');

  let socket: WebSocket | null = null;
  let closeNativeConnection: (() => void) | undefined;
  let nativeOpen = false;
  let nativeConnectionVersion = 0;
  const isProgressOpen = () => nativeOpen || socket?.readyState === 1;
  let boundPromptId: string | undefined;
  let closed = false;
  let reconnectCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  let queueRequest: AbortController | undefined;
  const earlyProgress = new Map<string, ProgressAccumulator>();
  let settleReady = () => {};
  let readySettled = false;
  const readyPromise = new Promise<void>((resolve) => {
    settleReady = () => {
      if (readySettled) return;
      readySettled = true;
      resolve();
    };
  });
  const readyTimer = globalThis.setTimeout(settleReady, SOCKET_READY_TIMEOUT_MS);

  const update = (patch: Parameters<typeof store.updateComfyNodeProgress>[2]) => {
    if (closed) return;
    useAppStore.getState().updateComfyNodeProgress(nodeId, requestId, patch);
  };

  const publish = () => update({ ...currentProgress.state, promptId: boundPromptId, transport, connectionIssue });

  const accumulate = (target: ProgressAccumulator, parsed: ParsedComfyProgress) => {
    if (parsed.cachedNodeIds) {
      for (const id of parsed.cachedNodeIds) {
        if (target.cachedIds.size >= MAX_TRACKED_NODES) break;
        target.cachedIds.add(id);
      }
      target.state.cachedNodeCount = target.cachedIds.size;
      target.state.queuePosition = undefined;
      if (target.state.stage !== 'finalizing') target.state.stage = 'running';
      return;
    }
    // 收尾后迟到的采样或队列快照不能把本次任务退回执行中。
    if (target.state.stage === 'finalizing' && parsed.stage !== 'finalizing') return;
    const previous = target.state;
    const executingNodeId = parsed.executingNodeId
      ?? (parsed.eventType === 'progress' ? previous.executingNodeId : undefined);
    const sameNode = !!executingNodeId && executingNodeId === previous.executingNodeId;
    const metadata = nodeLabels.get(parsed.displayNodeId ?? executingNodeId ?? '')
      ?? nodeLabels.get(executingNodeId ?? '');
    const clearNumeric = !sameNode || parsed.eventType === 'progress' || parsed.eventType === 'progress_state';
    target.state = {
      ...previous,
      stage: parsed.stage,
      queuePosition: undefined,
      executingNodeId,
      executingNodeLabel: metadata?.label ?? (sameNode ? previous.executingNodeLabel : undefined),
      executingNodeType: metadata?.nodeType ?? (sameNode ? previous.executingNodeType : undefined),
      nodeStartedAt: executingNodeId ? (sameNode ? previous.nodeStartedAt ?? Date.now() : Date.now()) : undefined,
      ...(clearNumeric ? { value: undefined, max: undefined, percent: undefined } : {}),
      ...(parsed.value !== undefined ? { value: parsed.value, max: parsed.max, percent: parsed.percent } : {}),
    };
  };

  const applyProgress = (parsed: ParsedComfyProgress) => {
    accumulate(currentProgress, parsed);
    if (isProgressOpen() && currentProgress.state.stage !== 'queued') stopQueuePolling();
    publish();
  };

  const stopQueuePolling = () => {
    globalThis.clearTimeout(queueTimer);
    queueTimer = undefined;
    queueRequest?.abort();
    queueRequest = undefined;
  };

  const pollQueue = async () => {
    queueTimer = undefined;
    if (closed || !boundPromptId) return;
    const promptId = boundPromptId;
    const controller = new AbortController();
    queueRequest = controller;
    try {
      const queue = await withComfyQueryTimeout(async (signal) => {
        const response = await comfyFetch(`${baseUrl.replace(/\/+$/, '')}/queue`, { signal });
        return response.ok ? await response.json() as unknown : null;
      }, controller.signal);
      if (queue !== null) {
        if (!closed && !controller.signal.aborted && promptId === boundPromptId && isRecord(queue)) {
          const state = currentProgress.state;
          if (isProgressOpen() && state.stage !== 'queued') return;
          state.queuePosition = undefined;
          if (state.stage !== 'finalizing') {
            if (queueContainsPrompt(queue.queue_running, promptId)) state.stage = 'running';
            else if (queueContainsPrompt(queue.queue_pending, promptId)) {
              state.stage = 'queued';
              state.queuePosition = pendingQueuePosition(queue.queue_pending, promptId);
            }
          }
          publish();
        }
      }
    } catch {
      // 队列查询失败时保留当前状态；主流程仍由 /history 判断结果。
    } finally {
      if (queueRequest === controller) queueRequest = undefined;
      if (!closed && !controller.signal.aborted && (!isProgressOpen() || currentProgress.state.stage === 'queued')) {
        queueTimer = globalThis.setTimeout(() => { void pollQueue(); }, QUEUE_POLL_INTERVAL_MS);
      }
    }
  };

  const startQueuePolling = () => {
    if (boundPromptId && !queueRequest && queueTimer === undefined
      && (!isProgressOpen() || currentProgress.state.stage === 'queued')) void pollQueue();
  };

  const reconnect = () => {
    // 只重连读取进度的通道，不重新提交生成任务。HTTP 查询在重连期间继续提供状态。
    const canReconnect = !connectionIssue && reconnectCount < MAX_SOCKET_RECONNECTS;
    transport = canReconnect ? 'reconnecting' : 'polling';
    currentProgress.state = {
      ...currentProgress.state, value: undefined, max: undefined, percent: undefined,
      executingNodeId: undefined, executingNodeLabel: undefined, executingNodeType: undefined, nodeStartedAt: undefined,
    };
    publish();
    startQueuePolling();
    if (canReconnect) {
      reconnectCount += 1;
      reconnectTimer = globalThis.setTimeout(connect, SOCKET_RECONNECT_DELAY_MS);
    }
  };

  const acceptMessage = (raw: unknown) => {
    const parsed = parseComfyProgressEvent(raw);
    if (!parsed) return;
    // /prompt 响应前可能已经收到执行事件，先按 promptId 暂存，绑定后只取本次任务。
    if (!boundPromptId) {
      if (parsed.promptId) {
        if (!earlyProgress.has(parsed.promptId) && earlyProgress.size >= 32) return;
        const buffered = earlyProgress.get(parsed.promptId) ?? createAccumulator('queued');
        accumulate(buffered, parsed);
        earlyProgress.set(parsed.promptId, buffered);
      }
      return;
    }
    if (parsed.promptId && parsed.promptId !== boundPromptId) return;
    applyProgress(parsed);
  };

  const opened = () => {
    settleReady();
    stopQueuePolling();
    transport = 'websocket';
    connectionIssue = undefined;
    if (boundPromptId && currentProgress.state.stage === 'connecting') currentProgress.state.stage = 'queued';
    publish();
    startQueuePolling();
  };

  const connect = () => {
    if (closed) return;
    if (useNativeProgress) {
      const version = ++nativeConnectionVersion;
      const isCurrent = () => !closed && nativeConnectionVersion === version;
      // Tauri dev 和打包端统一从 Rust 建连；不再尝试 WebView 直连或牺牲真实进度。
      closeNativeConnection = connectNativeComfyProgress({
        baseUrl, clientId, requestId: `${requestId}.${version}`,
        onOpen: () => {
          if (!isCurrent()) return;
          nativeOpen = true;
          opened();
        },
        onMessage: (data) => { if (isCurrent()) acceptMessage(data); },
        onError: (status) => {
          if (!isCurrent()) return;
          // 原生通道没有浏览器 CORS。实际鉴权拒绝不盲目重连，保留 HTTP 结果查询。
          if (status === 403) connectionIssue = 'forbidden';
          else if (status === 401) connectionIssue = 'unauthorized';
          settleReady();
        },
        onClose: () => {
          if (!isCurrent()) return;
          nativeConnectionVersion += 1;
          nativeOpen = false;
          closeNativeConnection = undefined;
          settleReady();
          reconnect();
        },
      });
      return;
    }
    if (typeof globalThis.WebSocket !== 'function') {
      settleReady();
      if (!closed) {
        transport = 'polling';
        publish();
        startQueuePolling();
      }
      return;
    }
    try {
      const currentSocket = new globalThis.WebSocket(buildSocketUrl(baseUrl, clientId));
      socket = currentSocket;
      connectTimer = globalThis.setTimeout(() => {
        if (!closed && socket === currentSocket && currentSocket.readyState === 0) currentSocket.close();
      }, SOCKET_CONNECT_TIMEOUT_MS);
      currentSocket.onopen = () => {
        if (closed || socket !== currentSocket) return;
        globalThis.clearTimeout(connectTimer);
        opened();
      };
      currentSocket.onmessage = (event) => {
        if (closed || socket !== currentSocket || typeof event.data !== 'string') return;
        acceptMessage(event.data);
      };
      currentSocket.onerror = () => {
        if (closed || socket !== currentSocket) return;
        settleReady();
        currentSocket.close();
      };
      currentSocket.onclose = () => {
        if (closed || socket !== currentSocket) return;
        globalThis.clearTimeout(connectTimer);
        socket = null;
        settleReady();
        reconnect();
      };
    } catch {
      settleReady();
      reconnect();
    }
  };
  connect();

  const close = () => {
    if (closed) return;
    closed = true;
    globalThis.clearTimeout(readyTimer);
    globalThis.clearTimeout(connectTimer);
    globalThis.clearTimeout(reconnectTimer);
    stopQueuePolling();
    earlyProgress.clear();
    settleReady();
    signal?.removeEventListener('abort', close);
    closeNativeConnection?.();
    if (socket && socket.readyState < 2) socket.close();
    useAppStore.getState().clearComfyNodeProgress(nodeId, requestId);
  };
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();

  return {
    clientId,
    requestId,
    waitUntilReady: () => readyPromise,
    bindPrompt: (promptId) => {
      if (closed) return;
      boundPromptId = promptId;
      currentProgress = earlyProgress.get(promptId) ?? createAccumulator('queued');
      publish();
      earlyProgress.clear();
      startQueuePolling();
    },
    close,
  };
}
