/**
 * batchExecute — 批量执行节点工具函数
 *
 * 策略：
 * - 工作流节点 → 按展示编号串行，等待生成及结果保存后再执行下一项
 * - 有连线关系的节点 → 按拓扑序依次执行（保证依赖顺序）
 * - 没有连线的独立节点 → 并发执行（Promise.all）
 * - 两组之间也并发执行
 */
import type { Node, Edge } from '@xyflow/react';
import type { BaseNodeData, OutputHistoryEntry } from '../types';
import { ANIMATION_FRAME_GRIDS } from '../types';
import type { MediaTaskReceipt } from '../types/aiTypes';
import {
  generateText,
  generateImage,
  generateVideo,
  generateAudio,
  buildPanoramaPrompt,
} from '../services/aiService';
import {
  buildAnimationSpritePrompt,
  resolveAnimationSheetAspectRatio,
} from '../services/ai/animationPrompt';
import { persistAudioGenerationResult } from '../services/ai/generateAudio';
import { resolveVideoSubmissionControls } from '../services/ai/videoRequestResolver';
import { persistMediaUrlToProjectData } from '../services/fileService';
import { animationProcessing, animationResultPatch } from '../services/animationService';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation, type CanvasDerivationGuard } from '../services/canvasDerivationGuard';
import { beginComfyNodeDelivery, completeComfyNodeTask, completeMediaNodeTask, pauseComfyNodeDelivery, pauseMediaTask, prepareMediaNodeGeneration, registerMediaNodeOperation, isMediaTaskPausedError } from '../services/pollManager';
import { getCloudWorkflowPersistedOutput } from '../services/workflowExecutionService';
import { completeRunningHubNodeTask } from '../services/ai/providers/runninghubWorkflow';
import { videoInputFingerprint } from '../services/videoBatchPlanning';

export interface BatchContext {
  commitToHistory: () => void;
  updateNodeDataTransient: (nodeId: string, data: Partial<BaseNodeData>) => void;
  recordOutputHistory: (
    nodeId: string,
    entry: Omit<OutputHistoryEntry, 'id' | 'projectId'>,
  ) => Promise<void>;
  currentProjectId: string | null;
}

type AINodeType =
  | 'ai-text'
  | 'ai-image'
  | 'ai-animation'
  | 'ai-panorama'
  | 'ai-video'
  | 'ai-audio';

const EXECUTABLE_NODE_TYPES = new Set<AINodeType>([
  'ai-text',
  'ai-image',
  'ai-animation',
  'ai-panorama',
  'ai-video',
  'ai-audio',
]);

