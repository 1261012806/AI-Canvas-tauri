import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerMediaAgentTools } from '../../../src/services/chat/tools/mediaTools';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  prepareAgentToolCall,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import { getPendingTasksForProject, registerMediaNodeOperation, savePendingTask } from '../../../src/services/pollManager';
import * as generationRuntime from '../../../src/services/ai/generationRuntime';

const context: Omit<AgentToolContext, 'signal'> = {
  taskId: 'task-media',
  projectId: 'project-1',
  conversationId: 'conversation-1',
  mode: 'collaborative',
};

beforeEach(() => {
  localStorage.removeItem('ai_canvas_pending_tasks');
  clearAgentToolRegistryForTests();
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({
    currentProjectId: 'project-1',
    nodes: [{
      id: 'n1',
      type: 'source-image',
      position: { x: 0, y: 0 },
      data: { type: 'source-image', label: '首帧', imageUrl: 'asset://first-frame.png' },
    }],
    projects: [{
      id: 'project-1',
      name: '测试项目',
      createdAt: 1,
      updatedAt: 1,
      settings: {
        generation: {
          videoAspectRatio: '16:9',
          videoResolution: '1080p',
          videoDuration: 10,
        },
      },
    }],
  });
  registerMediaAgentTools();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('media task recovery tools', () => {
  it('does not advertise or run recovery while the original result is being saved', async () => {
    const receipt = savePendingTask({ projectId: 'project-1', nodeId: 'n1', nodeType: 'ai-image', provider: 'general',
      taskType: 'custom-protocol', taskId: 'saving-task', submitted: true, mediaRecoveryState: 'delivery_pending' });
    const release = registerMediaNodeOperation(receipt.nodeId);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      const toolContext = { ...context, signal: new AbortController().signal };
      const listed = await getAgentTool('media_pending_tasks')!.execute(toolContext, {});
      expect(JSON.parse(listed.modelContent)).toEqual([expect.objectContaining({ taskId: receipt.taskId, canResume: false })]);
      const definition = getAgentTool('media_resume_task')!;
      const input = { nodeId: receipt.nodeId, taskId: receipt.taskId };
      expect(definition.authorize?.(context, input).allowed).toBe(false);
      expect(await definition.execute(toolContext, input)).toMatchObject({ status: 'error', errorCode: 'MEDIA_RECOVERY_STALE' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getPendingTasksForProject('project-1')[0]).toMatchObject(receipt);
      release();
      const available = await getAgentTool('media_pending_tasks')!.execute(toolContext, {});
      expect(JSON.parse(available.modelContent)[0].canResume).toBe(true);
    } finally { release(); }
  });

  it('stops an in-flight recovery with the tool signal and retains the original task', async () => {
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { ...state.config.providers,
      recovery: { name: 'Recovery', apiKey: 'fixture-key', baseUrl: 'https://gateway.example' } } } }));
    const receipt = savePendingTask({ projectId: 'project-1', nodeId: 'n1', nodeType: 'ai-image', provider: 'general',
      providerConfigId: 'recovery', taskType: 'custom-protocol', taskId: 'original-task', submitted: true,
      mediaRecoveryState: 'query_paused', protocolPoll: { method: 'GET', url: 'https://gateway.example/tasks/original-task',
        intervalMs: 1, statusPath: 'status', successValues: ['completed'], failureValues: ['failed'], resultUrlPath: 'url' } });
    let finish!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = getAgentTool('media_resume_task')!.execute({ ...context, signal: controller.signal },
      { nodeId: receipt.nodeId, taskId: receipt.taskId });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toMatchObject({ status: 'error', errorCode: 'MEDIA_RECOVERY_STOPPED' });
    expect(getPendingTasksForProject('project-1')[0]).toMatchObject(receipt);
    expect(useAppStore.getState().nodes[0].data.imageUrl).toBe('asset://first-frame.png');
    finish(new Response(JSON.stringify({ status: 'completed', url: 'https://cdn.example/late.png' })));
  });

  it('lists original task identities without exposing their polling URLs', async () => {
    savePendingTask({ projectId: 'project-1', nodeId: 'n1', nodeType: 'ai-image', provider: 'general',
      providerConfigId: 'custom', taskType: 'custom-protocol', taskId: 'original-task', submitted: true,
      mediaRecoveryState: 'query_paused', mediaContext: { projectId: 'project-1', messageId: 'message-1', conversationId: 'conversation-1', deliveryMode: 'message' } });
    const definition = getAgentTool('media_pending_tasks')!;
    const result = await definition.execute({ ...context, signal: new AbortController().signal }, {});
    expect(result.status).toBe('success');
    expect(JSON.parse(result.modelContent)).toEqual([expect.objectContaining({ taskId: 'original-task', nodeId: 'n1', canResume: true })]);
    expect(result.modelContent).not.toContain('protocolPoll');
    expect(result.modelContent).not.toContain('apiKey');
    expect(result.modelContent).not.toContain('https://');
  });

  it('refuses to resume an unknown submission or a task from another project at authorization and execution', async () => {
    savePendingTask({ projectId: 'project-1', nodeId: 'n1', nodeType: 'ai-image', provider: 'general',
      taskType: 'custom-protocol', taskId: 'uncertain-task', submitted: true, mediaRecoveryState: 'submit_unknown' });
    const definition = getAgentTool('media_resume_task')!;
    const input = { nodeId: 'n1', taskId: 'uncertain-task' };
    expect(definition.authorize?.(context, input).allowed).toBe(false);
    expect(await definition.execute({ ...context, signal: new AbortController().signal }, input))
      .toMatchObject({ status: 'error', errorCode: 'MEDIA_RECOVERY_STALE' });

    savePendingTask({ projectId: 'project-1', nodeId: 'n1', nodeType: 'ai-image', provider: 'general',
      taskType: 'custom-protocol', taskId: 'original-task', submitted: true, mediaRecoveryState: 'query_paused' });
    const knownInput = { nodeId: 'n1', taskId: 'original-task' };
    expect(definition.authorize?.(context, knownInput).allowed).toBe(true);
    const otherContext = { ...context, projectId: 'other-project' };
    expect(definition.authorize?.(otherContext, knownInput).allowed).toBe(false);
    expect(await definition.execute({ ...otherContext, signal: new AbortController().signal }, knownInput))
      .toMatchObject({ status: 'error', errorCode: 'MEDIA_RECOVERY_STALE' });
    expect(definition.effect).toBe('canvas_write');
  });

  it('does not advertise or execute task types owned by dedicated recovery lifecycles', async () => {
    const dedicatedTypes = ['runninghub', 'runninghub-workflow', 'runninghub-model', 'workflow-api'] as const;
    dedicatedTypes.forEach((taskType) => savePendingTask({
      projectId: 'project-1', nodeId: `node-${taskType}`, nodeType: 'ai-video', provider: taskType,
      taskType, taskId: `task-${taskType}`, submitted: true,
    }));
    savePendingTask({ projectId: 'project-1', nodeId: 'node-cancelling', nodeType: 'ai-video', provider: 'comfyui',
      taskType: 'comfyui', taskId: 'cancel-task', submitted: true, comfyRecoveryState: 'cancel_pending' });

    const toolContext = { ...context, signal: new AbortController().signal };
    const result = await getAgentTool('media_pending_tasks')!.execute(toolContext, {});
    const listed = JSON.parse(result.modelContent) as Array<{ nodeId: string; taskId: string; canResume: boolean }>;
    expect(listed).toHaveLength(dedicatedTypes.length + 1);
    const definition = getAgentTool('media_resume_task')!;
    for (const task of listed) {
      expect(task.canResume).toBe(false);
      const input = { nodeId: task.nodeId, taskId: task.taskId };
      expect(definition.authorize?.(context, input).allowed).toBe(false);
      expect(await definition.execute(toolContext, input))
        .toMatchObject({ status: 'error', errorCode: 'MEDIA_RECOVERY_STALE' });
    }
  });
});

