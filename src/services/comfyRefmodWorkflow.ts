import type { WorkflowDefinition } from '../types';
import type { ComfyRefmodCatalog, ComfyRefmodLoaderType, ComfyRefmodSelection, ComfyRefmodSlotSchema } from '../types/comfyRefmod';
import { loadComfyRefmodCatalog, resolveComfyRefmodServerIdentity } from './comfyRefmodService';
import { isComfyRefmodFileName } from '../utils/comfyRefmod';
import { useAppStore } from '../store/useAppStore';
import { resolveComfyServerSelection } from './comfyServers';

export const MAX_COMFY_REFMOD_SELECTIONS = 100;

type WorkflowGraph = Record<string, Record<string, unknown>>;

export interface ComfyRefmodWorkflowLoader {
  nodeId: string;
  classType: string;
  loaderType: ComfyRefmodLoaderType;
  label: string;
  inputs: Record<string, unknown>;
  slots: ComfyRefmodSlotSchema[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkflow(workflow: WorkflowDefinition): WorkflowGraph {
  let value: unknown;
  try { value = JSON.parse(workflow.fileContent); } catch { throw new Error('工作流 JSON 解析失败'); }
  if (!record(value)) throw new Error('RefMod 需要 ComfyUI API 格式的工作流');
  return value as WorkflowGraph;
}

/** 只识别已有的加载节点，不创建节点或更改任何连线。 */
export function getComfyRefmodLoaders(
  workflow: WorkflowDefinition,
  catalog: ComfyRefmodCatalog,
  graph = parseWorkflow(workflow),
): ComfyRefmodWorkflowLoader[] {
  return Object.entries(graph).flatMap(([nodeId, node]) => {
    if (!record(node) || typeof node.class_type !== 'string') return [];
    const schema = catalog.loaders.find((item) => item.classType === node.class_type);
    if (!schema || !record(node.inputs)) return [];
    const title = record(node._meta) && typeof node._meta.title === 'string' ? node._meta.title : schema.label;
    return [{ nodeId, classType: node.class_type, loaderType: schema.loaderType, label: `${title} · #${nodeId}`, inputs: node.inputs, slots: schema.slots }];
  });
}

export function isComfyRefmodSlotLinked(loader: ComfyRefmodWorkflowLoader, slot: ComfyRefmodSlotSchema): boolean {
  return [slot.fileField, slot.strengthField, ...(slot.additionalStrengthFields ?? [])]
    .some((field) => field !== undefined && Array.isArray(loader.inputs[field]));
}

export function isComfyRefmodSlotEmpty(loader: ComfyRefmodWorkflowLoader, slot: ComfyRefmodSlotSchema): boolean {
  const value = loader.inputs[slot.fileField];
  return slot.emptyNames.includes(String(value)) || (value === undefined && slot.emptyNames.length > 0);
}

function sameFile(left: ComfyRefmodSelection, right: ComfyRefmodSelection): boolean {
  return left.serverId === right.serverId && left.endpointFingerprint === right.endpointFingerprint
    && left.loaderType === right.loaderType && left.fileName === right.fileName;
}

function assertFileName(fileName: unknown): asserts fileName is string {
  if (!isComfyRefmodFileName(fileName)) {
    throw new Error('RefMod 文件名无效，请从模型资源中重新选择');
  }
}

function resolveSelections(workflow: WorkflowDefinition, graph: WorkflowGraph, selections: ComfyRefmodSelection[], catalog: ComfyRefmodCatalog): ComfyRefmodSelection[] {
  if ((workflow.adapterType && workflow.adapterType !== 'comfyui') || selections.length > MAX_COMFY_REFMOD_SELECTIONS) {
    throw new Error(`RefMod 仅支持本地 ComfyUI 工作流，每个节点最多选择 ${MAX_COMFY_REFMOD_SELECTIONS} 个`);
  }
  const loaders = getComfyRefmodLoaders(workflow, catalog, graph);
  const occupied = new Set<string>();
  return selections.map((selection) => {
    assertFileName(selection.fileName);
    if (catalog.failedLoaderTypes?.includes(selection.loaderType)) {
      throw new Error('RefMod 目录尚未验证，请检查服务器或插件后刷新目录；现有引用已保留');
    }
    if (selection.serverId !== workflow.serverId || selection.serverId !== catalog.serverId
      || selection.endpointFingerprint !== catalog.endpointFingerprint) {
      throw new Error('RefMod 所属服务器已改变，请在当前工作流服务器重新选择模型');
    }
    if (!Number.isFinite(selection.strength) || selection.strength < 0 || selection.strength > 10) {
      throw new Error('RefMod 强度必须符合目标插件的参数范围');
    }
    const candidates = loaders.filter((loader) => loader.loaderType === selection.loaderType
      && (selection.loaderNodeId === undefined || loader.nodeId === selection.loaderNodeId));
    if (candidates.length !== 1) throw new Error(candidates.length
      ? '工作流有多个 RefMod 加载节点，请在参数中明确选择目标节点和槽位'
      : '工作流缺少对应的 RefMod 加载节点，或目标插件未安装，请先在 ComfyUI 中配置并连接加载节点');
    const loader = candidates[0];
    if (selection.replaceExisting && (selection.loaderNodeId === undefined || selection.slot === undefined)) {
      throw new Error('替换原 RefMod 需要明确选择目标加载节点与槽位');
    }
    const available = loader.slots.filter((item) => !occupied.has(`${loader.nodeId}:${item.slot}`) && !isComfyRefmodSlotLinked(loader, item));
    const slot = selection.slot === undefined
      ? available.find((item) => loader.inputs[item.fileField] === selection.fileName)
        ?? available.find((item) => isComfyRefmodSlotEmpty(loader, item))
      : loader.slots.find((item) => item.slot === selection.slot);
    if (!slot) throw new Error('没有可用的 RefMod 槽位，请在参数中选择具体槽位后明确替换原值');
    const key = `${loader.nodeId}:${slot.slot}`;
    if (occupied.has(key)) throw new Error('多个 RefMod 不能写入同一个槽位，请重新分配');
    occupied.add(key);
    if (isComfyRefmodSlotLinked(loader, slot)) throw new Error('RefMod 槽位由上游节点连线控制，请在 ComfyUI 中修改，画布不会覆盖连线');
    const original = loader.inputs[slot.fileField];
    if (original !== undefined && typeof original !== 'string') throw new Error('RefMod 原槽位值不是文件名，请在 ComfyUI 中检查');
    const originalFileName = typeof original === 'string' ? original : '';
    if (selection.loaderNodeId !== undefined && selection.slot !== undefined
      && (selection.workflowId !== workflow.id || selection.originalFileName !== originalFileName)) {
      throw new Error('RefMod 原工作流或槽位内容已变化，请重新选择参考包');
    }
    if (!slot.allowedNames.includes(selection.fileName)) throw new Error('目标 ComfyUI 中未找到这个 RefMod，请刷新模型目录并重新选择');
    if (!selection.replaceExisting && !isComfyRefmodSlotEmpty(loader, slot) && loader.inputs[slot.fileField] !== selection.fileName) {
      throw new Error('RefMod 槽位已有其他模型，请在参数中明确选择该槽位再替换');
    }
    if (slot.strengthField) {
      if ((slot.strengthMin !== undefined && selection.strength < slot.strengthMin)
        || (slot.strengthMax !== undefined && selection.strength > slot.strengthMax)) throw new Error('RefMod 强度不符合目标插件的参数范围');
      for (const field of [slot.strengthField, ...(slot.additionalStrengthFields ?? [])]) {
        if (loader.inputs[field] !== undefined && typeof loader.inputs[field] !== 'number') {
          throw new Error('RefMod 强度由其他输入控制，请在 ComfyUI 中检查后重新选择');
        }
      }
    }
    return { ...selection, loaderNodeId: loader.nodeId, slot: slot.slot, workflowId: workflow.id, originalFileName };
  });
}

async function freshCatalog(workflow: WorkflowDefinition, signal?: AbortSignal): Promise<ComfyRefmodCatalog> {
  const catalog = await loadComfyRefmodCatalog(workflow.serverId, { signal, fresh: true });
  const identity = await resolveComfyRefmodServerIdentity(workflow.serverId);
  if (catalog.endpointFingerprint !== identity.endpointFingerprint) throw new Error('读取 RefMod 期间服务器配置已改变，请重新选择');
  signal?.throwIfAborted();
  return catalog;
}

/** 最终同步检查点也复核目标；此处不可添加 await。 */
export function assertComfyRefmodSubmissionTargetFresh(workflow: WorkflowDefinition, baseUrl: string): void {
  const current = useAppStore.getState().workflows.find((item) => item.id === workflow.id);
  if (!current || current !== workflow || current.serverId !== workflow.serverId || current.fileContent !== workflow.fileContent
    || (current.adapterType && current.adapterType !== 'comfyui')
    || resolveComfyServerSelection(workflow.serverId).baseUrl !== baseUrl) {
    throw new Error('工作流或 ComfyUI 服务器已变化，请重新选择 RefMod 后生成');
  }
}

/** 上传期间切换服务器后，不将旧绑定提交到变更后的配置。 */
export async function assertComfyRefmodSubmissionFresh(workflow: WorkflowDefinition, selections: ComfyRefmodSelection[], baseUrl: string): Promise<void> {
  assertComfyRefmodSubmissionTargetFresh(workflow, baseUrl);
  const identity = await resolveComfyRefmodServerIdentity(workflow.serverId);
  if (selections.some((selection) => selection.serverId !== workflow.serverId || selection.endpointFingerprint !== identity.endpointFingerprint)) {
    throw new Error('RefMod 所属服务器已改变，请重新选择模型');
  }
  assertComfyRefmodSubmissionTargetFresh(workflow, baseUrl);
}

/** 自动应用只占用空槽；明确的槽位选择可以替换原值，仍不覆盖连线。 */
export async function prepareComfyRefmodSelections(
  workflow: WorkflowDefinition,
  incoming: ComfyRefmodSelection[],
  existing: ComfyRefmodSelection[] = [],
): Promise<ComfyRefmodSelection[]> {
  const catalog = await freshCatalog(workflow);
  const merged = [...existing];
  for (const item of incoming) {
    const exactSlot = item.loaderNodeId !== undefined && item.slot !== undefined;
    const index = merged.findIndex((current) => exactSlot
      ? current.loaderNodeId === item.loaderNodeId && current.slot === item.slot
      : sameFile(current, item) && (item.loaderNodeId === undefined || current.loaderNodeId === item.loaderNodeId));
    if (index >= 0) {
      if (exactSlot) merged[index] = item;
    } else merged.push(item);
  }
  return resolveSelections(workflow, parseWorkflow(workflow), merged, catalog);
}

/** 生成前重读服务目录，只修改执行副本，不写回工作流定义。 */
export async function applyComfyRefmodsToWorkflow(
  workflow: WorkflowDefinition,
  graph: WorkflowGraph,
  selections: ComfyRefmodSelection[] | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!selections?.length) return;
  const catalog = await freshCatalog(workflow, signal);
  const resolved = resolveSelections(workflow, graph, selections, catalog);
  const loaders = getComfyRefmodLoaders(workflow, catalog, graph);
  for (const selection of resolved) {
    const loader = loaders.find((item) => item.nodeId === selection.loaderNodeId)!;
    const slot = loader.slots.find((item) => item.slot === selection.slot)!;
    loader.inputs[slot.fileField] = selection.fileName;
    for (const field of [slot.strengthField, ...(slot.additionalStrengthFields ?? [])]) {
      if (field) loader.inputs[field] = selection.strength;
    }
  }
}