// ── 执行单个节点 ──
async function executeOneNode(
  node: Node<BaseNodeData>,
  ctx: BatchContext,
  useAppStore: typeof import('../store/useAppStore').useAppStore,
): Promise<boolean> {
  const d = node.data!;
  if (d.provider === 'workflow-api') {
    if (useAppStore.getState().currentProjectId !== ctx.currentProjectId) return false;
    const { executeGeneration } = await import('../services/generationService');
    if (useAppStore.getState().currentProjectId !== ctx.currentProjectId) return false;
    return (await executeGeneration(node.id)).success;
  }
  const nt = d.type as AINodeType;
  const mediaSubmission = ['ai-image', 'ai-animation', 'ai-panorama', 'ai-video', 'ai-audio'].includes(nt);
  if (mediaSubmission) {
    if (useAppStore.getState().currentProjectId !== ctx.currentProjectId) return false;
    try { prepareMediaNodeGeneration(node.id); }
    catch { return false; }
  }
  const prompt = (d.prompt as string) || '';
  const rawVideoInputs = `${prompt}\n${JSON.stringify(d.workflowInputs ?? {})}`;
  const hasProtectedVideoInputs = nt === 'ai-video' && (Boolean(d.comfyRefmods?.length)
    || rawVideoInputs.includes('@refmod') || rawVideoInputs.includes('/shot/'));
  const refmodFingerprint = hasProtectedVideoInputs ? videoInputFingerprint(node, useAppStore.getState()) : undefined;
  let taskReceipt: MediaTaskReceipt | undefined;
  let mediaDelivered = false;
  const confirmMediaDelivery = () => {
    if (taskReceipt) completeMediaNodeTask(taskReceipt);
    else if (['runninghub', 'runninghubwf'].includes(d.provider ?? '')) completeRunningHubNodeTask(node.id);
    mediaDelivered = true;
  };
  let comfyTaskId: string | undefined;
  let animationGuard: CanvasDerivationGuard | null = null;
  const guarded = mediaSubmission && !!ctx.currentProjectId;
  if (guarded) {
    const state = useAppStore.getState();
    if (state.currentProjectId !== ctx.currentProjectId) return false;
    animationGuard = registerCanvasDerivation(state, node.id);
    if (!animationGuard) return false;
  }
  const isFresh = () => {
    const state = useAppStore.getState();
    if (state.currentProjectId !== ctx.currentProjectId) return false;
    if (!guarded) return true;
    if (!state.nodes.some((item) => item.id === node.id)) return false;
    const current = hasProtectedVideoInputs ? state.nodes.find((item) => item.id === node.id) : undefined;
    return !!animationGuard && isCanvasDerivationFresh(animationGuard, state)
      && (!hasProtectedVideoInputs || (!!current && videoInputFingerprint(current, state) === refmodFingerprint));
  };

  const endOperation = mediaSubmission ? registerMediaNodeOperation(node.id) : undefined;
  ctx.updateNodeDataTransient(node.id, { status: 'loading', error: undefined, videoTaskState: undefined, mediaTaskState: undefined });
  try {
    if (nt === 'ai-text') {
      const result = await generateText({ prompt, model: d.model!, provider: d.provider! });
      const { postProcessDramaExtractOutput } = await import('../services/dramaAssetExtract');
      const processed = postProcessDramaExtractOutput(prompt, result);
      ctx.updateNodeDataTransient(node.id, { output: processed.output, status: 'success' });
      ctx.recordOutputHistory(node.id, {
        nodeId: node.id,
        nodeLabel: d.label,
        timestamp: Date.now(),
        prompt,
        output: processed.output,
        nodeType: 'ai-text',
        model: d.model!,
        provider: d.provider!,
        status: 'success',
      });
      if (processed.ok && processed.parsed) {
        useAppStore.getState().mergeDramaExtract(processed.parsed, {
          sourceNodeId: node.id,
          modelId: d.model,
        });
      }
    } else if (nt === 'ai-image' || nt === 'ai-animation') {
      const isAnimation = nt === 'ai-animation';
      const imageSize = (d.imageSize as string) || '2K';
      const animationAction = d.animationAction ?? 'idle';
      const animationFrames = d.animationFrames ?? 8;
      const aspectRatio = isAnimation
        ? resolveAnimationSheetAspectRatio(animationFrames, d.provider!)
        : (d.aspectRatio as string) || '1:1';
      const spriteProcessing = isAnimation ? animationProcessing({ ...d, animationSheet: undefined }) : undefined;
      const requestPrompt = isAnimation
        ? buildAnimationSpritePrompt(prompt, animationAction, animationFrames, aspectRatio, spriteProcessing)
        : prompt;
      const result = await generateImage({
        prompt: requestPrompt,
        model: d.model!,
        provider: d.provider!,
        imageSize,
        aspectRatio,
        workflowId: d.workflowId,
        workflowInputs: d.workflowInputs,
        nodeId: node.id,
      });
      taskReceipt = result.taskReceipt;
      comfyTaskId = result.comfyTaskId;
      if (comfyTaskId) beginComfyNodeDelivery(node.id, comfyTaskId);
      if (!isFresh()) return false;
      if (taskReceipt) ctx.updateNodeDataTransient(node.id, { mediaTaskStage: 'saving' });
      const persisted = getCloudWorkflowPersistedOutput(result.workflowApiOutputs ?? result.runninghubOutputs, result.url) ?? (ctx.currentProjectId
        ? await persistMediaUrlToProjectData(result.url, ctx.currentProjectId, 'ai-image', d.label)
        : { mediaUrl: result.url, sourceUrl: result.url });
      const mediaUrl = persisted.mediaUrl;
      if (!isFresh()) return false;
      ctx.updateNodeDataTransient(node.id, {
        imageUrl: mediaUrl,
        sourceUrl: persisted.sourceUrl,
        filePath: persisted.filePath,
        thumbnailUrl: mediaUrl,
        output: persisted.sourceUrl,
        status: 'success',
        imageWidth: result.width,
        imageHeight: result.height,
        ...(isAnimation ? { aspectRatio, ...animationResultPatch(d) } : {}),
      });
      confirmMediaDelivery();
      if (result.comfyTaskId) completeComfyNodeTask(node.id, result.comfyTaskId);
      {
        useAppStore.getState().syncDramaAssetImageFromNode?.(node.id, mediaUrl);
      }
      ctx.recordOutputHistory(node.id, {
        nodeId: node.id,
        nodeLabel: d.label,
        timestamp: Date.now(),
        prompt: requestPrompt,
        output: persisted.sourceUrl,
        nodeType: nt,
        model: d.model!,
        provider: d.provider!,
        status: 'success',
        mediaUrl,
        filePath: persisted.filePath,
        params: isAnimation
          ? {
              imageSize,
              aspectRatio,
              animationAction,
              animationFrames,
              grid: ANIMATION_FRAME_GRIDS[animationFrames],
              animationProcessing: spriteProcessing,
              animationPromptVersion: 1,
            }
          : { imageSize, aspectRatio },
      });
    } else if (nt === 'ai-panorama') {
      const imageSize = (d.imageSize as string) || '2K';
      const aspectRatio = (d.aspectRatio as string) || '2:1';
      const result = await generateImage({
        prompt: buildPanoramaPrompt(prompt),
        model: d.model!,
        provider: d.provider!,
        imageSize,
        aspectRatio,
        workflowId: d.workflowId,
        workflowInputs: d.workflowInputs,
        nodeId: node.id,
      });
      taskReceipt = result.taskReceipt;
      comfyTaskId = result.comfyTaskId;
      if (comfyTaskId) beginComfyNodeDelivery(node.id, comfyTaskId);
      if (!isFresh()) return false;
      if (taskReceipt) ctx.updateNodeDataTransient(node.id, { mediaTaskStage: 'saving' });
      const persisted = ctx.currentProjectId
        ? await persistMediaUrlToProjectData(
            result.url,
            ctx.currentProjectId,
            'ai-panorama',
            d.label,
          )
        : { mediaUrl: result.url, sourceUrl: result.url };
      if (!isFresh()) return false;
      const mediaUrl = persisted.mediaUrl;
      ctx.updateNodeDataTransient(node.id, {
        imageUrl: mediaUrl,
        sourceUrl: persisted.sourceUrl,
        filePath: persisted.filePath,
        thumbnailUrl: mediaUrl,
        output: persisted.sourceUrl,
        status: 'success',
        imageWidth: result.width,
        imageHeight: result.height,
      });
      confirmMediaDelivery();
      if (result.comfyTaskId) completeComfyNodeTask(node.id, result.comfyTaskId);
      ctx.recordOutputHistory(node.id, {
        nodeId: node.id,
        nodeLabel: d.label,
        timestamp: Date.now(),
        prompt,
        output: persisted.sourceUrl,
        nodeType: 'ai-panorama',
        model: d.model!,
        provider: d.provider!,
        status: 'success',
        mediaUrl,
        filePath: persisted.filePath,
        params: { imageSize, aspectRatio },
      });
    } else if (nt === 'ai-video') {
      const videoControls = resolveVideoSubmissionControls({
        provider: d.provider!,
        workflowId: d.workflowId,
        videoResolution: d.videoResolution as number | undefined,
        videoFps: d.videoFps as number | undefined,
        videoFrames: d.videoFrames as number | undefined,
        seedanceResolution: d.seedanceResolution as string | undefined,
        seedanceRatio: d.seedanceRatio as string | undefined,
        seedanceDuration: d.seedanceDuration as number | undefined,
      });
      const videoOptions = {
        prompt,
        model: d.model!,
        provider: d.provider!,
        ...videoControls,
        generateAudio: d.generateAudio as boolean | undefined,
        workflowId: d.workflowId,
        workflowInputs: d.workflowInputs,
        comfyRefmods: d.comfyRefmods,
        nodeId: node.id,
      };
      const result = hasProtectedVideoInputs ? await generateVideo(videoOptions, undefined, async () => {
        if (!isFresh()) throw new Error('项目、视频输入或角色引用已变化，请重新生成');
      }) : await generateVideo(videoOptions);
      taskReceipt = result.taskReceipt;
      if (!isFresh()) {
        if (taskReceipt) pauseMediaTask(taskReceipt, undefined, 'canvas_changed');
        return false;
      }
      if (taskReceipt) ctx.updateNodeDataTransient(node.id, { mediaTaskStage: 'saving' });
      const persisted = getCloudWorkflowPersistedOutput(result.workflowApiOutputs ?? result.runninghubOutputs, result.url) ?? (ctx.currentProjectId
        ? await persistMediaUrlToProjectData(result.url, ctx.currentProjectId, 'ai-video', d.label)
        : { mediaUrl: result.url, sourceUrl: result.url });
      if (!isFresh()) {
        if (taskReceipt) pauseMediaTask(taskReceipt, undefined, 'canvas_changed');
        return false;
      }
      const mediaUrl = persisted.mediaUrl;
      ctx.updateNodeDataTransient(node.id, {
        videoUrl: mediaUrl,
        sourceUrl: persisted.sourceUrl,
        filePath: persisted.filePath,
        thumbnailUrl: mediaUrl,
        output: persisted.sourceUrl,
        status: 'success',
        videoTaskState: undefined,
      });
      confirmMediaDelivery();
      ctx.recordOutputHistory(node.id, {
        nodeId: node.id,
        nodeLabel: d.label,
        timestamp: Date.now(),
        prompt,
        output: persisted.sourceUrl,
        nodeType: 'ai-video',
        model: d.model!,
        provider: d.provider!,
        status: 'success',
        mediaUrl,
        filePath: persisted.filePath,
        params: {
          ...videoControls,
          generateAudio: d.generateAudio,
        },
      });
    } else {
      // ai-audio
      const result = await generateAudio({
        prompt,
        model: d.model!,
        provider: d.provider!,
        audioSpeechSettings: d.audioSpeechSettings,
        audioVoice: d.audioVoice,
        audioFormat: d.audioFormat,
        audioSpeed: d.audioSpeed,
        musicTitle: d.musicTitle,
        musicLyrics: d.musicLyrics,
        musicBpm: d.musicBpm,
        musicDuration: d.musicDuration,
        autoGenerateLyrics: d.autoGenerateLyrics,
        workflowId: d.workflowId,
        workflowInputs: d.workflowInputs,
        nodeId: node.id,
      });
      taskReceipt = result.taskReceipt;
      comfyTaskId = result.comfyTaskId;
      if (comfyTaskId) beginComfyNodeDelivery(node.id, comfyTaskId);
      if (!isFresh()) return false;
      if (taskReceipt) ctx.updateNodeDataTransient(node.id, { mediaTaskStage: 'saving' });
      const persisted = await persistAudioGenerationResult(result, ctx.currentProjectId, d.label);
      if (!isFresh()) return false;
      if (persisted.persistence === 'failed') throw new Error('音频已生成，但保存失败；请继续保存原结果');
      ctx.updateNodeDataTransient(node.id, {
        audioUrl: persisted.mediaUrl,
        sourceUrl: persisted.sourceUrl,
        filePath: persisted.filePath,
        thumbnailUrl: persisted.mediaUrl,
        output: persisted.outputUrl,
        musicClipId: result.clipId,
        ...(result.title ? { musicTitle: result.title } : {}),
        ...(result.lyrics ? { musicLyrics: result.lyrics } : {}),
        status: 'success',
      });
      confirmMediaDelivery();
      if (result.comfyTaskId) completeComfyNodeTask(node.id, result.comfyTaskId);
      ctx.recordOutputHistory(node.id, {
        nodeId: node.id,
        nodeLabel: d.label,
        timestamp: Date.now(),
        prompt,
        output: persisted.outputUrl,
        nodeType: 'ai-audio',
        model: d.model!,
        provider: d.provider!,
        status: 'success',
        mediaUrl: persisted.mediaUrl,
        filePath: persisted.filePath,
        params: {
          audioSpeechSettings: d.audioSpeechSettings,
          audioVoice: d.audioVoice,
          audioFormat: d.audioFormat,
          audioSpeed: d.audioSpeed,
          musicTitle: result.title || d.musicTitle,
          musicBpm: d.musicBpm,
          musicDuration: d.musicDuration,
          autoGenerateLyrics: d.autoGenerateLyrics,
        },
      });
    }
    return true;
  } catch (err) {
    if (isMediaTaskPausedError(err)) return false;
    if (!mediaDelivered && taskReceipt && pauseMediaTask(taskReceipt, err, 'delivery_pending')) return false;
    if (!isFresh()) return false;
    const msg = err instanceof Error ? err.message : typeof err === 'string' && err.trim() ? err : '生成失败';
    ctx.updateNodeDataTransient(node.id, { status: 'error', error: msg });
    ctx.recordOutputHistory(node.id, {
      nodeId: node.id,
      nodeLabel: d.label,
      timestamp: Date.now(),
      prompt,
      output: '',
      nodeType: nt,
      model: d.model!,
      provider: d.provider!,
      status: 'error',
      error: msg,
    });
    return false;
  } finally {
    if (!mediaDelivered && taskReceipt) pauseMediaTask(taskReceipt, undefined, isFresh() ? 'delivery_pending' : 'canvas_changed');
    if (comfyTaskId) pauseComfyNodeDelivery(node.id, comfyTaskId, () => !!animationGuard && isCanvasDerivationFresh(animationGuard, useAppStore.getState()));
    if (animationGuard) completeCanvasDerivation(animationGuard);
    endOperation?.();
  }
}

