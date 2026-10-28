/** Manual video submission guard. It never starts, replaces or writes a task. */
import { t } from '../i18n';
import { useAppStore } from '../store/useAppStore';
import { resolveGenerationNodeData } from '../utils/nodeGeneration';
import { buildGenerationCameraPrompt } from '../components/nodes/shared/image/cameraStudio';
import { confirmAction } from './confirmDialog';
import { hasVideoReferenceContent } from './ai/generateVideo';
import { resolveVideoSubmissionControls } from './ai/videoRequestResolver';
import { parseProjectModelRef, resolveProjectGenerationPrompt } from './projectSettingsService';
import { videoInputFingerprint } from './videoBatchPlanning';
import { expandShotlistRowMentions } from './shotlistPromptService';
import { isCloudWorkflow } from './workflowExecutionService';

const pendingConfirmations = new Set<string>();

/** Only a human-facing submit button calls this; Agent, batches and recovery keep their policies. */
export async function confirmVideoReferencesBeforeGeneration(nodeId: string, overridePrompt?: string): Promise<boolean> {
  const initial = useAppStore.getState();
  const originalNode = initial.nodes.find((node) => node.id === nodeId);
  const data = resolveGenerationNodeData(originalNode?.data);
  if (!originalNode || !data || data.type !== 'ai-video') return true;
  const settings = initial.projects.find((project) => project.id === initial.currentProjectId)?.settings;
  const projectModel = parseProjectModelRef(settings?.defaultModels?.video);
  const parsedModel = parseProjectModelRef(data.model);
  const model = data.model || projectModel?.model;
  const provider = data.model ? data.provider || parsedModel?.provider : projectModel?.provider || data.provider;
  const workflowId = data.workflowId || (!data.model ? projectModel?.workflowId : undefined);
  const workflow = initial.workflows.find((item) => item.id === workflowId);
  const rawPrompt = overridePrompt ?? data.prompt ?? '';
  // Leave existing validation in charge; do not ask to confirm an invalid request.
  if ((data.model === '' && !data.workflowId) || !model || !provider
    || (!rawPrompt.trim() && !isCloudWorkflow(workflow) && provider !== 'runninghub')
    || (workflowId && !workflow)) return true;
  if (!initial.currentProjectId || initial.projectLoadStatus !== 'ready'
    || initial.isCreatingProject || initial.isReturningToStartPage || initial.switchingProjectName !== null) return false;

  const key = JSON.stringify([initial.currentProjectId, nodeId]);
  if (pendingConfirmations.has(key)) return false;
  pendingConfirmations.add(key);
  const revision = initial.getCurrentRevision();
  let navigated = false;
  const navigation = (state: ReturnType<typeof useAppStore.getState>) => [
    state.currentProjectId, state.activeNodeId, state.projectLoadStatus, state.isCreatingProject,
    state.isReturningToStartPage, state.switchingProjectName,
  ];
  let previousNavigation = navigation(initial);
  const unsubscribe = useAppStore.subscribe((state) => {
    const next = navigation(state);
    if (next.some((value, index) => value !== previousNavigation[index])) navigated = true;
    previousNavigation = next;
  });
  const baseIsFresh = () => {
    const current = useAppStore.getState();
    return !navigated && current.currentProjectId === initial.currentProjectId
      && current.activeNodeId === initial.activeNodeId
      && current.projectLoadStatus === 'ready' && current.getCurrentRevision() === revision
      && current.nodes.find((node) => node.id === nodeId)?.data === originalNode.data
      && current.config === initial.config && current.customStyles === initial.customStyles
      && current.projects.find((project) => project.id === initial.currentProjectId)?.settings === settings
      && current.workflows.find((item) => item.id === workflowId) === workflow;
  };
  const stale = () => {
    useAppStore.getState().showToast(t('画布或生成输入已变化，请重新生成'), 'info');
    return false;
  };
  try {
    const controls = resolveVideoSubmissionControls({ ...data, provider, workflowId });
    let prompt = resolveProjectGenerationPrompt({ prompt: rawPrompt, data, settings, customStyles: initial.customStyles });
    const camera = buildGenerationCameraPrompt(data.cameraSettings);
    if (camera) prompt += `\n\nCamera settings: ${camera}.`;
    prompt = expandShotlistRowMentions(prompt, initial.nodes, { durationSeconds: controls.seedanceDuration });
    // Load cold global cards before capturing their reference fingerprint. This
    // mirrors executeGeneration and does not upload any media.
    if (`${prompt}\n${JSON.stringify(data.workflowInputs ?? {})}`.includes('@drama{global/')) {
      await initial.loadGlobalDramaAssets();
      if (!baseIsFresh()) return stale();
    }
    const fingerprintState = useAppStore.getState();
    const fingerprintNode = { ...originalNode, data: { ...data, prompt: rawPrompt } };
    const fingerprint = videoInputFingerprint(fingerprintNode, fingerprintState);
    const isFresh = () => baseIsFresh()
      && videoInputFingerprint(fingerprintNode, useAppStore.getState()) === fingerprint;
    const hasReferences = await hasVideoReferenceContent({
      prompt, model, provider, nodeId, workflowId, workflowInputs: data.workflowInputs,
      ...controls, generateAudio: data.generateAudio, comfyRefmods: data.comfyRefmods,
      comfyH3MemoryPreset: data.comfyH3MemoryPreset, runninghubModelParameters: data.runninghubModelParameters,
    });
    if (!isFresh()) return stale();
    if (hasReferences) return true;
    const confirmed = await confirmAction('未添加参考素材，将仅根据提示词生成视频，是否继续？', {
      title: '未添加参考素材', okLabel: '继续生成', cancelLabel: '返回添加参考',
    });
    if (!confirmed) return false;
    return isFresh() ? true : stale();
  } finally {
    unsubscribe();
    pendingConfirmations.delete(key);
  }
}
