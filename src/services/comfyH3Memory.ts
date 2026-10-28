import type { ComfyH3MemoryApplication, ComfyH3MemoryOverride, ComfyH3MemorySettings } from '../types/comfyLaunch';
import { comfyH3MemoryFingerprint, DEFAULT_COMFY_H3_MEMORY_SETTINGS, isValidComfyH3MemorySettings } from '../types/comfyLaunch';
import { getComfyLaunchSettings } from './comfyLaunchSettingsService';
import { isTauriEnv } from './fs/core';
import { isLoopbackComfyUrl } from './comfyMemory';
import { comfyFetch } from './comfyPolling';
import { withComfyQueryTimeout } from './comfyQuery';

type Graph = Record<string, Record<string, unknown>>;
type Link = [string, number];
type InputSpec = [unknown, Record<string, unknown>?];
interface NodeInfo {
  input?: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> };
  output?: unknown[];
}
type ObjectInfo = Record<string, NodeInfo>;

const NATIVE_H3 = new Set(['MiniMaxH3ReferenceToVideo', 'MiniMaxH3ImageToVideo']);
const ATTENTION = 'MiniMaxLowVRAMAttention';
const FEED_FORWARD = 'MiniMaxChunkFeedForward';
const INCOMPATIBLE = '当前 H3 工作流的连接或封装节点暂不支持自动低显存优化，请在 ComfyUI 中使用原生 H3 条件、采样与解码节点，或将本节点的 H3 优化设为关闭';
const SCHEMA_ERROR = '无法验证 H3 低显存节点及参数，请确认目标 ComfyUI 已更新并安装 KJNodes 的 MiniMaxLowVRAMAttention、MiniMaxChunkFeedForward，再重试；本次尚未提交生成任务';
const SETTINGS_ERROR = 'H3 低显存设置无效，请检查 ComfyUI 常用设置中的参数范围，或重新选择 12GB 安全预设';

/** 保留脱敏的失败类别，不把上游正文、地址或原始异常链带入节点错误。 */
function schemaReadError(cause: unknown, status?: 401 | 403): Error {
  const category = status ? `http-${status}` : cause instanceof SyntaxError ? 'invalid-response'
    : cause instanceof DOMException && cause.name === 'AbortError' ? 'query-timeout' : 'request-failed';
  const message = status
    ? `无法读取 H3 节点定义（HTTP ${status}），请检查服务端访问权限；本次尚未提交生成任务`
    : SCHEMA_ERROR;
  return new Error(message, { cause: category });
}
const REFERENCE_ERROR = 'H3 参考图片上限需要 ComfyUI_essentials 的 ImageResize+ 节点及仅缩小选项，请安装或更新该插件，或关闭本节点的 H3 优化；也可在全局自定义 H3 设置中将参考图片上限设为 0';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function inputs(node: Record<string, unknown>): Record<string, unknown> {
  const value = record(node.inputs);
  if (!value) throw new Error(INCOMPATIBLE);
  return value;
}

function link(value: unknown): Link | undefined {
  return Array.isArray(value) && value.length === 2 && (typeof value[0] === 'string' || typeof value[0] === 'number')
    && Number.isInteger(value[1]) && value[1] >= 0 ? [String(value[0]), value[1] as number] : undefined;
}

const classOf = (node: Record<string, unknown>) => typeof node.class_type === 'string' ? node.class_type : '';
const isH3Model = (value: unknown) => typeof value === 'string' && /minimax[ _-]*h3/i.test(value);

/** 识别仅用于显示与预设路由；执行时仍复核可追踪的原生 H3 连接。 */
export function isComfyH3Workflow(fileContent: string): boolean {
  try {
    const parsed = record(JSON.parse(fileContent));
    const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : Object.values(parsed ?? {});
    return nodes.some((value) => {
      const node = record(value);
      if (!node) return false;
      const type = typeof node.class_type === 'string' ? node.class_type : node.type;
      return typeof type === 'string' && (/MiniMaxH3|MiniMaxLowVRAMAttention|MiniMaxChunkFeedForward/.test(type)
        || Object.values(record(node.inputs) ?? {}).some(isH3Model)
        || (Array.isArray(node.widgets_values) && node.widgets_values.some(isH3Model)));
    });
  } catch { return false; }
}

