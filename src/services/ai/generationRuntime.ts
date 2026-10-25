/**
 * ai/generationRuntime — 对话媒体生成统一入口。
 *
 * ChatPanel / Agent 工具不再直接选择 Provider 或调用具体图片、视频、音频服务，
 * 而是统一走 runMediaGeneration(intent)，由本模块完成：
 *   1. 解析并剥离 @model{...} 引用（extractModelMention / stripModelMentions）；
 *   2. 解析媒体模型（resolveMediaModel），统一校验模型类型、API Key、ComfyUI / 即梦等前置条件；
 *   3. 按 kind 分发到 generateImage / generateVideo / generateAudio；
 *   4. 产物落盘（persistGeneratedMedia），并如实区分「生成成功」与「已保存到项目」两种状态，
 *      失败不再被吞掉，避免签名 URL 过期或 blob 失效后留下打不开的产物。
 *
 * 产物落盘失败后可通过 retryMediaArtifactPersist 重新写盘。
 */
import { useAppStore } from '../../store/useAppStore';
import {
  isTauriEnv,
  isTransientMediaUrl,
  persistMediaUrlToProjectData,
} from '../fileService';
import { comfyBaseUrlFor } from '../comfyServers';
import { isRunningHubWorkflow, mediaProviderConfigId, workflowExecution, runningHubConnection } from '../workflowExecutionService';
import { getRunningHubModel } from './providers/runninghubModelManifest';
import { workflowApiConnection } from '../workflowApi/workflowApiAdapter';
import { getCloudWorkflowPersistedOutput } from '../workflowExecutionService';
import type {
  MediaGenerationIntent,
  MediaGenerationResult,
  MediaKind,
  MediaPersistenceStatus,
  ResolvedMediaModel,
} from '../../types/media';
import { generateImage } from './generateImage';
import { generateVideo } from './generateVideo';
import { generateAudio, persistAudioGenerationResult } from './generateAudio';
import { findMediaModelOption } from '../../components/nodes/shared/defaultModels';
import { videoLongSideFromLabel } from '../aiDimensions';
import { resolveProjectGenerationPrompt } from '../projectSettingsService';
import type { BaseNodeData, NodeType } from '../../types';
import type { MediaTaskReceipt } from '../../types/aiTypes';
import { tagGeneratedProjectAssetSafely } from '../fs/generatedAssetTags';
import {
  bindMediaTaskContext, completeMediaNodeTask, getMediaTaskReceipt, getPendingTasksForProject, pauseMediaTask,
  registerMediaMessageRecoveryHandler, registerMediaNodeOperation, resumeMediaNodeTask,
  updatePendingTask,
  type PendingTask,
} from '../pollManager';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../canvasDerivationGuard';
import { persistMessage } from '../chat/chatHistoryService';

const MODEL_MENTION_RE = /@model\{([^|}\s]+)(?:\|[^}]*)?\}/i;

const MEDIA_NODE_TYPES: Record<MediaKind, NodeType> = {
  image: 'ai-image',
  video: 'ai-video',
  audio: 'ai-audio',
};

const MEDIA_LABELS: Record<MediaKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};

export const MEDIA_PERSIST_FAILED_MESSAGE = '产物未能写入项目目录，当前是临时地址，重启后可能失效';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
}

export function extractModelMention(input: string): string | undefined {
  return MODEL_MENTION_RE.exec(input)?.[1]?.trim() || undefined;
}

