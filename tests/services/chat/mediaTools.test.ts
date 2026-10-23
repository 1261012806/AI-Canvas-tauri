import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../src/store/useAppStore';
import { registerMediaAgentTools } from '../../../src/services/chat/tools/mediaTools';
import {
  clearAgentToolRegistryForTests,
  getAgentTool,
  prepareAgentToolCall,
  type AgentToolContext,
} from '../../../src/services/chat/toolRegistry';
import { savePendingTask } from '../../../src/services/pollManager';

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

describe('media task recovery tools', () => {
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