function inputSpec(info: ObjectInfo, nodeClass: string, key: string): InputSpec | undefined {
  const groups = info[nodeClass]?.input;
  const direct = groups?.required?.[key] ?? groups?.optional?.[key];
  if (Array.isArray(direct)) return direct;
  // ComfyUI V3 的 autogrow 在 object_info 中以模板声明，prompt 使用 root.slot。
  const [root, slot, extra] = key.split('.');
  if (!slot || extra) return undefined;
  const grow = groups?.required?.[root] ?? groups?.optional?.[root];
  if (grow?.[0] !== 'COMFY_AUTOGROW_V3') return undefined;
  const template = record(grow[1]?.template);
  if (!template) return undefined;
  const prefix = template.prefix;
  const suffix = typeof prefix === 'string' && slot.startsWith(prefix) ? slot.slice(prefix.length) : '';
  const prefixMatch = /^\d+$/.test(suffix) && Number(suffix) < Number(template.max);
  if (!(Array.isArray(template.names) && template.names.includes(slot)) && !prefixMatch) return undefined;
  const templateInputs = record(template.input);
  for (const group of ['required', 'optional']) {
    const declaration = Object.values(record(templateInputs?.[group]) ?? {})[0];
    if (Array.isArray(declaration)) return declaration as InputSpec;
  }
  return undefined;
}

function assertOutput(graph: Graph, info: ObjectInfo, value: unknown, type: string): Link {
  const source = link(value);
  if (!source || !graph[source[0]] || info[classOf(graph[source[0]])]?.output?.[source[1]] !== type) {
    throw new Error(SCHEMA_ERROR);
  }
  return source;
}

function assertValue(info: ObjectInfo, nodeClass: string, key: string, value: unknown): void {
  const spec = inputSpec(info, nodeClass, key);
  if (!spec) throw new Error(SCHEMA_ERROR);
  const [type, config] = spec;
  if (Array.isArray(type)) {
    if (!type.includes(value)) throw new Error(SCHEMA_ERROR);
  } else if (type === 'INT' || type === 'FLOAT') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'INT' && !Number.isInteger(value))
      || (typeof config?.min === 'number' && value < config.min)
      || (typeof config?.max === 'number' && value > config.max)
      || (typeof config?.step === 'number' && config.step > 0
        && Math.abs((value - (typeof config.min === 'number' ? config.min : 0)) / config.step
          - Math.round((value - (typeof config.min === 'number' ? config.min : 0)) / config.step)) > 1e-7)) {
      throw new Error(SCHEMA_ERROR);
    }
  } else if (type !== 'STRING' || typeof value !== 'string') throw new Error(SCHEMA_ERROR);
}

function setValue(node: Record<string, unknown>, info: ObjectInfo, key: string, value: unknown): void {
  if (link(inputs(node)[key])) throw new Error(INCOMPATIBLE);
  assertValue(info, classOf(node), key, value);
  inputs(node)[key] = value;
}

function createNode(graph: Graph, info: ObjectInfo, nodeClass: string, values: Record<string, unknown>, output: string): Link {
  if (info[nodeClass]?.output?.[0] !== output) throw new Error(SCHEMA_ERROR);
  for (const [key, value] of Object.entries(values)) {
    const spec = inputSpec(info, nodeClass, key);
    if (!spec) throw new Error(SCHEMA_ERROR);
    if (link(value)) {
      if (typeof spec[0] !== 'string') throw new Error(SCHEMA_ERROR);
      assertOutput(graph, info, value, spec[0]);
    } else assertValue(info, nodeClass, key, value);
  }
  if (Object.keys(info[nodeClass].input?.required ?? {}).some((key) => !(key in values))) throw new Error(SCHEMA_ERROR);
  let index = 1;
  while (graph[`ai_canvas_h3_memory_${index}`]) index += 1;
  const id = `ai_canvas_h3_memory_${index}`;
  graph[id] = { class_type: nodeClass, inputs: values };
  return [id, 0];
}

/** 只沿声明为指定类型的边向上追踪，拒绝环及没有对应声明的连接。 */
function trace(graph: Graph, info: ObjectInfo, start: Link, type: string): string[] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (source: Link) => {
    assertOutput(graph, info, source, type);
    if (active.has(source[0]) || active.size >= 256 || visited.size > 4096) throw new Error(INCOMPATIBLE);
    if (visited.has(source[0])) return;
    active.add(source[0]);
    const node = graph[source[0]];
    for (const [key, value] of Object.entries(inputs(node))) {
      if (inputSpec(info, classOf(node), key)?.[0] === type && link(value)) visit(link(value)!);
    }
    active.delete(source[0]);
    visited.add(source[0]);
  };
  visit(start);
  return [...visited];
}

