/**
 * 构建高级预设步骤，按顺序或参考依赖并发执行派生节点的模型任务。
 */
import type { Edge, Node } from '@xyflow/react';
import type {
  BaseNodeData,
  NodeType,
  PresetNodeType,
  PresetParameterValue,
  UserPreset,
} from '../types';
import { generateId } from '../store/store.utils';
import { useAppStore } from '../store/useAppStore';
import { executeGeneration } from './generationService';
import {
  MAX_PRESET_CONCURRENCY,
  composeStepPrompt,
  validatePresetAdvancedConfig,
  validatePresetParameterValues,
  type PresetParameterValues,
} from './presetTemplateService';

const DEFAULT_DIMENSIONS: Record<PresetNodeType, { width: number; height: number }> = {
  'ai-text': { width: 280, height: 160 },
  'ai-image': { width: 280, height: 158 },
  'ai-video': { width: 280, height: 160 },
  'ai-audio': { width: 260, height: 140 },
};

const HORIZONTAL_GAP = 80;

export interface PresetSequencePlan {
  nodes: Node<BaseNodeData>[];
  edges: Edge[];
}

export interface PresetSequenceRunResult {
  success: boolean;
  completedSteps: number;
  failedStepIndex?: number;
  message?: string;
}

interface BuildPresetSequencePlanOptions {
  preset: UserPreset;
  sourceNode: Node<BaseNodeData>;
  values: PresetParameterValues;
}

interface RunPresetSequenceOptions {
  preset: UserPreset;
  sourceNodeId: string;
  values: Record<string, PresetParameterValue>;
}

export function isAdvancedPreset(preset: UserPreset | undefined): boolean {
  return preset?.mode === 'advanced' && !!preset.advanced;
}

export function requestPresetSequence(
  presetId: string,
  nodeType: NodeType,
  sourceNodeId: string,
  presets: UserPreset[],
): boolean {
  const preset = presets.find((item) => item.id === presetId && item.nodeType === nodeType);
  if (!isAdvancedPreset(preset)) return false;
  useAppStore.getState().setPresetRunRequest({ presetId, sourceNodeId });
  return true;
}

function computeNodeDimensions(
  nodeType: PresetNodeType,
  aspectRatio?: string,
): { nodeWidth: number; nodeHeight: number } {
  const fallback = DEFAULT_DIMENSIONS[nodeType];
  if (!aspectRatio) return { nodeWidth: fallback.width, nodeHeight: fallback.height };

  const [widthPart, heightPart] = aspectRatio.split(':');
  const width = Number(widthPart);
  const height = Number(heightPart);
  if (!width || !height) return { nodeWidth: fallback.width, nodeHeight: fallback.height };

  const maxDimension = 280;
  if (width >= height) {
    return {
      nodeWidth: maxDimension,
      nodeHeight: Math.max(120, Math.round(maxDimension * (height / width))),
    };
  }
  return {
    nodeWidth: Math.max(160, Math.round(maxDimension * (width / height))),
    nodeHeight: maxDimension,
  };
}

export function buildPresetSequencePlan({
  preset,
  sourceNode,
  values,
}: BuildPresetSequencePlanOptions): PresetSequencePlan {
  if (!isAdvancedPreset(preset) || !preset.advanced) {
    throw new Error('快捷指令不是有效的高级指令');
  }

  const nodes: Node<BaseNodeData>[] = [];
  const edges: Edge[] = [];
  const currentPrompt = String(sourceNode.data.prompt ?? '');
  let previousNode = sourceNode;
  let nextX = sourceNode.position.x
    + (Number(sourceNode.data.nodeWidth) || DEFAULT_DIMENSIONS[preset.nodeType].width)
    + HORIZONTAL_GAP;

  for (const step of preset.advanced.steps) {
    const nodeId = 'node-' + generateId();
    const label = step.name.trim();
    const referenceNode = step.referenceSource === 'source' ? sourceNode : previousNode;
    const referenceLabel = referenceNode.data.label || referenceNode.data.fileName || referenceNode.id;
    const mention = '@{' + referenceNode.id + ':' + referenceLabel + '}';
    const prompt = composeStepPrompt(step.promptTemplate, values, currentPrompt, mention);
    const dimensions = computeNodeDimensions(step.nodeType, step.aspectRatio);
    const canInheritModel = previousNode.data.type === step.nodeType;
    const provider = step.provider || (canInheritModel ? previousNode.data.provider : undefined);

    const data: BaseNodeData = {
      type: step.nodeType,
      label,
      prompt,
      role: 'generator',
      status: 'idle',
      model: step.model || (canInheritModel ? previousNode.data.model : undefined),
      provider,
      // ComfyUI 靠 workflowId 走本地执行路径，只带 provider 会在生成时找不到工作流（同 createPresetNode）
      ...(provider === 'comfyui' && (step.workflowId || sourceNode.data.workflowId)
        ? { workflowId: step.workflowId || sourceNode.data.workflowId }
        : {}),
      imageSize: step.imageSize || (canInheritModel ? previousNode.data.imageSize : undefined),
      aspectRatio: step.aspectRatio || (canInheritModel ? previousNode.data.aspectRatio : undefined),
      ...dimensions,
    };
    const node: Node<BaseNodeData> = {
      id: nodeId,
      type: step.nodeType,
      position: { x: nextX, y: sourceNode.position.y },
      // 源节点在分组内时 position 是相对父节点的，不带 parentId 会被当成绝对坐标画到组外
      ...(sourceNode.parentId ? { parentId: sourceNode.parentId } : {}),
      data,
    };
    nodes.push(node);
    edges.push({
      id: 'edge-' + generateId(),
      source: referenceNode.id,
      target: nodeId,
      sourceHandle: 'right',
      targetHandle: 'left',
    });

    nextX += dimensions.nodeWidth + HORIZONTAL_GAP;
    previousNode = node;
  }

  return { nodes, edges };
}

