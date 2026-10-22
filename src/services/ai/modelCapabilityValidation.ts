/** 自定义媒体模型的能力与请求映射一致性；不推断厂商参数或发送网络请求。 */
import type { GeneralModelCategory, ProviderModelSelection } from '../../types';
import type { ImageModelCapability, ModelProtocolPresetId, NormalizedModelExecutionProtocol } from '../../types/aiTypes';
import { modelProtocolUsesVariable, resolveModelExecutionProfile } from './modelProtocol';

const RESULT_CATEGORY_LABELS: Record<GeneralModelCategory, string> = {
  text: '文本', image: '图片', video: '视频', audio: '音频',
};

const MODEL_PROTOCOL_PRESET_IDS: readonly ModelProtocolPresetId[] = [
  'openai-chat', 'anthropic-chat', 'gemini-chat', 'openai-image', 'openai-gpt-image',
  'gpt-image-gateway-json', 'google-image-native', 'xai-image-native', 'agnes-video', 'custom',
];

export function isModelProtocolPresetId(value: unknown): value is ModelProtocolPresetId {
  return typeof value === 'string' && MODEL_PROTOCOL_PRESET_IDS.includes(value as ModelProtocolPresetId);
}

/** 请求成功和结果可交付是两项独立条件；不能把文本结果当作视频试跑成功。 */
export function assertModelProtocolResult(
  category: GeneralModelCategory,
  result: { urls?: string[]; text?: string },
): void {
  if (category === 'text') {
    if (typeof result.text !== 'string' || !result.text.trim()) {
      throw new Error('请求成功，但没有解析出文本结果；请检查 response.result.textPath 或 poll.response.result.textPath');
    }
    return;
  }
  if (!result.urls?.length || result.urls.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('请求成功，但没有解析出有效媒体结果地址；请检查结果 URL、Base64 或二进制下载映射');
  }
  for (const rawValue of result.urls) {
    const value = rawValue.trim();
    if (/^data:/i.test(value)) {
      const match = /^data:([^;,]+)(?:;[^,]*)?,([\s\S]+)$/i.exec(value);
      const mimeType = match?.[1].trim().toLowerCase();
      if (!mimeType || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)
        || !mimeType.startsWith(`${category}/`) || !match?.[2].trim()) {
        throw new Error('请求成功，但实际返回的内联媒体 MIME 类型与模型类别不匹配，请检查厂商响应与结果映射');
      }
      continue;
    }
    let url: URL;
    try { url = new URL(value); } catch {
      throw new Error('请求成功，但结果字段不是有效的 HTTP(S) 媒体地址，请检查结果 URL 路径是否误指向文本字段');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('请求成功，但结果字段不是无凭据的 HTTP(S) 媒体地址，请检查厂商响应与结果映射');
    }
  }
}

/** 检查声明的输出类别，不依赖 URL 文件后缀推断媒体类型。 */
export function assertModelProtocolResultMapping(
  category: GeneralModelCategory,
  protocol: NormalizedModelExecutionProtocol,
): void {
  const asynchronous = protocol.mode === 'async';
  const result = asynchronous ? protocol.poll?.response.result : protocol.response.result;
  const location = asynchronous ? 'poll.response.result' : 'response.result';
  const binary = !asynchronous && protocol.response.type === 'binary';
  const text = !asynchronous && protocol.response.type === 'text';
  const hasMediaMapping = binary || !!(result?.urlPath || result?.base64Path || result?.download);
  if (category === 'text') {
    if (hasMediaMapping) throw new Error(`${location}：文本模型不能使用媒体结果映射，请配置 textPath 或同步 text 响应`);
    if (!text && !result?.textPath) {
      throw new Error(`${location}：文本模型必须配置 textPath，或使用同步 text 响应`);
    }
  } else if (text || !hasMediaMapping) {
    throw new Error(`${location}：${RESULT_CATEGORY_LABELS[category]}模型需要 URL、Base64、binary 响应或 download 映射，不能仅配置 textPath`);
  }
  const mimeType = result?.mimeType?.split(';')[0].trim().toLowerCase();
  if (mimeType && mimeType !== 'application/octet-stream'
    && !mimeType.startsWith(`${category === 'text' ? 'text' : category}/`)) {
    throw new Error(`${location}.mimeType 与${RESULT_CATEGORY_LABELS[category]}模型类别不匹配，请按厂商文档修改结果 MIME 类型`);
  }
}

