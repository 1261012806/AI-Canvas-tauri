import type { BaseNodeData, WorkflowDefinition } from '../../types';
import type { AudioSpeechReference, AudioSpeechSettings, AudioSpeechWorkflowControls } from '../../types/aiTypes';
import type { DramaAsset, DramaAssetLibrary } from '../../types/dramaAssets';
import { parseDramaMentionId } from '../../types/dramaAssets';
import { findDramaAsset, resolveDramaVoiceRef } from '../dramaAssetPrompt';
import { applyQwenSpeechSettings, inspectQwenSpeechGraph } from './qwenSpeechSettings';

export const AUDIO_SPEECH_VOICES = [
  { value: 'male', label: '男声', description: 'A clear adult male voice' },
  { value: 'female', label: '女声', description: 'A warm, clear adult female voice' },
  { value: 'shota', label: '正太', description: 'A youthful, bright anime-style boy voice' },
  { value: 'loli', label: '萝莉', description: 'A youthful, high-pitched anime-style girl voice' },
  { value: 'girl', label: '小女孩', description: 'A natural young girl voice' },
  { value: 'boy', label: '小男孩', description: 'A natural young boy voice' },
] as const;
export const AUDIO_SPEECH_PACES = [
  { label: '很慢', instruction: 'Speak very slowly and clearly.' },
  { label: '偏慢', instruction: 'Speak at a slightly slower pace.' },
  { label: '正常', instruction: 'Speak at a natural, normal pace.' },
  { label: '偏快', instruction: 'Speak at a slightly faster pace.' },
  { label: '很快', instruction: 'Speak quickly while remaining clear.' },
] as const;

type Graph = Record<string, Record<string, unknown>>;
type SpeechNode = { id: string; data: BaseNodeData };
const workflowChip = () => /@wf\{([^|]+)\|([^|]+)\|([^|}]+)\}\(([\s\S]*?)\)/g;
const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value!))) : fallback;

export function normalizeAudioSpeechSettings(settings?: AudioSpeechSettings, duration = 3): Required<Pick<AudioSpeechSettings, 'voiceStyle' | 'pace' | 'duration'>> {
  return {
    voiceStyle: AUDIO_SPEECH_VOICES.find((voice) => voice.value === settings?.voiceStyle)?.value ?? 'female',
    pace: bounded(settings?.pace, 2, 0, 4),
    duration: bounded(settings?.duration, bounded(duration, 3, 1, 3600), 1, 3600),
  };
}

/** 按实际连接识别支持的语音图，复制或重命名不会丢失参数能力。 */
export function resolveAudioSpeechWorkflow(workflow?: WorkflowDefinition): AudioSpeechWorkflowControls | undefined {
  if (!workflow || workflow.category !== 'ai-audio' || (workflow.adapterType && workflow.adapterType !== 'comfyui')) return;
  try {
    const graph = JSON.parse(workflow.fileContent);
    const controls = inspectAudioSpeechGraph(graph) ?? inspectQwenSpeechGraph(graph, workflow);
    if (!controls || !workflow.ioNodes?.some((io) => io.nodeId === controls.textNodeId && io.type === 'prompt')) return;
    if (controls.referenceInputId && !workflow.ioNodes.some((io) => io.nodeId === controls.referenceInputId && io.type === 'audio')) return;
    if (workflow.defaultNodes?.prompt && workflow.defaultNodes.prompt !== controls.textNodeId) return;
    if (workflow.defaultNodes?.audio && workflow.defaultNodes.audio !== controls.referenceInputId) return;
    return controls;
  } catch { return; }
}

function inspectAudioSpeechGraph(graph: Graph): AudioSpeechWorkflowControls | undefined {
  const generators = Object.entries(graph).filter(([, node]) => node?.class_type === 'AuKGenerateEdit');
  if (generators.length !== 1) return;
  const [generatorId, generator] = generators[0];
  const inputs = generator.inputs as Record<string, unknown> | undefined;
  if (!inputs || typeof inputs.seconds !== 'number' || !Array.isArray(inputs.conditioning)) return;
  const encodeId = String(inputs.conditioning[0]);
  const encode = graph[encodeId];
  const encoderInputs = encode?.inputs as Record<string, unknown> | undefined;
  if (encode?.class_type !== 'AuKInstructionEncode' || !encoderInputs) return;
  let textNodeId = encodeId;
  let textKey = 'instruction';
  let builderTask: unknown;
  if (Array.isArray(encoderInputs.instruction)) {
    textNodeId = String(encoderInputs.instruction[0]);
    const builder = graph[textNodeId];
    const builderInputs = builder?.inputs as Record<string, unknown> | undefined;
    if (builder?.class_type !== 'AuKInstructionBuilder' || !builderInputs
      || !['Voice cloning', 'Voice description TTS'].includes(String(builderInputs.task))
      || typeof builderInputs['task.text'] !== 'string') return;
    builderTask = builderInputs.task;
    textKey = 'task.text';
  } else if (typeof encoderInputs.instruction !== 'string') return;
  let referenceInputId: string | undefined;
  if (encoderInputs.audio !== undefined) {
    if (!Array.isArray(encoderInputs.audio)) return;
    referenceInputId = String(encoderInputs.audio[0]);
    if (graph[referenceInputId]?.class_type !== 'LoadAudio') return;
  }
  if (builderTask && builderTask !== (referenceInputId ? 'Voice cloning' : 'Voice description TTS')) return;
  return { generatorId, encodeId, textNodeId, textKey, referenceInputId, duration: inputs.seconds };
}