// ── 过滤可执行节点 ──
function isExecutableNode(node: Node<BaseNodeData>, nodeIdSet: Set<string>): boolean {
  return Boolean(
    nodeIdSet.has(node.id)
      && node.type !== 'group'
      && node.data?.type
      && EXECUTABLE_NODE_TYPES.has(node.data.type as AINodeType)
      && node.data.model
      && node.data.provider
      && (node.data.prompt || '').trim()
      && node.data.status !== 'loading',
  );
}

export function hasBatchExecutableNodes(
  nodeIds: string[],
  nodes: Node<BaseNodeData>[],
): boolean {
  const nodeIdSet = new Set(nodeIds);
  return nodes.some((node) => isExecutableNode(node, nodeIdSet));
}

function filterExecutable(nodeIds: string[], nodes: Node<BaseNodeData>[]): Node<BaseNodeData>[] {
  const nodeIdSet = new Set(nodeIds);
  return nodes.filter((node) => isExecutableNode(node, nodeIdSet));
}

// ── 拓扑排序（先压缩强连通分量，确保环内节点也进入结果）──
function topologicalSort(
  nodeIds: string[],
  edges: { source: string; target: string }[],
): string[] {
  const idSet = new Set(nodeIds);
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
  }
  for (const e of edges) {
    if (idSet.has(e.source) && idSet.has(e.target)) {
      adjacency.get(e.source)!.push(e.target);
    }
  }

  const inputOrder = new Map(nodeIds.map((id, index) => [id, index]));
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (id: string) => {
    indices.set(id, nextIndex);
    lowLinks.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const target of adjacency.get(id) || []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    component.sort((left, right) => inputOrder.get(left)! - inputOrder.get(right)!);
    components.push(component);
  };

  for (const id of nodeIds) {
    if (!indices.has(id)) visit(id);
  }

  const componentByNode = new Map<string, number>();
  const componentRank = components.map((component, componentIndex) => {
    for (const id of component) componentByNode.set(id, componentIndex);
    return Math.min(...component.map((id) => inputOrder.get(id)!));
  });
  const outgoing = components.map(() => new Set<number>());
  const indegree = components.map(() => 0);
  for (const [source, targets] of adjacency) {
    const sourceComponent = componentByNode.get(source)!;
    for (const target of targets) {
      const targetComponent = componentByNode.get(target)!;
      if (
        sourceComponent !== targetComponent
        && !outgoing[sourceComponent].has(targetComponent)
      ) {
        outgoing[sourceComponent].add(targetComponent);
        indegree[targetComponent] += 1;
      }
    }
  }

  const queue = components
    .map((_, index) => index)
    .filter((index) => indegree[index] === 0)
    .sort((left, right) => componentRank[left] - componentRank[right]);
  const order: string[] = [];
  while (queue.length > 0) {
    const componentIndex = queue.shift()!;
    order.push(...components[componentIndex]);
    for (const targetComponent of outgoing[componentIndex]) {
      indegree[targetComponent] -= 1;
      if (indegree[targetComponent] === 0) {
        queue.push(targetComponent);
        queue.sort((left, right) => componentRank[left] - componentRank[right]);
      }
    }
  }

  return order;
}