export function assertImageModelCapability(capability: ImageModelCapability): void {
  for (const [field, defaultField] of [
    ['resolutions', 'defaultResolution'], ['ratios', 'defaultRatio'],
  ] as const) {
    const values = capability[field];
    if (values && (values.length === 0 || values.some((value) => !value.trim())
      || new Set(values.map((value) => value.toLowerCase())).size !== values.length)) {
      throw new Error(`${field} 必须是非空且不重复的选项`);
    }
    const fallback = capability[defaultField];
    if (fallback !== undefined && !values?.some((value) => value.toLowerCase() === fallback.toLowerCase())) {
      throw new Error(`${defaultField} 必须属于 ${field}`);
    }
  }
  for (const field of ['maxBatchCount', 'maxImageReferences'] as const) {
    const value = capability[field];
    if (value !== undefined && (!Number.isInteger(value) || value < (field === 'maxBatchCount' ? 1 : 0))) {
      throw new Error(`${field} 必须是有效整数`);
    }
  }
  if (capability.supportsBatch === false && (capability.maxBatchCount ?? 1) > 1) {
    throw new Error('不支持批量时 maxBatchCount 不能大于 1');
  }
  if (capability.supportsImageReference === false && (capability.maxImageReferences ?? 0) > 0) {
    throw new Error('不支持参考图时 maxImageReferences 不能大于 0');
  }
  if (capability.dimensionPresets) {
    for (const ratios of Object.values(capability.dimensionPresets)) {
      if (!ratios || typeof ratios !== 'object' || Array.isArray(ratios)) throw new Error('图片像素尺寸表必须按分辨率和比例声明');
      for (const dimensions of Object.values(ratios)) {
        if (!Array.isArray(dimensions) || dimensions.length !== 2
          || dimensions.some((value) => !Number.isInteger(value) || value <= 0)) {
          throw new Error('图片像素尺寸必须是两个正整数');
        }
      }
    }
    for (const resolution of capability.resolutions ?? []) {
      const key = Object.keys(capability.dimensionPresets).find((value) => value.toLowerCase() === resolution.toLowerCase());
      for (const ratio of capability.ratios ?? []) {
        if (!key || !capability.dimensionPresets[key][ratio]) {
          throw new Error(`图片参数 ${resolution} / ${ratio} 缺少像素尺寸映射，请重新应用相应模板`);
        }
      }
    }
  }
}

export function resolveConfiguredImageParameters(
  capability: ImageModelCapability,
  params: { imageSize?: string; aspectRatio?: string; count: number },
): { imageSize: string; aspectRatio: string } {
  assertImageModelCapability(capability);
  const select = (value: string | undefined, allowed: string[] | undefined, fallback: string | undefined, label: string, legacy: string) => {
    const normalized = value === '自适应' ? 'auto' : value;
    if (normalized !== undefined && allowed?.length) {
      const match = allowed.find((item) => item.toLowerCase() === normalized.toLowerCase());
      if (!match) throw new Error(`图片模型不支持${label} ${value}，可选：${allowed.join('、')}`);
      return match;
    }
    return normalized ?? fallback ?? allowed?.[0] ?? legacy;
  };
  const maximum = capability.supportsBatch === false ? 1 : capability.maxBatchCount;
  if (maximum !== undefined && params.count > maximum) {
    throw new Error(`图片模型单次最多生成 ${maximum} 张图片`);
  }
  return {
    imageSize: select(params.imageSize, capability.resolutions, capability.defaultResolution, '分辨率', '2K'),
    aspectRatio: select(params.aspectRatio, capability.ratios, capability.defaultRatio, '比例', '1:1'),
  };
}

export function assertConfiguredImageReferences(capability: ImageModelCapability, count: number): void {
  if (count > 0 && capability.supportsImageReference === false) throw new Error('该图片模型不支持参考图（仅文生图）');
  if (capability.maxImageReferences !== undefined && count > capability.maxImageReferences) {
    throw new Error(`该图片模型最多支持 ${capability.maxImageReferences} 张参考图`);
  }
}