export async function runPresetSequence({
  preset,
  sourceNodeId,
  values,
}: RunPresetSequenceOptions): Promise<PresetSequenceRunResult> {
  const initialStore = useAppStore.getState();
  const sourceNode = initialStore.nodes.find((node) => node.id === sourceNodeId) as Node<BaseNodeData> | undefined;
  if (!sourceNode) return { success: false, completedSteps: 0, message: '触发节点不存在' };
  if (!isAdvancedPreset(preset) || !preset.advanced) {
    return { success: false, completedSteps: 0, message: '高级快捷指令配置无效' };
  }

  const configErrors = validatePresetAdvancedConfig(preset.advanced);
  const valueErrors = validatePresetParameterValues(preset.advanced.parameters, values);
  const firstError = [...configErrors, ...valueErrors][0];
  if (firstError) return { success: false, completedSteps: 0, message: firstError };

  const projectId = initialStore.currentProjectId;
  const plan = buildPresetSequencePlan({ preset, sourceNode, values });
  initialStore.addNodesWithEdges(plan.nodes, plan.edges);
  initialStore.showToast('已启动“' + preset.name + '”，共 ' + plan.nodes.length + ' 个步骤');

  const parallel = preset.advanced.executionMode === 'parallel';
  const concurrency = parallel ? MAX_PRESET_CONCURRENCY : 1;
  const pending = new Set(plan.nodes.map((_, index) => index));
  const completed = new Set<number>();
  const running = new Map<number, Promise<number>>();
  let failure: { index: number; message: string } | undefined;

  const executeStep = async (index: number): Promise<number> => {
    try {
      const result = await executeGeneration(plan.nodes[index].id);
      const liveStore = useAppStore.getState();
      if (liveStore.currentProjectId !== projectId || !liveStore.nodes.some((node) => node.id === plan.nodes[index].id)) {
        failure ??= { index, message: '项目已切换或执行节点已被移除' };
      } else if (result.success) {
        completed.add(index);
      } else {
        failure ??= { index, message: result.message || '步骤 ' + (index + 1) + ' 执行失败' };
      }
    } catch (error) {
      failure ??= { index, message: error instanceof Error ? error.message : '步骤 ' + (index + 1) + ' 执行失败' };
    }
    return index;
  };

  while (pending.size > 0 || running.size > 0) {
    for (const index of pending) {
      if (failure || running.size >= concurrency) break;
      const liveStore = useAppStore.getState();
      if (
        liveStore.currentProjectId !== projectId
        || !liveStore.nodes.some((node) => node.id === plan.nodes[index].id)
        || !liveStore.nodes.some((node) => node.id === plan.edges[index].source)
      ) {
        failure = { index, message: '项目已切换或执行节点或参考节点已被移除' };
        break;
      }
      const needsPrevious = index > 0 && (!parallel || preset.advanced.steps[index].referenceSource !== 'source');
      if (needsPrevious && !completed.has(index - 1)) continue;
      pending.delete(index);
      running.set(index, executeStep(index));
    }
    if (running.size === 0) break;
    running.delete(await Promise.race(running.values()));
  }

  if (failure) {
    useAppStore.getState().showToast(
      '“' + preset.name + '”已停在步骤 ' + (failure.index + 1) + '：' + failure.message,
      'error',
    );
    return { success: false, completedSteps: completed.size, failedStepIndex: failure.index, message: failure.message };
  }

  useAppStore.getState().showToast('“' + preset.name + '”已完成');
  return { success: true, completedSteps: completed.size };
}