export function stripModelMentions(input: string): string {
  return input.replace(new RegExp(MODEL_MENTION_RE.source, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
}

export function resolveMediaModel(kind: MediaKind, modelRef?: string): ResolvedMediaModel {
  const config = useAppStore.getState().config;
  if (!modelRef) {
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
    throw new Error(`请先通过 @ 选择${label}模型`);
  }

  const option = findMediaModelOption(
    modelRef,
    config.generalModels ?? [],
    config,
    useAppStore.getState().workflows,
  );
  if (!option) throw new Error('未找到 @ 引用的媒体模型');
  if (option.mediaKind !== kind) {
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
    throw new Error(`模型“${option.label}”不能用于${label}生成`);
  }

  if (option.provider === 'general') {
    const generalId = option.value.slice('general/'.length);
    const generalModel = (config.generalModels ?? []).find((model) => model.id === generalId);
    if (!generalModel) throw new Error('未找到 @ 引用的通用模型配置');
    const provider = config.providers[generalModel.providerConfigId];
    if (!provider?.baseUrl || !generalModel.modelId) {
      throw new Error(`模型“${generalModel.name}”的接口配置不完整`);
    }
    return {
      configId: option.value,
      requestModel: `general/${generalModel.id}`,
      provider: 'general',
      audioPurpose: option.audioPurpose,
    };
  }

  if (option.workflowId) {
    const workflow = useAppStore.getState().workflows.find((item) => item.id === option.workflowId);
    if (workflow?.adapterType === 'workflow-api' && workflow.workflowApi) {
      workflowApiConnection(config.providers[workflow.workflowApi.connectionId], workflow.workflowApi);
      const execution = workflowExecution(workflow);
      return { configId: option.value, requestModel: execution.model, provider: execution.provider, workflowId: workflow.id };
    }
    if (isRunningHubWorkflow(workflow) && workflow?.runninghub) {
      runningHubConnection(config.providers, workflow.runninghub.connectionId);
      const execution = workflowExecution(workflow);
      return { configId: option.value, requestModel: execution.model, provider: execution.provider, workflowId: workflow.id };
    }
    if (!comfyBaseUrlFor(option.workflowId)) {
      throw new Error('未配置 ComfyUI 服务地址\n请在「设置 → ComfyUI」中配置');
    }
    return {
      configId: option.value,
      requestModel: 'comfyui/workflow',
      provider: 'comfyui',
      workflowId: option.workflowId,
    };
  }

  if (option.provider === 'dreamina') {
    if (!config.dreaminaAuth?.loggedIn) throw new Error('请先登录即梦账号');
  } else if (!config.providers[mediaProviderConfigId(option.provider)]?.apiKey) {
    throw new Error(`请先配置 ${option.provider} 的 API Key`);
  }

  return {
    configId: option.value,
    requestModel: option.value,
    provider: option.provider,
    audioPurpose: option.audioPurpose,
  };
}

async function saveGeneratedMedia(
  url: string,
  projectId: string,
  kind: MediaKind,
  artifactId: string,
) {
  const baseName = `对话${MEDIA_LABELS[kind]}-${artifactId}`;
  return persistMediaUrlToProjectData(url, projectId, MEDIA_NODE_TYPES[kind], baseName);
}

interface MediaPersistOutcome {
  status: MediaPersistenceStatus;
  filePath?: string;
  assetUrl?: string;
  sourceUrl?: string;
  error?: string;
}

/**
 * 落盘生成产物，并如实返回结果。
 * 失败不再被吞掉：调用方据此把「生成成功」和「已保存到项目」分开呈现，
 * 否则签名 URL 过期或 blob 失效后，用户手里就只剩一个打不开的产物。
 */
async function persistGeneratedMedia(
  url: string,
  projectId: string | null | undefined,
  kind: MediaKind,
  artifactId: string,
): Promise<MediaPersistOutcome> {
  if (!projectId || !isTauriEnv()) return { status: 'skipped' };
  try {
    const saved = await saveGeneratedMedia(url, projectId, kind, artifactId);
    if (!saved?.filePath) return { status: 'failed', error: MEDIA_PERSIST_FAILED_MESSAGE };
    return {
      status: 'saved',
      filePath: saved.filePath,
      assetUrl: saved.mediaUrl,
      sourceUrl: saved.sourceUrl,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : MEDIA_PERSIST_FAILED_MESSAGE,
    };
  }
}

async function tagSavedGeneratedMedia(
  filePath: string | undefined,
  projectId: string | null | undefined,
  prompt: string,
): Promise<void> {
  if (!filePath || !projectId) return;
  await tagGeneratedProjectAssetSafely({ filePath, projectId, prompt });
}

export async function runMediaGeneration(
  intent: MediaGenerationIntent,
  projectId?: string | null,
  signal?: AbortSignal,
  targetNodeId?: string,
  runninghubTaskContext?: import('../../types/runninghub').RunningHubTaskContext,
): Promise<MediaGenerationResult> {
  throwIfAborted(signal);
  if (intent.kind !== 'audio' && [intent.audioVoice, intent.audioFormat, intent.audioSpeed, intent.musicTitle, intent.musicLyrics]
    .some((value) => value !== undefined)) throw new Error('音频参数只能用于音频生成');
  if (!stripModelMentions(intent.prompt)) throw new Error('媒体生成提示词不能为空');
  const model = resolveMediaModel(intent.kind, intent.modelRef);
  ensureMediaMessageRecoveryHandler();
  const nativeCloud = ['runninghubwf', 'runninghub', 'workflow-api'].includes(model.provider);
  const trackingId = targetNodeId ?? (!nativeCloud && runninghubTaskContext
    ? `media-message-${runninghubTaskContext.messageId}-${crypto.randomUUID()}` : undefined);
  let operationReceipt: MediaTaskReceipt | undefined;
  const taskProjectId = runninghubTaskContext?.projectId ?? projectId ?? useAppStore.getState().currentProjectId;
  const unbind = trackingId && !nativeCloud && taskProjectId ? bindMediaTaskContext(trackingId, {
    projectId: taskProjectId,
    conversationId: runninghubTaskContext?.conversationId,
    messageId: runninghubTaskContext?.messageId,
    deliveryMode: runninghubTaskContext ? intent.deliveryMode === 'chat' ? 'message' : 'node+message' : 'node',
    canvasNodeId: targetNodeId,
    modelId: model.configId,
  }, (receipt) => { operationReceipt = receipt; }) : undefined;
  const finishOperation = trackingId ? registerMediaNodeOperation(trackingId) : undefined;
  try {
    const artifact = await generateMediaArtifact(intent, projectId, signal, trackingId, runninghubTaskContext, model);
    if (!artifact.taskReceipt && operationReceipt && getPendingTasksForProject(operationReceipt.projectId).some((task) =>
      task.nodeId === operationReceipt!.nodeId && task.taskId === operationReceipt!.taskId && task.attemptId === operationReceipt!.attemptId)) {
      artifact.taskReceipt = operationReceipt;
    }
    if (artifact.taskReceipt && artifact.persistence === 'failed') {
      pauseMediaTask(artifact.taskReceipt, undefined, 'delivery_pending');
    }
    return artifact;
  } catch (error) {
    if (operationReceipt) {
      const paused = pauseMediaTask(operationReceipt, error, operationReceipt.taskId ? 'query_interrupted' : 'submit_unknown');
      if (paused) throw paused;
    }
    throw error;
  } finally {
    finishOperation?.();
    unbind?.();
  }
}

async function generateMediaArtifact(
  intent: MediaGenerationIntent,
  projectId: string | null | undefined,
  signal: AbortSignal | undefined,
  targetNodeId: string | undefined,
  runninghubTaskContext: import('../../types/runninghub').RunningHubTaskContext | undefined,
  model: ResolvedMediaModel,
): Promise<MediaGenerationResult> {
  throwIfAborted(signal);

  const prompt = stripModelMentions(intent.prompt);
  if (!prompt) throw new Error('媒体生成提示词不能为空');

  const store = useAppStore.getState();
  const targetProjectId = projectId ?? store.currentProjectId;
  const projectSettings = store.projects.find(
    (project) => project.id === targetProjectId,
  )?.settings;
  const effectivePrompt = resolveProjectGenerationPrompt({
    prompt,
    data: {
      label: '对话媒体生成',
      type: MEDIA_NODE_TYPES[intent.kind],
      role: 'generator',
    } as BaseNodeData,
    settings: projectSettings,
    customStyles: store.customStyles,
  });

  if (model.provider === 'runninghubwf' && [intent.aspectRatio, intent.resolution, intent.duration].some((value) => value !== undefined)) throw new Error('请通过工作流参数设置比例、分辨率或时长');
  if (model.provider === 'workflow-api' && useAppStore.getState().workflows.find((workflow) => workflow.id === model.workflowId)?.workflowApi?.version === 2
    && [intent.aspectRatio, intent.resolution, intent.duration].some((value) => value !== undefined)) throw new Error('自定义工作流请通过 workflowInputs 设置参数');
  if (
    intent.kind === 'audio'
    && intent.audioPurpose
    && model.audioPurpose
    && intent.audioPurpose !== model.audioPurpose
  ) {
    throw new Error(`所选模型不支持${intent.audioPurpose === 'music' ? '音乐' : '语音'}生成`);
  }
  const runninghubModelParameters = { ...intent.runninghubModelParameters };
  if (model.provider === 'runninghub') {
    const definition = getRunningHubModel(model.requestModel);
    for (const [name, value] of Object.entries({ aspectRatio: intent.aspectRatio, resolution: intent.resolution, duration: intent.duration })) {
      if (value === undefined) continue;
      const field = definition?.parameters.find((field) => field.name === name || (name === 'aspectRatio' && field.name === 'ratio'));
      if (!field) throw new Error(`所选 RunningHub 操作没有 ${name} 参数，请读取模型专属参数`);
      if (runninghubModelParameters[field.name] !== undefined && runninghubModelParameters[field.name] !== String(value)) throw new Error('通用参数与模型专属参数冲突');
      runninghubModelParameters[field.name] = String(value);
    }
  }
  const id = `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (intent.kind === 'image') {
    const result = await generateImage({
      prompt: effectivePrompt,
      model: model.requestModel,
      provider: model.provider,
      imageSize: projectSettings?.generation?.imageSize || '2K',
      aspectRatio: projectSettings?.generation?.imageAspectRatio || '1:1',
      workflowId: model.workflowId,
      workflowInputs: intent.workflowInputs, runninghubModelParameters: model.provider === 'runninghub' ? runninghubModelParameters : undefined,
      nodeId: targetNodeId,
      runninghubTaskContext,

      workflowApiTaskContext: model.provider === 'workflow-api' ? runninghubTaskContext : undefined,
    }, signal);
    const taskReceipt = result.taskReceipt ?? (result.comfyTaskId && targetNodeId ? getMediaTaskReceipt(targetNodeId, result.comfyTaskId) : undefined);
    throwIfAborted(signal);
    const savedCloud = getCloudWorkflowPersistedOutput(result.workflowApiOutputs ?? result.runninghubOutputs, result.url);
    const persisted: MediaPersistOutcome = savedCloud ? { ...savedCloud, status: savedCloud.persistence } : await persistGeneratedMedia(result.url, projectId, intent.kind, id);
    if (persisted.status === 'failed' && isTransientMediaUrl(result.url) && !taskReceipt) {
      throw new Error(persisted.error || MEDIA_PERSIST_FAILED_MESSAGE);
    }
    await tagSavedGeneratedMedia(persisted.filePath, projectId, effectivePrompt);
    throwIfAborted(signal);
    return {
      id,
      kind: intent.kind,
      taskReceipt,
      runninghubOutputs: result.runninghubOutputs,

      workflowApiOutputs: result.workflowApiOutputs, workflowApiTaskId: result.workflowApiTaskId,
      deliveryMode: intent.deliveryMode,
      url: persisted.assetUrl || result.url,
      sourceUrl: persisted.sourceUrl || result.url,
      filePath: persisted.filePath,
      persistence: persisted.status,
      persistError: persisted.error,
      width: result.width,
      height: result.height,
      prompt,
      modelId: model.configId,
      provider: model.provider,
      createdAt: Date.now(),
    };
  }

  if (intent.kind === 'video') {
    const directGeneralProtocol = ((model.provider === 'general' || model.provider === 'runninghub') && !model.workflowId) || model.provider === 'workflow-api';
    const aspectRatio = intent.aspectRatio
      ?? (directGeneralProtocol ? undefined : projectSettings?.generation?.videoAspectRatio);
    const resolution = intent.resolution
      ?? (directGeneralProtocol ? undefined : projectSettings?.generation?.videoResolution);
    const duration = intent.duration
      ?? (directGeneralProtocol ? undefined : projectSettings?.generation?.videoDuration);
    const result = await generateVideo({
      prompt: effectivePrompt,
      model: model.requestModel,
      provider: model.provider,
      seedanceRatio: aspectRatio,
      seedanceResolution: resolution,
      seedanceDuration: duration,
      // 工作流只认数字长边，档位换算后再传
      videoResolution: directGeneralProtocol ? undefined : videoLongSideFromLabel(resolution),
      workflowId: model.workflowId,
      workflowInputs: intent.workflowInputs, runninghubModelParameters: model.provider === 'runninghub' ? runninghubModelParameters : undefined,
      nodeId: targetNodeId,
      runninghubTaskContext,
      workflowApiTaskContext: model.provider === 'workflow-api' ? runninghubTaskContext : undefined,
    }, signal);
    const taskReceipt = result.taskReceipt ?? (result.comfyTaskId && targetNodeId ? getMediaTaskReceipt(targetNodeId, result.comfyTaskId) : undefined);
    throwIfAborted(signal);
    const savedCloud = getCloudWorkflowPersistedOutput(result.workflowApiOutputs ?? result.runninghubOutputs, result.url);
    const persisted: MediaPersistOutcome = savedCloud ? { ...savedCloud, status: savedCloud.persistence } : await persistGeneratedMedia(result.url, projectId, intent.kind, id);
    if (persisted.status === 'failed' && isTransientMediaUrl(result.url) && !taskReceipt) {
      throw new Error(persisted.error || MEDIA_PERSIST_FAILED_MESSAGE);
    }
    await tagSavedGeneratedMedia(persisted.filePath, projectId, effectivePrompt);
    throwIfAborted(signal);
    return {
      id,
      kind: intent.kind,
      taskReceipt,
      runninghubOutputs: result.runninghubOutputs,
      workflowApiOutputs: result.workflowApiOutputs, workflowApiTaskId: result.workflowApiTaskId,
      deliveryMode: intent.deliveryMode,
      url: persisted.assetUrl || result.url,
      sourceUrl: persisted.sourceUrl || result.url,
      filePath: persisted.filePath,
      persistence: persisted.status,
      persistError: persisted.error,
      prompt,
      modelId: model.configId,
      provider: model.provider,
      createdAt: Date.now(),
    };
  }

  const result = await generateAudio({
    prompt: effectivePrompt,
    model: model.requestModel,
    provider: model.provider,
    ...(intent.audioVoice !== undefined ? { audioVoice: intent.audioVoice } : {}),
    ...(intent.audioFormat !== undefined ? { audioFormat: intent.audioFormat } : {}),
    ...(intent.audioSpeed !== undefined ? { audioSpeed: intent.audioSpeed } : {}),
    ...(intent.musicTitle !== undefined ? { musicTitle: intent.musicTitle } : {}),
    ...(intent.musicLyrics !== undefined ? { musicLyrics: intent.musicLyrics } : {}),
    workflowId: model.workflowId,
    workflowInputs: intent.workflowInputs, runninghubModelParameters: model.provider === 'runninghub' ? runninghubModelParameters : undefined,
    nodeId: targetNodeId,
    runninghubTaskContext,

    workflowApiTaskContext: model.provider === 'workflow-api' ? runninghubTaskContext : undefined,
  }, signal);
  const taskReceipt = result.taskReceipt ?? (result.comfyTaskId && targetNodeId ? getMediaTaskReceipt(targetNodeId, result.comfyTaskId) : undefined);
  throwIfAborted(signal);
  const persisted = await persistAudioGenerationResult(
    result,
    projectId,
    `对话音频-${id}`,
  );
  await tagSavedGeneratedMedia(persisted.filePath, projectId, effectivePrompt);
  throwIfAborted(signal);
  return {
    id,
    kind: intent.kind,
    taskReceipt,
    runninghubOutputs: result.runninghubOutputs,

    workflowApiOutputs: result.workflowApiOutputs, workflowApiTaskId: result.workflowApiTaskId,
    deliveryMode: intent.deliveryMode,
    url: persisted.mediaUrl,
    sourceUrl: persisted.sourceUrl || persisted.outputUrl,
    filePath: persisted.filePath,
    persistence: persisted.persistence,
    persistError: persisted.persistError,
    prompt,
    modelId: model.configId,
    provider: model.provider,
    audioPurpose: intent.audioPurpose,
    createdAt: Date.now(),
  };
}

/**
 * 重新把已生成的产物写入项目目录（用于落盘失败后的重试下载）。
 * 成功时返回指向本地文件的新产物，失败时抛出可直接展示的原因。
 */
export async function retryMediaArtifactPersist(
  artifact: MediaGenerationResult,
  projectId?: string | null,
): Promise<MediaGenerationResult> {
  if (!isTauriEnv()) throw new Error('浏览器模式不支持把产物保存到项目目录');
  const targetProjectId = projectId ?? useAppStore.getState().currentProjectId;
  if (!targetProjectId) throw new Error('当前没有打开的项目，无法保存产物');

  const sourceUrl = artifact.sourceUrl || artifact.url;
  if (!sourceUrl) throw new Error('产物已没有可用的下载地址，请重新生成');

  const persisted = await persistGeneratedMedia(
    sourceUrl,
    targetProjectId,
    artifact.kind,
    artifact.id,
  );
  if (persisted.status !== 'saved') {
    throw new Error(persisted.error || MEDIA_PERSIST_FAILED_MESSAGE);
  }
  await tagSavedGeneratedMedia(persisted.filePath, targetProjectId, artifact.prompt);
  return {
    ...artifact,
    url: persisted.assetUrl || artifact.url,
    sourceUrl: persisted.sourceUrl || artifact.sourceUrl,
    filePath: persisted.filePath,
    persistence: 'saved',
    persistError: undefined,
  };
}

/** 只暴露原消息的任务身份，不从消息或模型提供的 URL 重建查询协议。 */
export function getRecoverableMessageTask(messageId: string, projectId?: string | null): PendingTask | undefined {
  const targetProjectId = projectId ?? useAppStore.getState().currentProjectId;
  if (!targetProjectId) return undefined;
  return getPendingTasksForProject(targetProjectId).find((task) => task.mediaContext?.messageId === messageId);
}

export async function retryMediaMessageTask(messageId: string): Promise<void> {
  const task = getRecoverableMessageTask(messageId);
  if (!task) throw new Error('未找到该消息的待恢复任务');
  if (!task.taskId || !task.submitted) throw new Error('提交状态未知，请先到对应平台核对任务，避免重复生成');
  ensureMediaMessageRecoveryHandler();
  try {
    await resumeMediaNodeTask(task.nodeId);
  } catch (error) {
    const state = useAppStore.getState();
    const message = state.messages.find((item) => item.id === messageId && item.conversationId === task.mediaContext?.conversationId);
    if (state.currentProjectId === task.projectId && message
      && !getRecoverableMessageTask(messageId, task.projectId)
      && (!message.mediaResult || message.mediaResult.taskReceipt?.taskId === task.taskId
        && message.mediaResult.taskReceipt.attemptId === task.attemptId)) {
      state.updateMessage(messageId, { mediaStatus: 'failed', mediaError: error instanceof Error ? error.message : '原任务未返回可交付结果' });
    }
    throw error;
  }
}

/** 消息与画布采用相同交付边界，持久化消息失败时保留原任务。 */
export async function completeMediaMessageDelivery(messageId: string, artifact: MediaGenerationResult, canvasReady: boolean): Promise<void> {
  const receipt = artifact.taskReceipt;
  if (!receipt) return;
  if (artifact.persistence === 'failed' || !canvasReady) {
    pauseMediaTask(receipt, undefined, artifact.persistence === 'failed' ? 'delivery_pending' : 'canvas_changed');
    return;
  }
  const state = useAppStore.getState();
  const message = state.messages.find((item) => item.id === messageId && item.mediaResult?.id === artifact.id);
  if (state.currentProjectId !== receipt.projectId || !message) {
    pauseMediaTask(receipt, undefined, 'canvas_changed');
    return;
  }
  try {
    await persistMessage(message, receipt.projectId, message.conversationId);
    const current = useAppStore.getState();
    if (current.currentProjectId !== receipt.projectId
      || !current.messages.some((item) => item.id === messageId && item.mediaResult?.id === artifact.id)) {
      pauseMediaTask(receipt, undefined, 'canvas_changed');
      return;
    }
    completeMediaNodeTask(receipt);
  } catch (error) {
    pauseMediaTask(receipt, error, 'delivery_pending');
  }
}

async function recoverMediaMessage(task: PendingTask, urls: string[], signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const context = task.mediaContext;
  if (!context?.messageId || !context.conversationId) throw new Error('任务缺少原消息身份');
  const receipt = { projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, attemptId: task.attemptId };
  const isCurrent = () => {
    const state = useAppStore.getState();
    return !signal?.aborted && state.currentProjectId === task.projectId
      && state.messages.some((message) => message.id === context.messageId && message.conversationId === context.conversationId)
      && getPendingTasksForProject(task.projectId).some((saved) => saved.nodeId === task.nodeId
        && saved.taskId === task.taskId && saved.attemptId === task.attemptId);
  };
  if (!isCurrent()) throw new Error('请回到原项目和对话继续取回任务');
  const kind: MediaKind = task.nodeType === 'ai-audio' ? 'audio' : task.nodeType === 'ai-video' ? 'video' : 'image';
  const sourceUrl = urls[0];
  if (!sourceUrl) throw new Error('任务已完成，但没有可保存的媒体结果');
  const state = useAppStore.getState();
  const existing = state.messages.find((message) => message.id === context.messageId)?.mediaResult;
  const previous = existing?.taskReceipt?.taskId === task.taskId
    && existing.taskReceipt.attemptId === task.attemptId ? existing : undefined;
  const nodeId = context.deliveryMode === 'node+message' ? context.canvasNodeId ?? task.nodeId : undefined;
  const guard = nodeId ? registerCanvasDerivation(state, nodeId) : null;
  try {
    const persisted = await persistGeneratedMedia(sourceUrl, task.projectId, kind, previous?.id ?? `recovered-${task.attemptId ?? task.taskId}`);
    if (!isCurrent()) throw new Error('原项目或对话已变化，任务仍保留');
    if (persisted.status === 'failed') throw new Error(persisted.error || MEDIA_PERSIST_FAILED_MESSAGE);
    const artifact: MediaGenerationResult = {
      ...previous,
      id: previous?.id ?? `recovered-${task.attemptId ?? task.taskId}`,
      kind,
      taskReceipt: receipt,
      deliveryMode: context.deliveryMode === 'message' ? 'chat' : previous?.deliveryMode ?? 'both',
      url: persisted.assetUrl || sourceUrl,
      sourceUrl: persisted.sourceUrl || sourceUrl,
      filePath: persisted.filePath,
      persistence: persisted.status,
      persistError: undefined,
      prompt: previous?.prompt ?? '',
      modelId: previous?.modelId ?? context.modelId ?? task.provider,
      provider: previous?.provider ?? task.provider,
      createdAt: previous?.createdAt ?? Date.now(),
    };
    const current = useAppStore.getState();
    const currentArtifact = current.messages.find((message) => message.id === context.messageId)?.mediaResult;
    const appendRecovered = !!currentArtifact && (currentArtifact.taskReceipt?.taskId !== task.taskId
      || currentArtifact.taskReceipt?.attemptId !== task.attemptId);
    const deliveryMessageId = appendRecovered ? `media-recovered-${task.nodeId}-${task.attemptId ?? task.taskId}` : context.messageId;
    if (appendRecovered) {
      if (!current.messages.some((message) => message.id === deliveryMessageId)) {
        current.addMessage({ id: deliveryMessageId, conversationId: context.conversationId, role: 'assistant',
          content: '已取回原媒体任务', timestamp: Date.now(), status: 'done' });
      }
      updatePendingTask(task.nodeId, { mediaContext: { ...context, messageId: deliveryMessageId } }, task.taskId, task.attemptId);
    }
    throwIfAborted(signal);
    const canvasReady = !nodeId || !!guard && isCanvasDerivationFresh(guard, current)
      && current.settleMediaPlaceholder(nodeId, artifact);
    throwIfAborted(signal);
    current.updateMessage(deliveryMessageId, {
      mediaResult: artifact, mediaStatus: 'succeeded', mediaError: undefined,
      canvasStatus: nodeId ? canvasReady ? 'created' : 'failed' : 'none', canvasNodeId: nodeId,
      canvasError: canvasReady ? undefined : '原画布已变化，结果已保存，任务尚待回填',
    });
    const message = useAppStore.getState().messages.find((item) => item.id === deliveryMessageId);
    if (message) await persistMessage(message, task.projectId, context.conversationId);
    if (!isCurrent()) throw new Error('原项目或对话已变化，任务仍保留');
    if (!canvasReady) {
      pauseMediaTask(receipt, undefined, 'canvas_changed');
      throw new Error('结果已保存，原画布尚未回填，任务已保留');
    }
    completeMediaNodeTask(receipt);
  } finally {
    if (guard) completeCanvasDerivation(guard);
  }
}

/** 按调用入口安装，避免模块加载时写入轮询运行时。 */
export function ensureMediaMessageRecoveryHandler(): void {
  registerMediaMessageRecoveryHandler(recoverMediaMessage);
}
