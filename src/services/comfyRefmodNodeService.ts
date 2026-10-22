import { useAppStore } from '../store/useAppStore';
import type { ComfyRefmodBindingResolver, ComfyRefmodSelection } from '../types/comfyRefmod';
import { comfyRefmodKey, normalizeCharacterRefmods, normalizeComfyRefmodSelections } from '../utils/comfyRefmod';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from './canvasDerivationGuard';
import { isCloudWorkflow } from './workflowExecutionService';
import { mergeComfyRefmodSelections, resolveComfyRefmodMentionInputs } from '../utils/comfyRefmodMention';

/** 资源库和 DOM 拖入共用的写入入口；异步分配只写回原项目及原工作流节点。 */
export async function appendRefmodsToVideoNode(
  nodeId: string,
  incoming: ComfyRefmodSelection[],
  expectedProjectId?: string | null,
  resolveMapping?: ComfyRefmodBindingResolver,
): Promise<void> {
  const state = useAppStore.getState();
  if (expectedProjectId !== undefined && state.currentProjectId !== expectedProjectId) throw new Error('项目已切换，请重新选择视频节点');
  const node = state.nodes.find((item) => item.id === nodeId);
  const workflow = state.workflows.find((item) => item.id === node?.data.workflowId);
  if (node?.type !== 'ai-video' || node.data.role === 'source' || !workflow || isCloudWorkflow(workflow) || node.data.provider !== 'comfyui') {
    throw new Error('请先为视频节点选择包含 RefMod 加载器的本地 ComfyUI 工作流');
  }
  if (node.data.status === 'loading') throw new Error('视频正在生成，请等待结束后再更改角色参考包');
  const normalized = normalizeComfyRefmodSelections(incoming);
  if (!incoming.length || incoming.length > 16 || normalized.length !== incoming.length) throw new Error('参考包引用无效，请从资源库重新选择');
  const references = normalizeCharacterRefmods(normalized);
  const existing = resolveComfyRefmodMentionInputs({ prompt: node.data.prompt ?? '', workflowInputs: node.data.workflowInputs, manual: node.data.comfyRefmods }).comfyRefmods;
  const guard = registerCanvasDerivation(state, nodeId);
  if (!guard) throw new Error('当前项目或节点不可用，请重新打开后添加');
  const snapshot = (data: typeof node.data) => JSON.stringify([data.workflowId, data.provider, data.model, data.comfyRefmods, data.prompt, data.workflowInputs]);
  const before = snapshot(node.data);
  const assertCurrent = () => {
    const latest = useAppStore.getState();
    const target = latest.nodes.find((item) => item.id === nodeId);
    if (!isCanvasDerivationFresh(guard, latest) || !target || target.data.status === 'loading'
      || before !== snapshot(target.data) || latest.workflows.find((item) => item.id === workflow.id) !== workflow) {
      throw new Error('画布或工作流已变化，请重新添加参考包');
    }
    return latest;
  };
  try {
    const { prepareComfyRefmodSelections, ComfyRefmodMappingRequiredError } = await import('./comfyRefmodWorkflow');
    let mapped = references;
    let selections: ComfyRefmodSelection[];
    try { selections = await prepareComfyRefmodSelections(workflow, mapped, existing); }
    catch (cause) {
      if (!(cause instanceof ComfyRefmodMappingRequiredError) || !resolveMapping) throw cause;
      assertCurrent();
      mapped = await resolveMapping({ workflow, incoming: references, existing });
      assertCurrent();
      if (mapped.length !== references.length || mapped.some((item, index) => comfyRefmodKey(item) !== comfyRefmodKey(references[index]))) {
        throw new Error('参考包映射已变化，请重新添加', { cause });
      }
      mergeComfyRefmodSelections(existing, mapped);
      selections = await prepareComfyRefmodSelections(workflow, mapped, existing);
    }
    // 提示词已有的胶囊只参与占槽校验，不被悄悄转换成手工绑定。
    mergeComfyRefmodSelections(existing, selections);
    const slotKey = (item: ComfyRefmodSelection) => JSON.stringify([item.loaderNodeId, item.slot]);
    const keep = new Set((node.data.comfyRefmods ?? []).map(slotKey));
    for (const item of mapped) {
      const resolved = selections.find((candidate) => comfyRefmodKey(candidate) === comfyRefmodKey(item)
        && (item.loaderNodeId === undefined || candidate.loaderNodeId === item.loaderNodeId)
        && (item.slot === undefined || candidate.slot === item.slot));
      if (resolved) keep.add(slotKey(resolved));
    }
    selections = selections.filter((item) => keep.has(slotKey(item)));
    const latest = assertCurrent();
    latest.updateNodeData(nodeId, { comfyRefmods: selections });
  } finally {
    completeCanvasDerivation(guard);
  }
}