/** 展示引用来源，不读取本节点的生成结果；失效引用保留，便于用户移除。 */
export function collectAudioSpeechReferences(
  prompt: string, nodeId: string | undefined, nodes: readonly SpeechNode[],
  edges: readonly { id: string; source: string; target: string }[],
  library: DramaAssetLibrary, workflow?: WorkflowDefinition, inputs?: Record<string, string>,
  globalAssets: readonly DramaAsset[] = [],
): AudioSpeechReference[] {
  const result: AudioSpeechReference[] = [];
  const collectTokens = (text: string) => {
    for (const match of text.matchAll(/@drama\{([^:]+):([^}]+)\}|@\{([^:]+):([^}]+)\}/g)) {
      if (match[1]) {
        const { assetId, voiceClipId } = parseDramaMentionId(match[1]);
        if (voiceClipId === undefined) continue;
        const voice = resolveDramaVoiceRef(findDramaAsset(library, assetId, globalAssets), voiceClipId);
        result.push({ key: match[0], token: match[0], label: voice?.label ?? match[2], url: voice?.url });
      } else {
        const node = nodes.find((item) => item.id === match[3]);
        if (node && !['ai-audio', 'source-audio'].includes(node.data.type)) continue;
        result.push({ key: match[0], token: match[0], label: node?.data.label || match[4], url: node?.data.audioUrl?.trim() || undefined });
      }
    }
  };
  collectTokens(prompt.replace(workflowChip(), ''));
  for (const io of workflow?.ioNodes ?? []) {
    if (io.type !== 'audio' || !inputs?.[io.nodeId]?.trim()) continue;
    const raw = inputs[io.nodeId].trim();
    const start = result.length;
    collectTokens(raw);
    const tokens = result.splice(start);
    result.push({ key: `input:${io.nodeId}`, inputId: io.nodeId, label: tokens[0]?.label ?? io.title,
      url: tokens.length ? tokens[0].url : raw });
  }
  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    const source = nodes.find((item) => item.id === edge.source);
    if (!source || !['ai-audio', 'source-audio'].includes(source.data.type) || !source.data.audioUrl?.trim()) continue;
    result.push({ key: `edge:${edge.id}`, edgeId: edge.id, label: source.data.label || '参考音频', url: source.data.audioUrl.trim() });
  }
  return result.filter((item, index) => result.findIndex((other) => other.key === item.key) === index);
}

export function stripAudioSpeechReferences(prompt: string, nodes: readonly SpeechNode[]): string {
  return prompt.replace(workflowChip(), '')
    .replace(/@drama\{([^:]+):([^}]+)\}|@\{([^:]+):([^}]+)\}/g, (token, dramaId: string, _label: string, nodeId: string) => {
      if (dramaId) return parseDramaMentionId(dramaId).voiceClipId !== undefined ? '' : token;
      const node = nodes.find((item) => item.id === nodeId);
      return node && ['ai-audio', 'source-audio'].includes(node.data.type) ? '' : token;
    }).trim();
}

export function removeAudioSpeechReference(prompt: string, inputs: Record<string, string> | undefined, reference: AudioSpeechReference) {
  const nextInputs = { ...inputs };
  if (reference.inputId) delete nextInputs[reference.inputId];
  return {
    prompt: reference.inputId
      ? prompt.replace(workflowChip(), (token, id: string) => id === reference.inputId ? '' : token).trim()
      : reference.token ? prompt.split(reference.token).join('').trim() : prompt,
    workflowInputs: Object.keys(nextInputs).length ? nextInputs : undefined,
  };
}

export function audioSpeechModeIssue(controls: AudioSpeechWorkflowControls, hasReference: boolean): string | undefined {
  if (hasReference && !controls.referenceInputId) return '当前工作流不接收参考语音，请选择参考音频与声音克隆工作流。';
  if (!hasReference && controls.referenceInputId) return '请添加参考语音，或选择文生语音工作流。';
}

/** 只修改本次提交的图，正文已按 IO 优先级注入；语速描述不能写进朗读台词字段。 */
export function applyAudioSpeechSettings(graph: Graph, controls: AudioSpeechWorkflowControls, settings?: AudioSpeechSettings, explicitInputs?: Record<string, string>) {
  if (controls.qwen) return applyQwenSpeechSettings(graph, controls, settings, explicitInputs);
  const values = normalizeAudioSpeechSettings(settings, controls.duration);
  const textInputs = graph[controls.textNodeId].inputs as Record<string, unknown>;
  const encodeInputs = graph[controls.encodeId].inputs as Record<string, unknown>;
  const text = String(textInputs[controls.textKey] ?? '').trim();
  if (!text) throw new Error('请输入需要朗读的文本');
  const pace = AUDIO_SPEECH_PACES[values.pace].instruction;
  if (controls.referenceInputId) {
    if (values.pace !== 2 || controls.textKey === 'instruction') {
      encodeInputs.instruction = `Say the following with the same voice: ${JSON.stringify(text)}. ${pace}`;
    }
  } else {
    const voice = AUDIO_SPEECH_VOICES.find((item) => item.value === values.voiceStyle)!;
    if (controls.textKey === 'task.text') textInputs['task.description'] = `${voice.description}. ${pace}`;
    else encodeInputs.instruction = `Generate speech based on the following description: ${JSON.stringify(`${voice.description}. ${pace}`)}. The content to speak is: ${JSON.stringify(text)}.`;
  }
  (graph[controls.generatorId].inputs as Record<string, unknown>).seconds = values.duration;
}
