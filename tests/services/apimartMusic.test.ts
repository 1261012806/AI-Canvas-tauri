import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const receipts = new Map<string, { projectId: string; nodeId: string; taskId: string; attemptId: string }>();
  return {
  receipts,
  savePendingTask: vi.fn((task: { nodeId: string; projectId: string; taskId: string }) => {
    const receipt = { projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: 'attempt' };
    receipts.set(task.nodeId, receipt); return receipt;
  }),
  updatePendingTask: vi.fn((nodeId: string, patch: { taskId?: string }) => {
    const current = receipts.get(nodeId); if (!current) return undefined;
    const receipt = { ...current, ...(patch.taskId === undefined ? {} : { taskId: patch.taskId }) };
    receipts.set(nodeId, receipt); return receipt;
  }),
  getMediaTaskReceipt: vi.fn((nodeId: string) => receipts.get(nodeId)),
  pauseMediaTask: vi.fn((receipt: { taskId: string }, _error?: unknown, reason?: string) => Object.assign(new Error('任务查询已暂停'),
    { name: 'MediaTaskPausedError', taskReceipt: receipt, reason: reason ?? 'query_interrupted' })),
  VIDEO_POLL_MAX_DURATION_MS: 30 * 60 * 1000,
  removePendingTask: vi.fn((nodeId: string) => { receipts.delete(nodeId); }), cleanupNodePolling: vi.fn(),
  registerNodePolling: vi.fn(() => new AbortController().signal),
  state: { config: { providers: { apimart: { apiKey: 'test-key', baseUrl: 'https://api.example/v1' } } }, currentProjectId: 'project', nodes: [] },
}; });
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: () => mocks.state } }));
vi.mock('../../src/services/pollManager', () => mocks);

import { submitSunoGeneration, submitFlowMusicGeneration } from '../../src/services/ai/apimartAudio';
import { apimartMediaProviderAdapter } from '../../src/services/ai/providers/apimartMedia';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