/** 多选项必须消费动态变量；单一固定值允许由厂商协议固定输出。 */
export function assertModelCapabilityProtocol(model: ProviderModelSelection): void {
  if (model.executionProfile && !isModelProtocolPresetId(model.executionProfile.preset)) {
    throw new Error('executionProfile.preset：调用协议预设不受当前应用支持');
  }
  if (model.imageCapability) assertImageModelCapability(model.imageCapability);
  if (model.imageCapability?.supportsDataUrlReference === false
    && model.imageReferenceRequestMode === 'generation-json-image-data-urls') {
    throw new Error(`模型“${model.name}”声明不支持 Base64 参考图，但请求方式会发送 Base64`);
  }
  const protocol = resolveModelExecutionProfile(model.executionProfile);
  if (model.executionProfile && !protocol && model.category !== 'text') {
    throw new Error('executionProfile.preset：原生文本协议不能用于媒体模型');
  }
  if (!protocol) return;
  assertModelProtocolResultMapping(model.category, protocol);
  // 厂商预设的请求映射由各预设维护；这里不把它当成用户声明的自定义参数。
  if (model.executionProfile?.preset !== 'custom') return;
  const source = JSON.stringify(protocol.submit);
  const requireMapping = (adjustable: boolean, label: string, variables: string[]) => {
    if (adjustable && !modelProtocolUsesVariable(source, ...variables)) {
      throw new Error(`模型“${model.name}”声明可调${label}，但提交协议没有映射 ${variables.map((value) => `{{${value}}}`).join(' / ')}`);
    }
  };
  if (model.category === 'image') {
    const capability = model.imageCapability;
    if (!capability) return;
    requireMapping((capability.resolutions?.length ?? 0) > 1, '分辨率', ['imageSize', 'size', 'width', 'height']);
    requireMapping((capability.ratios?.length ?? 0) > 1, '比例', ['aspectRatio', 'size', 'width', 'height']);
    requireMapping(capability.supportsBatch === true && (capability.maxBatchCount ?? 2) > 1, '数量', ['n', 'batchCount']);
    requireMapping(capability.supportsImageReference === true, '参考图', ['imageUrls', 'googleImageParts']);
    if (capability.supportsImageReference === false && modelProtocolUsesVariable(source, 'imageUrls', 'googleImageParts')) {
      throw new Error(`模型“${model.name}”声明不支持参考图，但协议仍映射参考图`);
    }
  } else if (model.category === 'video') {
    const capability = model.videoCapability;
    if (!capability) return;
    const modeRatios = Object.values(capability.inputModeCapabilities ?? {}).flatMap((value) => value?.ratios ?? []);
    requireMapping((capability.resolutions?.length ?? 0) > 1, '分辨率', ['seedanceResolution', 'resolution', 'videoResolution', 'size', 'width', 'height']);
    requireMapping((capability.ratios?.length ?? 0) > 1 || new Set(modeRatios).size > 1, '比例', ['aspectRatio', 'seedanceRatio', 'size', 'width', 'height']);
    requireMapping((capability.frameRates?.length ?? 0) > 1, '帧率', ['fps', 'videoFps', 'frames8n1', 'frames', 'videoFrames']);
    requireMapping((capability.durations?.length ?? 0) > 1
      || (capability.minDuration !== undefined && capability.maxDuration !== undefined && capability.minDuration !== capability.maxDuration),
    '时长', ['duration', 'durationText', 'seedanceDuration', 'frames8n1', 'frames', 'videoFrames']);
    requireMapping(capability.supportsAudio === true, '音频开关', ['generateAudio', 'disableAudio']);
  }
}

export function describeModelParameterGaps(model: ProviderModelSelection): string {
  const missing: string[] = [];
  if (model.category === 'image') {
    if (!model.imageCapability?.resolutions?.length) missing.push('分辨率');
    if (!model.imageCapability?.ratios?.length) missing.push('比例');
    if (model.imageCapability?.supportsBatch === undefined) missing.push('数量');
    if (model.imageCapability?.supportsImageReference === undefined) missing.push('参考图');
  } else if (model.category === 'video') {
    const capability = model.videoCapability;
    if (!capability?.resolutions?.length) missing.push('分辨率');
    if (!capability?.ratios?.length) missing.push('比例');
    if (!capability?.durations?.length && capability?.minDuration === undefined && capability?.maxDuration === undefined) missing.push('时长');
    if (!capability?.frameRates?.length) missing.push('帧率');
  }
  return missing.length ? `${missing.join('、')}待确认（未声明）` : '';
}