describe('media_generate display parameters', () => {
  function configureVisualModels() {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, custom: { name: '自定义', catalogId: 'custom-openai',
        apiKey: 'fixture-private-key', baseUrl: 'https://private.example/v1' } },
      generalModels: [
        { id: 'image-custom', name: '图片', modelId: 'image-x', category: 'image', providerConfigId: 'custom',
          imageCapability: { resolutions: ['2K'], ratios: ['1:1'], qualities: ['low', 'high'], backgrounds: ['opaque', 'transparent'] } },
        { id: 'video-custom', name: '视频', modelId: 'video-x', category: 'video', providerConfigId: 'custom',
          videoCapability: { operations: ['text-to-video'], frameRates: [24, 30], supportsAudio: true,
            minDuration: 4, maxDuration: 15, automaticDurationValue: -1 } },
      ],
    } }));
  }

  it('普通模型能力发现只返回声明的参数，不返回连接地址、协议或 Key', async () => {
    configureVisualModels();
    const tool = getAgentTool('media_model_parameters')!;
    const toolContext = { ...context, signal: new AbortController().signal };
    const image = await tool.execute(toolContext, { modelRef: 'general/image-custom' });
    expect(JSON.parse(image.modelContent)).toMatchObject({ kind: 'image', capability: {
      qualities: ['low', 'high'], backgrounds: ['opaque', 'transparent'],
    } });
    const video = await tool.execute(toolContext, { modelRef: 'general/video-custom' });
    expect(JSON.parse(video.modelContent)).toMatchObject({ kind: 'video', capability: {
      frameRates: [24, 30], supportsAudio: true, automaticDurationValue: -1,
    } });
    for (const text of [image.modelContent, video.modelContent]) {
      expect(text).not.toContain('fixture-private-key');
      expect(text).not.toContain('private.example');
      expect(text).not.toContain('executionProfile');
    }
  });

  it.each([
    { kind: 'image', modelRef: 'general/image-custom', imageQuality: 'high', imageBackground: '' },
    { kind: 'video', modelRef: 'general/video-custom', duration: -1, videoFps: 24, generateAudio: false },
  ])('$kind 工具参数通过 schema 并在审批和生成时保留', async (parameters) => {
    configureVisualModels();
    useAppStore.setState({ messages: [{ id: 'visual-message', conversationId: context.conversationId,
      role: 'assistant', content: '', timestamp: 1, status: 'executing', agentTaskId: context.taskId }] });
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration').mockResolvedValue({
      id: 'visual-artifact', kind: parameters.kind as 'image' | 'video', deliveryMode: 'chat',
      url: 'https://cdn.example/result', sourceUrl: 'https://cdn.example/result', persistence: 'skipped',
      prompt: '镜头', modelId: parameters.modelRef, provider: 'general', createdAt: 1,
    });
    const input = { ...parameters, prompt: '镜头', deliveryMode: 'chat' };
    const prepared = prepareAgentToolCall({ callId: 'visual', toolId: 'media_generate', input }, context);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const tool = getAgentTool('media_generate')!;
    expect(tool.authorize?.(context, prepared.prepared.input).allowed).toBe(true);
    const display = tool.buildInputDisplay?.(prepared.prepared.input, context);
    expect(display?.fields).toEqual(expect.arrayContaining(parameters.kind === 'image'
      ? [expect.objectContaining({ label: '生成背景', value: '接口默认' })]
      : [expect.objectContaining({ label: '生成音轨', value: '关闭' })]));
    await tool.execute({ ...context, signal: new AbortController().signal }, prepared.prepared.input);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining(parameters), context.projectId, expect.any(AbortSignal),
      undefined, expect.objectContaining({ messageId: 'visual-message' }));
  });

  it('敏感参数在解析与直接执行时都被拒绝，不创建画布占位或回显原值', async () => {
    configureVisualModels();
    const secret = 'sk-example-secret';
    const input = { kind: 'image', prompt: '山谷', modelRef: 'general/image-custom', deliveryMode: 'canvas', imageQuality: secret };
    const prepared = prepareAgentToolCall({ callId: 'unsafe-visual', toolId: 'media_generate', input }, context);
    expect(prepared.ok).toBe(false);
    expect(JSON.stringify(prepared)).not.toContain(secret);
    const tool = getAgentTool('media_generate')!;
    expect(tool.authorize?.(context, input).allowed).toBe(false);
    const result = await tool.execute({ ...context, signal: new AbortController().signal }, input);
    expect(result).toMatchObject({ status: 'error', errorCode: 'MEDIA_PARAMETER_INVALID' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(useAppStore.getState().nodes).toHaveLength(1);
  });

  it('继承的项目图片默认值包含路径时，也在创建占位前拒绝且不回显', async () => {
    configureVisualModels();
    const path = 'D:\\private\\image.png';
    useAppStore.setState((state) => ({ projects: state.projects.map((project) => ({ ...project,
      settings: { ...project.settings, generation: { ...project.settings?.generation, imageSize: path } },
    })) }));
    const input = { kind: 'image', prompt: '山谷', modelRef: 'general/image-custom', deliveryMode: 'canvas' };
    const prepared = prepareAgentToolCall({ callId: 'unsafe-default', toolId: 'media_generate', input }, context);
    expect(prepared.ok).toBe(false);
    expect(JSON.stringify(prepared)).not.toContain(path);
    const result = await getAgentTool('media_generate')!.execute({ ...context, signal: new AbortController().signal }, input);
    expect(result).toMatchObject({ status: 'error', errorCode: 'MEDIA_PARAMETER_INVALID' });
    expect(JSON.stringify(result)).not.toContain(path);
    expect(useAppStore.getState().nodes).toHaveLength(1);
  });

  function configureGeneralAudio() {
    useAppStore.setState((state) => ({ config: { ...state.config,
      providers: { ...state.config.providers, 'libapi-audio': { name: 'LibAPI', catalogId: 'libapi',
        apiKey: 'fixture', baseUrl: 'https://libapi.cc/v1' } },
      generalModels: [
        { id: 'libapi-tts', name: 'LibAPI TTS', modelId: 'speech-2.8', category: 'audio', providerConfigId: 'libapi-audio' },
        { id: 'libapi-music', name: 'LibAPI Music', modelId: 'music', category: 'audio', providerConfigId: 'libapi-audio' },
      ],
    } }));
  }

  it.each(['chat', 'both'] as const)('keeps model voice and MP3 settings from the tool through %s delivery', async (deliveryMode) => {
    configureGeneralAudio();
    useAppStore.setState({ messages: [{ id: 'audio-message', conversationId: context.conversationId,
      role: 'assistant', content: '', timestamp: 1, status: 'executing', agentTaskId: context.taskId }] });
    const generate = vi.spyOn(generationRuntime, 'runMediaGeneration').mockResolvedValue({
      id: 'audio-artifact', kind: 'audio', deliveryMode, url: 'https://cdn.example/voice.mp3',
      sourceUrl: 'https://cdn.example/voice.mp3', persistence: 'skipped', prompt: '欢迎回来',
      modelId: 'general/libapi-tts', provider: 'general', audioPurpose: 'speech', createdAt: 1,
    });
    const input = { kind: 'audio', prompt: '欢迎回来', modelRef: 'general/libapi-tts', deliveryMode,
      audioPurpose: 'speech', audioVoice: 'Chinese_Female_01', audioFormat: 'mp3', audioSpeed: 1.25 };
    const definition = getAgentTool('media_generate')!;
    expect(prepareAgentToolCall({ callId: 'libapi-speech', toolId: 'media_generate', input }, context).ok).toBe(true);
    expect(definition.authorize?.(context, input).allowed).toBe(true);

    const result = await definition.execute({ ...context, signal: new AbortController().signal }, input);

    expect(result.status).toBe('success');
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ audioVoice: 'Chinese_Female_01',
      audioFormat: 'mp3', audioSpeed: 1.25 }), context.projectId, expect.any(AbortSignal),
    deliveryMode === 'both' ? expect.any(String) : undefined, expect.objectContaining({ messageId: 'audio-message', deliveryMode }));
    if (deliveryMode === 'both') {
      expect(useAppStore.getState().nodes.at(-1)?.data).toMatchObject({ audioPurpose: 'speech',
        audioVoice: 'Chinese_Female_01', audioFormat: 'mp3', audioSpeed: 1.25, status: 'success' });
    } else expect(useAppStore.getState().nodes).toHaveLength(1);
  });

  it('accepts literal music title and lyrics without using RunningHub modelParameters', () => {
    configureGeneralAudio();
    const input = { kind: 'audio', prompt: '轻柔民谣', modelRef: 'general/libapi-music', deliveryMode: 'chat',
      audioPurpose: 'music', musicTitle: '回家', musicLyrics: '灯火等着我\n沿着路慢慢走' };
    const prepared = prepareAgentToolCall({ callId: 'libapi-music', toolId: 'media_generate', input }, context);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.prepared.input).toMatchObject({ musicTitle: '回家', musicLyrics: '灯火等着我\n沿着路慢慢走' });
      expect(prepared.prepared.input).not.toHaveProperty('modelParameters');
    }
    expect(getAgentTool('media_generate')!.authorize?.(context, input).allowed).toBe(true);
  });

  it('rejects invalid voice IDs and audio fields on another media kind without changing policy', () => {
    configureGeneralAudio();
    const tool = getAgentTool('media_generate')!;
    const input = { kind: 'audio', prompt: '欢迎回来', modelRef: 'general/libapi-tts', deliveryMode: 'chat', audioPurpose: 'speech' };
    for (const audioVoice of ['', ' Zephyr ', 'voice\nID', 'voice\u0085ID', 'x'.repeat(257)]) {
      expect(tool.authorize?.(context, { ...input, audioVoice }).allowed).toBe(false);
    }
    expect(tool.authorize?.(context, { ...input, kind: 'image', audioVoice: 'Zephyr' }).allowed).toBe(false);
    expect(tool.effect).toBe('media_generation');
  });

  it('RunningHub 专属参数保持字符串，且不注入其他模型的视频默认值', () => {
    const id = 'minimax/h3-max-turbo/image-to-video';
    useAppStore.setState((state) => ({ config: { ...state.config, providers: { 'runninghub-model': { name: 'RH', apiKey: 'fake', selectedModels: [{ id, name: 'H3', provider: 'runninghub', category: 'video' }] } } } }));
    const prepared = prepareAgentToolCall({ callId: 'rh-params', toolId: 'media_generate', input: { kind: 'video', prompt: '镜头推进', modelRef: `runninghub/${id}`, deliveryMode: 'chat', modelParameters: [{ name: 'duration', value: '15' }] } }, context);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.prepared.input).toMatchObject({ modelParameters: [{ name: 'duration', value: '15' }] });
      expect(prepared.prepared.input).not.toHaveProperty('resolution');
      expect(prepared.prepared.input).not.toHaveProperty('duration');
    }
    const read = prepareAgentToolCall({ callId: 'rh-read', toolId: 'media_model_parameters', input: { modelRef: `runninghub/${id}` } }, { ...context, mode: 'plan' });
    expect(read.ok).toBe(true);
  });
  it('uses the project default media model when modelRef is omitted', () => {
    useAppStore.setState((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        settings: { ...project.settings, defaultModels: { video: 'general/video-default' } },
      })),
    }));
    const prepared = prepareAgentToolCall({
      callId: 'call-default',
      toolId: 'media_generate',
      input: { kind: 'video', prompt: '普通镜头', deliveryMode: 'chat' },
    }, context);

    expect(prepared).toMatchObject({ ok: true });
    if (prepared.ok) expect(prepared.prepared.input).toMatchObject({ modelRef: 'general/video-default' });
  });

  it('autonomous routing ranks user model descriptions and overrides the default', () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          custom: { name: '自定义', apiKey: 'secret', baseUrl: 'https://example.com' },
        },
        generalModels: [
          { id: 'video-default', name: '通用视频', modelId: 'video-a', category: 'video', providerConfigId: 'custom' },
          { id: 'video-anime', name: '动画专用', description: '擅长二次元动画与运镜', modelId: 'video-b', category: 'video', providerConfigId: 'custom' },
        ],
      },
      projects: state.projects.map((project) => ({
        ...project,
        settings: {
          ...project.settings,
          defaultModels: { video: 'general/video-default' },
          modelAutoRouting: true,
        },
      })),
    }));
    const prepared = prepareAgentToolCall({
      callId: 'call-auto',
      toolId: 'media_generate',
      input: { kind: 'video', prompt: '二次元 动画 运镜', deliveryMode: 'chat' },
    }, { ...context, mode: 'autonomous' });

    expect(prepared).toMatchObject({ ok: true });
    if (prepared.ok) expect(prepared.prepared.input).toMatchObject({ modelRef: 'general/video-anime' });
  });

  it('locks project video defaults before approval and exposes them in the display', () => {
    const prepared = prepareAgentToolCall({
      callId: 'call-1',
      toolId: 'media_generate',
      input: {
        kind: 'video',
        prompt: '基于 @{n1:首帧} 生成向前推进镜头',
        deliveryMode: 'canvas',
      },
    }, context);

    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    expect(prepared.prepared.input).toMatchObject({
      aspectRatio: '16:9',
      resolution: '1080p',
      duration: 10,
    });
    expect(prepared.prepared.definition.buildInputDisplay?.(
      prepared.prepared.input,
      context,
    )).toMatchObject({
      fields: expect.arrayContaining([
        { label: '画面比例', value: '16:9', source: 'resolved' },
        { label: '分辨率', value: '1080p', source: 'resolved' },
        { label: '时长', value: '10 秒', source: 'resolved' },
      ]),
      references: [{ kind: 'node', id: 'n1', label: '首帧', mediaKind: 'image' }],
    });
  });

  it('keeps explicit video parameters instead of replacing them with project defaults', () => {
    const prepared = prepareAgentToolCall({
      callId: 'call-2',
      toolId: 'media_generate',
      input: {
        kind: 'video',
        prompt: '竖屏人物镜头',
        deliveryMode: 'chat',
        aspectRatio: '9:16',
        resolution: '720p',
        duration: 6,
      },
    }, context);

    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    expect(prepared.prepared.input).toMatchObject({
      aspectRatio: '9:16',
      resolution: '720p',
      duration: 6,
    });
  });

  it('keeps omitted custom API video fields unspecified and accepts model-specific values', () => {
    useAppStore.setState((state) => ({
      config: {
        ...state.config,
        providers: {
          ...state.config.providers,
          custom: { name: '自定义', apiKey: '', baseUrl: 'https://gateway.example.com' },
        },
        generalModels: [{
          id: 'video-custom',
          name: '自定义视频',
          modelId: 'video-custom-upstream',
          category: 'video',
          providerConfigId: 'custom',
          videoCapability: {
            ratios: ['7:4'],
            resolutions: ['2K'],
            maxDuration: 30,
          },
        }],
      },
      projects: state.projects.map((project) => ({
        ...project,
        settings: { ...project.settings, defaultModels: { video: 'general/video-custom' } },
      })),
    }));

    const omitted = prepareAgentToolCall({
      callId: 'call-custom-default',
      toolId: 'media_generate',
      input: { kind: 'video', prompt: '自定义镜头', deliveryMode: 'chat' },
    }, context);
    expect(omitted).toMatchObject({ ok: true });
    if (omitted.ok) {
      expect(omitted.prepared.input).toMatchObject({ modelRef: 'general/video-custom' });
      expect(omitted.prepared.input).not.toHaveProperty('aspectRatio');
      expect(omitted.prepared.input).not.toHaveProperty('resolution');
      expect(omitted.prepared.input).not.toHaveProperty('duration');
    }

    const explicit = prepareAgentToolCall({
      callId: 'call-custom-explicit',
      toolId: 'media_generate',
      input: {
        kind: 'video',
        prompt: '自定义镜头',
        deliveryMode: 'chat',
        aspectRatio: '7:4',
        resolution: '2K',
        duration: 30,
      },
    }, context);
    expect(explicit).toMatchObject({ ok: true });
    if (explicit.ok) {
      expect(explicit.prepared.input).toMatchObject({
        aspectRatio: '7:4',
        resolution: '2K',
        duration: 30,
      });
    }
  });
});