describe('APIMart 音乐版本协议', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.receipts.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('Lyria 复用 flowmusic，显式提交 version，不将界面选择 ID 发给服务器', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ code: 200, data: [{ task_id: 'lyria-task' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(submitFlowMusicGeneration('key', 'https://api.example/v1', { version: 'lyria-3.5', soundPrompt: 'jazz', length: 60 })).resolves.toBe('lyria-task');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example/v1/music/generations');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'flowmusic', version: 'lyria-3.5', sound_prompt: 'jazz', length: 60 });
  });

  it.each(['v6', 'v6-wild', 'v6-mini'] as const)('Suno %s 灵感模式省略不生效的歌词、标题和时长字段', async (version) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ code: 200, data: [{ task_id: 'suno-task' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await submitSunoGeneration('key', 'https://api.example/v1', { version, prompt: 'acoustic song', title: 'ignored', duration: 60 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'suno', version, custom: false, prompt: 'acoustic song' });
  });

  it('Suno 自定义歌词使用 prompt，风格单独写入 style', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ code: 200, data: [{ task_id: 'suno-task' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await submitSunoGeneration('key', 'https://api.example/v1', { version: 'v6', prompt: 'jazz', lyrics: '[Verse]\n夜色', title: '夜色', duration: 120 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'suno', version: 'v6', custom: true, prompt: '[Verse]\n夜色', style: 'jazz', title: '夜色', duration: 120 });
  });

  it('超长歌词、非法时长在付费提交前拒绝', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(() => submitSunoGeneration('key', 'https://api.example/v1', { version: 'v6', prompt: 'jazz', lyrics: '字'.repeat(5001) })).toThrow('长度限制');
    expect(() => submitSunoGeneration('key', 'https://api.example/v1', { version: 'v6', prompt: 'jazz', lyrics: '歌词', duration: 5 })).toThrow('10–360');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['flowmusic-lyria-3.5', 'suno-v6-mini'])('%s 由 Adapter 复用可恢复的单阶段音乐任务', async (model) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ code: 200, data: [{ task_id: 'music-task' }] }))
      .mockResolvedValueOnce(json({ code: 200, data: { status: 'completed', result: { music: [{ title: '曲目', audio_url: 'https://cdn.example/music.mp3' }] } } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: { provider: 'apimart', model: `apimart/${model}`, prompt: 'jazz', nodeId: 'node', autoGenerateLyrics: true }, prompt: 'jazz', referenceAudioUrls: [] }))
      .resolves.toMatchObject({ url: 'https://cdn.example/music.mp3', title: '曲目' });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['https://api.example/v1/music/generations', 'https://api.example/v1/music/tasks/music-task?language=zh']);
    expect(mocks.savePendingTask).toHaveBeenCalledWith(expect.objectContaining({ taskType: 'apimart-flow-music', audioTaskStage: 'music', providerConfigId: 'apimart' }));
    expect(mocks.updatePendingTask).toHaveBeenCalledWith('node', expect.objectContaining({ taskId: 'music-task', submitted: true }), '', 'attempt');
    expect(mocks.removePendingTask).not.toHaveBeenCalled();
  });

  it('余额不足只提交一次', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: '余额不足' } }), { status: 402, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(submitSunoGeneration('key', 'https://api.example/v1', { version: 'v6', prompt: 'jazz' })).rejects.toThrow('余额不足');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 402])('Adapter 将音乐提交 HTTP %s 作为明确拒绝，不保留空任务', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: '音乐提交被拒绝' } }), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: {
      provider: 'apimart', model: 'apimart/suno-v6', nodeId: 'music-node', prompt: 'jazz',
    }, prompt: 'jazz', referenceAudioUrls: [] })).rejects.toMatchObject({
      name: 'ModelProtocolHttpError', status, message: '音乐提交被拒绝',
    });
    expect(mocks.removePendingTask).toHaveBeenCalledWith('music-node', '', 'attempt');
    expect(mocks.pauseMediaTask).not.toHaveBeenCalled();
    expect(mocks.receipts.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([408, 429, 500, 503])('Adapter 将音乐提交 HTTP %s 保留为状态未知且不重发', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: '提交结果尚未确认' } }), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: {
      provider: 'apimart', model: 'apimart/suno-v6', nodeId: 'music-node', prompt: 'jazz',
    }, prompt: 'jazz', referenceAudioUrls: [] })).rejects.toMatchObject({
      name: 'MediaTaskPausedError', reason: 'submit_unknown', taskReceipt: { taskId: '' },
    });
    expect(mocks.removePendingTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('音乐查询断网保留已提交 ID，重试入口不需要重新生成', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ data: [{ task_id: 'music-network' }] }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: {
      provider: 'apimart', model: 'apimart/suno-v6', nodeId: 'music-node', prompt: 'jazz',
    }, prompt: 'jazz', referenceAudioUrls: [] })).rejects.toMatchObject({
      name: 'MediaTaskPausedError', taskReceipt: { taskId: 'music-network' },
    });
    expect(mocks.removePendingTask).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('音乐提交响应丢失保留状态不确定，禁止把它当成可安全重发', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: {
      provider: 'apimart', model: 'apimart/suno-v6', nodeId: 'music-node', prompt: 'jazz',
    }, prompt: 'jazz', referenceAudioUrls: [] })).rejects.toMatchObject({
      name: 'MediaTaskPausedError', reason: 'submit_unknown', taskReceipt: { taskId: '' },
    });
    expect(mocks.removePendingTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('提交后取消不重投音乐任务', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementationOnce(() => { controller.abort(); return Promise.resolve(json({ code: 200, data: [{ task_id: 'music-task' }] })); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(apimartMediaProviderAdapter.generateAudio?.({ params: { provider: 'apimart', model: 'apimart/suno-v6', prompt: 'jazz' }, prompt: 'jazz', referenceAudioUrls: [], signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