function usageCount(graph: Graph, id: string): number {
  return Object.values(graph).reduce((count, node) => count + Object.values(inputs(node))
    .filter((value) => link(value)?.[0] === id).length, 0);
}

function resizeReference(graph: Graph, info: ObjectInfo, source: Link, maxSize: number): Link {
  // 此节点的条件保证仅缩小；ImageScaleToMaxDimension 与 KJ resize 会放大小图。
  const options = { width: maxSize, height: maxSize, interpolation: 'lanczos',
    method: 'keep proportion', condition: 'downscale if bigger', multiple_of: 0 };
  try {
    for (const [key, value] of Object.entries(options)) assertValue(info, 'ImageResize+', key, value);
    const node = graph[source[0]];
    if (classOf(node) === 'ImageResize+' && Object.entries(options).every(([key, value]) => inputs(node)[key] === value)) return source;
    return createNode(graph, info, 'ImageResize+', { image: source, ...options }, 'IMAGE');
  } catch { throw new Error(REFERENCE_ERROR); }
}

function assertExclusiveClipPath(graph: Graph, info: ObjectInfo, path: string[], conditions: Set<string>): void {
  const scope = new Set(path);
  for (const id of path) {
    const node = graph[id];
    const upstream = Object.entries(inputs(node)).some(([key, value]) => inputSpec(info, classOf(node), key)?.[0] === 'CLIP' && link(value));
    if (!upstream && (classOf(node) !== 'CLIPLoader' || inputs(node).type !== 'minimax')) throw new Error(INCOMPATIBLE);
    for (const [consumerId, consumer] of Object.entries(graph)) {
      for (const [key, value] of Object.entries(inputs(consumer))) {
        if (link(value)?.[0] !== id) continue;
        if ((!scope.has(consumerId) && !conditions.has(consumerId))
          || inputSpec(info, classOf(consumer), key)?.[0] !== 'CLIP') throw new Error(INCOMPATIBLE);
      }
    }
  }
}

function modelPath(graph: Graph, info: ObjectInfo, source: Link): string[] {
  const path = trace(graph, info, source, 'MODEL');
  for (const id of path) {
    const node = graph[id];
    const values = inputs(node);
    const upstream = Object.entries(values).some(([key, value]) => inputSpec(info, classOf(node), key)?.[0] === 'MODEL' && link(value));
    if (!upstream && !((classOf(node) === 'UNETLoader' && isH3Model(values.unet_name))
      || (classOf(node) === 'MiniMaxH3HybridLoader' && isH3Model(values.base_model) && isH3Model(values.overlay_model)))) {
      throw new Error(INCOMPATIBLE);
    }
  }
  return path;
}

function patchModel(graph: Graph, info: ObjectInfo, target: Record<string, unknown>, settings: ComfyH3MemorySettings): void {
  const source = assertOutput(graph, info, inputs(target).model, 'MODEL');
  const path = modelPath(graph, info, source);
  const originalUsage = new Map(path.map((id) => [id, usageCount(graph, id)]));
  let result = source;
  for (const [nodeClass, values] of [
    [ATTENTION, { head_chunks: settings.attentionHeadChunks }],
    [FEED_FORWARD, { chunks: settings.feedForwardChunks, seq_threshold: settings.feedForwardThreshold }],
  ] as const) {
    const existing = path.filter((id) => classOf(graph[id]) === nodeClass);
    if (existing.length > 1) throw new Error(INCOMPATIBLE);
    if (existing.length) {
      const node = graph[existing[0]];
      const changed = Object.entries(values).some(([key, value]) => inputs(node)[key] !== value);
      // 沿下游链检查共享；仅检查补丁本身会漏掉中间MODEL节点之后的分叉。
      if (changed && path.slice(path.indexOf(existing[0])).some((id) => (originalUsage.get(id) ?? 0) > 1)) {
        throw new Error(INCOMPATIBLE);
      }
      for (const [key, value] of Object.entries(values)) {
        setValue(node, info, key, value);
      }
    } else result = createNode(graph, info, nodeClass, { model: result, ...values }, 'MODEL');
  }
  if (inputSpec(info, classOf(target), 'model')?.[0] !== 'MODEL') throw new Error(SCHEMA_ERROR);
  inputs(target).model = result;
}