// ── 主入口 ──
export async function batchExecuteNodes(
  nodeIds: string[],
  nodes: Node<BaseNodeData>[],
  edges: Edge[],
  ctx: BatchContext,
): Promise<{ ok: number; fail: number }> {
  const executable = filterExecutable(nodeIds, nodes);
  // 使用用户看到的 #编号，而非随机内部 ID。未编号节点稳定地排在最后。
  const workflows = executable.filter((node) => node.data.workflowId).sort((a, b) => (
    (a.data.displayId ?? Number.MAX_SAFE_INTEGER) - (b.data.displayId ?? Number.MAX_SAFE_INTEGER)
  ));
  let workflowIndex = 0;
  // 只重排工作流所占的位置，保留普通节点原顺序；环内也按此顺序执行。
  const toRun = executable.map((node) => node.data.workflowId ? workflows[workflowIndex++] : node);
  if (toRun.length === 0) return { ok: 0, fail: 0 };
  ctx.commitToHistory();
  const { useAppStore } = await import('../store/useAppStore');

  // 仅在调度图添加串行约束，不修改画布连线。复用现有依赖排序，避免
  // 将工作流拆出独立队列后，与其普通上游/下游节点同时执行。
  const schedulingEdges: { source: string; target: string }[] = [...edges];
  for (let index = 1; index < workflows.length; index++) {
    schedulingEdges.push({ source: workflows[index - 1].id, target: workflows[index].id });
  }

  // Identify which nodes have edges between them
  const executableIds = new Set(toRun.map((node) => node.id));
  const connectedIds = new Set<string>();
  for (const e of schedulingEdges) {
    if (executableIds.has(e.source) && executableIds.has(e.target)) {
      connectedIds.add(e.source);
      connectedIds.add(e.target);
    }
  }

  // Split: connected vs isolated
  const connectedNodes = toRun.filter((n) => connectedIds.has(n.id));
  const isolatedNodes = toRun.filter((n) => !connectedIds.has(n.id));

  // Topological sort for connected nodes
  const order = topologicalSort(
    connectedNodes.map((n) => n.id),
    schedulingEdges,
  );
  const orderedConnected = order
    .map((id) => connectedNodes.find((n) => n.id === id))
    .filter(Boolean) as Node<BaseNodeData>[];

  let ok = 0,
    fail = 0;

  const runConnected = async () => {
    for (const node of orderedConnected) {
      const success = await executeOneNode(node, ctx, useAppStore);
      if (success) ok++;
      else fail++;
    }
  };

  const runIsolated = async () => {
    const results = await Promise.all(isolatedNodes.map((n) => executeOneNode(n, ctx, useAppStore)));
    for (const r of results) {
      if (r) ok++;
      else fail++;
    }
  };

  // Run connected (sequential) and isolated (parallel) concurrently
  await Promise.all([runConnected(), runIsolated()]);

  return { ok, fail };
}
