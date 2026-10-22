import { useAppStore } from '../store/useAppStore';
import type { ComfyRefmodSelection } from '../types/comfyRefmod';
import { normalizeCharacterRefmods, normalizeComfyRefmodSelections } from '../utils/comfyRefmod';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from './canvasDerivationGuard';
import { isCloudWorkflow } from './workflowExecutionService';

/** 资源库和 DOM 拖入共用的写入入口；异步分配只写回原项目及原工作流节点。 */
export async function appendRefmodsToVideoNode(
  nodeId: string,
  incoming: ComfyRefmodSelection[],
  expectedProjectId?: string | null,
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
  const guard = registerCanvasDerivation(state, nodeId);
  if (!guard) throw new Error('当前项目或节点不可用，请重新打开后添加');
  const before = JSON.stringify([node.data.workflowId, node.data.provider, node.data.model, node.data.comfyRefmods]);
  try {
    const { prepareComfyRefmodSelections } = await import('./comfyRefmodWorkflow');
    const selections = await prepareComfyRefmodSelections(workflow, references, node.data.comfyRefmods);
    const latest = useAppStore.getState();
    const target = latest.nodes.find((item) => item.id === nodeId);
    const currentWorkflow = latest.workflows.find((item) => item.id === workflow.id);
    if (!isCanvasDerivationFresh(guard, latest) || !target || target.data.status === 'loading'
      || before !== JSON.stringify([target.data.workflowId, target.data.provider, target.data.model, target.data.comfyRefmods])
      || currentWorkflow !== workflow) throw new Error('画布或工作流已变化，请重新添加参考包');
    latest.updateNodeData(nodeId, { comfyRefmods: selections });
  } finally {
    completeCanvasDerivation(guard);
  }
}