function samplingTargets(graph: Graph, info: ObjectInfo, conditionIds: Set<string>): { targets: Set<string>; samplers: Set<string> } {
  const targets = new Set<string>();
  const samplers = new Set<string>();
  for (const [id, sampler] of Object.entries(graph)) {
    const nodeClass = classOf(sampler);
    if (!['SamplerCustomAdvanced', 'SamplerCustom', 'KSampler', 'KSamplerAdvanced'].includes(nodeClass)) continue;
    let targetId = id;
    let conditionKey = 'positive';
    if (nodeClass === 'SamplerCustomAdvanced') {
      const guider = assertOutput(graph, info, inputs(sampler).guider, 'GUIDER');
      const guiderClass = classOf(graph[guider[0]]);
      if (!['BasicGuider', 'CFGGuider'].includes(guiderClass)) throw new Error(INCOMPATIBLE);
      targetId = guider[0];
      conditionKey = guiderClass === 'BasicGuider' ? 'conditioning' : 'positive';
    }
    const target = graph[targetId];
    const condition = link(inputs(target)[conditionKey]);
    if (!condition) continue;
    const ancestry = trace(graph, info, condition, 'CONDITIONING');
    if (!ancestry.some((key) => conditionIds.has(key))) continue;
    targets.add(targetId);
    samplers.add(id);
  }
  if (!targets.size) throw new Error(INCOMPATIBLE);
  return { targets, samplers };
}

function isVideoSample(graph: Graph, info: ObjectInfo, source: Link, samplers: Set<string>, visited = new Set<string>()): boolean {
  assertOutput(graph, info, source, 'LATENT');
  if (visited.has(source[0]) || visited.size >= 256) throw new Error(INCOMPATIBLE);
  visited.add(source[0]);
  if (samplers.has(source[0])) return true;
  const node = graph[source[0]];
  if (classOf(node) === 'LTXVSeparateAVLatent' && source[1] !== 0) return false;
  const upstream = Object.entries(inputs(node)).filter(([key, value]) => inputSpec(info, classOf(node), key)?.[0] === 'LATENT' && link(value));
  return upstream.length === 1 && isVideoSample(graph, info, link(upstream[0][1])!, samplers, visited);
}

function applyPlan(graph: Graph, info: ObjectInfo, settings: ComfyH3MemorySettings): ComfyH3MemoryApplication['applied'] {
  const conditions = Object.entries(graph).filter(([, node]) => NATIVE_H3.has(classOf(node)));
  const conditionIds = new Set(conditions.map(([id]) => id));
  const { targets, samplers } = samplingTargets(graph, info, conditionIds);
  for (const id of targets) patchModel(graph, info, graph[id], settings);
  const applied: ComfyH3MemoryApplication['applied'] = ['attention', 'feedForward'];
  const videoVaes = new Set<string>();
  let resized = false;
  let cpu = false;
  for (const [, node] of conditions) {
    const values = inputs(node);
    if (values.vae) {
      const vae = assertOutput(graph, info, values.vae, 'VAE');
      trace(graph, info, vae, 'VAE').forEach((id) => videoVaes.add(id));
    }
    if (settings.textEncoderDevice === 'cpu') {
      const clip = assertOutput(graph, info, values.clip, 'CLIP');
      const path = trace(graph, info, clip, 'CLIP');
      assertExclusiveClipPath(graph, info, path, conditionIds);
      const loaders = path.filter((id) => classOf(graph[id]) === 'CLIPLoader');
      if (!loaders.length) throw new Error(INCOMPATIBLE);
      for (const id of loaders) {
        if (inputs(graph[id]).type !== 'minimax') throw new Error(INCOMPATIBLE);
        setValue(graph[id], info, 'device', 'cpu');
        cpu = true;
      }
    }
    if (settings.referenceImageMaxSize && classOf(node) === 'MiniMaxH3ReferenceToVideo') {
      for (const [key, value] of Object.entries(values)) {
        // ref_video 等也是 IMAGE，不能误将视频帧批次当作人物参考图缩放。
        if (!/^(?:ref_images\.ref_image_\d+|ref_image_\d+)$/.test(key) || !link(value)) continue;
        if (inputSpec(info, classOf(node), key)?.[0] !== 'IMAGE') throw new Error(SCHEMA_ERROR);
        const source = assertOutput(graph, info, value, 'IMAGE');
        values[key] = resizeReference(graph, info, source, settings.referenceImageMaxSize);
        resized = true;
      }
    }
  }
  if (cpu) applied.push('textEncoderCpu');
  if (resized) applied.push('referenceImages');
  if (settings.vaeTiling) {
    let decoders = 0;
    for (const node of Object.values(graph)) {
      if (!['VAEDecode', 'VAEDecodeTiled'].includes(classOf(node))) continue;
      const values = inputs(node);
      const vae = link(values.vae);
      const samples = link(values.samples);
      if (!vae || !samples || !videoVaes.has(vae[0]) || !isVideoSample(graph, info, samples, samplers)) continue;
      assertOutput(graph, info, vae, 'VAE');
      for (const key of ['tile_size', 'overlap', 'temporal_size', 'temporal_overlap']) {
        if (link(values[key])) throw new Error(INCOMPATIBLE);
      }
      const replacement = { ...values, tile_size: settings.vaeTileSize, overlap: 64, temporal_size: settings.vaeTemporalSize, temporal_overlap: 4 };
      // 通过同一构造校验输入、输出和完整required合同，再保留原ID及下游连接。
      const created = createNode(graph, info, 'VAEDecodeTiled', replacement, 'IMAGE');
      const validated = graph[created[0]];
      delete graph[created[0]];
      node.class_type = validated.class_type;
      node.inputs = validated.inputs;
      decoders += 1;
    }
    if (!decoders) throw new Error(INCOMPATIBLE);
    // 回执记录已请求Tiled节点；H3自带VAE的具体块大小仍由后端实现决定。
    applied.push('vaeTiling');
  }
  return applied;
}

/** 本机全局设置只继承给loopback桌面服务；远端必须在节点显式选择预设。 */
export async function resolveComfyH3MemorySettings(
  baseUrl: string,
  override: ComfyH3MemoryOverride = 'inherit',
): Promise<ComfyH3MemorySettings | undefined> {
  if (override === 'off') return undefined;
  let settings: ComfyH3MemorySettings;
  if (override === 'safe12') settings = { ...DEFAULT_COMFY_H3_MEMORY_SETTINGS, preset: 'safe12' };
  else if (override === 'inherit') {
    if (!isLoopbackComfyUrl(baseUrl) || !isTauriEnv()) return undefined;
    let configured: ComfyH3MemorySettings;
    try { configured = (await getComfyLaunchSettings()).h3Memory; }
    catch { throw new Error(SETTINGS_ERROR); }
    settings = configured.preset === 'safe12'
      ? { ...DEFAULT_COMFY_H3_MEMORY_SETTINGS, preset: 'safe12' } : { ...configured };
  } else throw new Error(SETTINGS_ERROR);
  if (!isValidComfyH3MemorySettings(settings)) throw new Error(SETTINGS_ERROR);
  return settings.preset === 'off' ? undefined : settings;
}

/** 仅修改调用方已克隆的本次prompt；所有校验通过后才原子应用计划。 */
export async function applyComfyH3Memory(
  workflow: Graph,
  baseUrl: string,
  override: ComfyH3MemoryOverride = 'inherit',
  signal?: AbortSignal,
  expectedSettingsFingerprint?: string,
): Promise<ComfyH3MemoryApplication | undefined> {
  if (!isComfyH3Workflow(JSON.stringify(workflow))) {
    if (expectedSettingsFingerprint !== undefined) throw new Error('H3 工作流已变化，请重新检查视频批次');
    return undefined;
  }
  const settings = await resolveComfyH3MemorySettings(baseUrl, override);
  if (expectedSettingsFingerprint !== undefined && comfyH3MemoryFingerprint(settings) !== expectedSettingsFingerprint) {
    throw new Error('H3 显存设置已变化，请重新检查视频批次');
  }
  if (!settings || settings.preset === 'off') return undefined;
  if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
  if (!Object.values(workflow).some((node) => NATIVE_H3.has(classOf(node)))
    || Object.values(workflow).some((node) => classOf(node) === 'easy multitrackProject')) throw new Error(INCOMPATIBLE);
  let info: ObjectInfo;
  let deniedStatus: 401 | 403 | undefined;
  try {
    info = await withComfyQueryTimeout(async (querySignal) => {
      const response = await comfyFetch(`${baseUrl.replace(/\/+$/, '')}/object_info`, { signal: querySignal });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) deniedStatus = response.status;
        void response.body?.cancel().catch(() => undefined);
        throw new Error(SCHEMA_ERROR);
      }
      const payload = record(await response.json());
      if (!payload) throw new Error(SCHEMA_ERROR);
      return payload as ObjectInfo;
    }, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw schemaReadError(error, deniedStatus);
  }
  const draft = structuredClone(workflow);
  const applied = applyPlan(draft, info, settings);
  if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
  Object.assign(workflow, draft);
  return { preset: settings.preset, settings, applied };
}
