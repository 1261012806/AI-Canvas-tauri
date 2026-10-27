/**
 * RelayOnAPI 已核对目录（2026-10-27）。来源：https://relayonapi.com/docs。
 * 媒体结果映射采用用户确认的 OpenAI 兼容合同，尚未进行厂商真实生成验收。
 * 普通 Flare／Sunburst 的质量和背景候选采用用户确认的兼容选项，未据此宣称平台实测通过。
 * 其余型号不推断质量、背景或未公开的首尾帧合同。
 */
import type { ProviderModelSelection } from '../../../types';
import type { ImageModelCapability, ModelExecutionProfile, NormalizedModelExecutionProtocol, ProtocolJsonValue, VideoModelCapability } from '../../../types/aiTypes';
import type { ModelProtocolVariables } from '../modelProtocolTypes';
import { resolveModelExecutionProfile } from '../modelProtocol';

export const RELAYON_BASE_URL = 'https://relayonapi.com/v1';

export const RELAYON_TEXT_MODEL_IDS = [
  'gemini-3.8-flash', 'gemini-4-argon', 'gpt-6.1-sol', 'claude-opus-5-5',
] as const;

const TEXT_MODEL_NAMES: Record<typeof RELAYON_TEXT_MODEL_IDS[number], string> = {
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gpt-6.1-sol': 'GPT 6.1 Sol',
  'claude-opus-5-5': 'Claude Opus 5.5',
};

export const RELAYON_IMAGE_MODEL_IDS = [
  'image-2-01', 'Image-2.5-Flare', 'image-2.5-flare-01', 'Image-2.5-Sunburst', 'image-2.5-sunburst-01',
  'nano-banana-2', 'nano-banana-2.1', 'nano-banana-pro', 'Seedream 5.0 Pro',
] as const;

export const RELAYON_VIDEO_MODEL_IDS = [
  'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615',
  'doubao-seedance-2-5-260628', 'sd-2.0-A', 'sd-2.5-A', 'sd-2.0-c1', 'sd-2.0-c2',
] as const;

export const RELAYON_VIDEO_RESULT_URL_PATHS = ['url', 'video_url', 'content.video_url'] as const;

/** 当前 imageUtils 内联准备入口最多 6 张；局部快照避免目录反向加载上传与 Store。 */
export const RELAYON_IMAGE_REFERENCE_LIMIT = 6;

type ImageDimensions = NonNullable<ImageModelCapability['dimensionPresets']>;
type PixelPair = readonly [number, number];
type PixelTiers = readonly [PixelPair, PixelPair, PixelPair];

// 官网逐档尺寸表；不是按比例或像素长边推算的通用尺寸。
const IMAGE_COMMON_PIXELS: Record<string, PixelTiers> = {
  '1:1': [[1024, 1024], [2048, 2048], [2880, 2880]],
  '4:3': [[1152, 864], [2048, 1536], [3264, 2448]],
  '3:2': [[1248, 832], [2016, 1344], [3456, 2304]],
  '16:9': [[1280, 720], [2048, 1152], [3840, 2160]],
  '21:9': [[1344, 576], [2016, 864], [3808, 1632]],
  '3:4': [[864, 1152], [1536, 2048], [2448, 3264]],
  '2:3': [[832, 1248], [1344, 2016], [2304, 3456]],
  '9:16': [[720, 1280], [1152, 2048], [2160, 3840]],
};

function imagePixelTiers(rows: Record<string, PixelTiers>): ImageDimensions {
  return Object.fromEntries(['1K', '2K', '4K'].map((resolution, index) => [resolution,
    Object.fromEntries(Object.entries(rows).map(([ratio, sizes]) => [ratio, [...sizes[index]] as [number, number]])),
  ]));
}

const IMAGE_2_PIXELS = imagePixelTiers({ ...IMAGE_COMMON_PIXELS,
  '9:21': [[576, 1344], [864, 2016], [1632, 3808]],
});
const IMAGE_25_PIXELS = imagePixelTiers({ ...IMAGE_COMMON_PIXELS,
  '4:5': [[1024, 1280], [1600, 2048], [2304, 2880]],
  '5:4': [[1280, 1024], [2048, 1600], [2880, 2304]],
});
const BANANA_1K_PIXELS: Record<string, PixelPair> = {
  '1:1': [1024, 1024], '2:3': [832, 1248], '3:2': [1248, 832], '3:4': [864, 1152],
  '4:3': [1152, 864], '4:5': [1024, 1280], '5:4': [1280, 1024], '9:16': [720, 1280],
  '16:9': [1280, 720], '21:9': [1344, 576],
};
// 官网三个 Nano 型号的 2K／4K 表分别恰为每维两倍／四倍，已逐表核对。
const BANANA_PIXELS: ImageDimensions = Object.fromEntries([1, 2, 4].map((scale) => [`${scale}K`,
  Object.fromEntries(Object.entries(BANANA_1K_PIXELS).map(([ratio, [width, height]]) => [ratio,
    [width * scale, height * scale] as [number, number],
  ])),
]));
const SEEDREAM_PIXELS: ImageDimensions = {
  '1K': { '1:1': [1024, 1024], '4:3': [1280, 960], '3:4': [960, 1280],
    '16:9': [1536, 864], '9:16': [864, 1536], '3:2': [1536, 1024] },
  '2K': { '1:1': [2048, 2048], '4:3': [2048, 1536], '3:4': [1536, 2048],
    '16:9': [2048, 1152], '9:16': [1152, 2048], '3:2': [2016, 1344] },
};

function imageModel(id: string, name: string, pixels: ImageDimensions, maxReferences: number): ProviderModelSelection {
  const hasImageOptions = id === 'Image-2.5-Flare' || id === 'Image-2.5-Sunburst';
  const protocol: NormalizedModelExecutionProtocol = {
    version: 2, mode: 'sync', auth: { type: 'bearer' },
    submit: { method: 'POST', path: '/images/generations', bodyEncoding: 'json',
      body: { model: '{{model}}', prompt: '{{prompt}}', resolution: '{{imageSize}}',
        aspect_ratio: '{{aspectRatio}}', size: '{{size}}', n: 1, response_format: 'url', image: '{{imageUrls}}',
        ...(hasImageOptions ? { quality: '{{imageQuality}}', background: '{{imageBackground}}' } : {}) } },
    response: { type: 'json', errorPath: 'error.message', result: { urlPath: 'data.*.url' } },
  };
  return { id, name, provider: 'relayonapi', category: 'image', inputModalities: ['text', 'image'],
    imageReferenceRequestMode: 'generation-json-image-data-urls',
    imageCapability: { resolutions: Object.keys(pixels), defaultResolution: '1K',
      ratios: Object.keys(pixels['1K']), defaultRatio: '1:1', dimensionPresets: structuredClone(pixels),
      ...(hasImageOptions ? { qualities: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], backgrounds: ['auto', 'opaque', 'transparent'] } : {}),
      supportsBatch: false, maxBatchCount: 1, supportsImageReference: true,
      maxImageReferences: Math.min(RELAYON_IMAGE_REFERENCE_LIMIT, maxReferences), supportsDataUrlReference: true },
    executionProfile: { preset: 'custom', protocol } };
}

function videoProtocol(body: Record<string, ProtocolJsonValue>): NormalizedModelExecutionProtocol {
  return {
    version: 2, mode: 'async', auth: { type: 'bearer' },
    submit: { method: 'POST', path: '/videos', bodyEncoding: 'json', body },
    response: { type: 'json', taskIdPath: 'id', errorPath: 'error.message' },
    poll: { method: 'GET', path: '/videos/{{submit.id}}', intervalMs: 10_000, maxDurationMs: 7_200_000,
      response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed'],
        errorPath: 'error.message', result: { urlPath: RELAYON_VIDEO_RESULT_URL_PATHS[0], mimeType: 'video/mp4' } } },
  };
}

function referenceItems(imageRole: boolean): ProtocolJsonValue[] {
  return (['image', 'video', 'audio'] as const).map((type): ProtocolJsonValue => {
    const variable = type === 'image' ? 'referenceImageUrls' : type === 'video' ? 'referenceVideoUrls' : 'referenceAudioUrls';
    const value: Record<string, ProtocolJsonValue> = { type, url: `{{${variable}}}` };
    if (type === 'image' && imageRole) value.role = 'reference';
    return { $forEach: `{{${variable}}}`, $value: value };
  });
}

function videoModel(id: string, name: string, capability: VideoModelCapability, body: Record<string, ProtocolJsonValue>): ProviderModelSelection {
  return { id, name, provider: 'relayonapi', category: 'video',
    inputModalities: capability.maxImageReferences === 0 ? ['text'] : ['text', 'image'],
    videoCapability: { defaultRatio: '16:9', defaultDuration: capability.minDuration,
      ...capability }, executionProfile: { preset: 'custom', protocol: videoProtocol(body) } };
}

function officialVideo(id: string, name: string, maxDuration: number, resolutions: string[]): ProviderModelSelection {
  return videoModel(id, name, { operations: ['text-to-video'], minDuration: 4, maxDuration,
    resolutions, defaultResolution: resolutions[0], ratios: ['16:9'], supportsAudio: true,
    maxImageReferences: 0, maxVideoReferences: 0, maxAudioReferences: 0 }, {
    model: '{{model}}', prompt: '{{prompt}}', seconds: '{{durationText}}',
    metadata: { resolution: '{{resolution}}', ratio: '{{aspectRatio}}', generate_audio: '{{generateAudio}}' },
  });
}

function referenceVideo(id: string, maxDuration: number): ProviderModelSelection {
  return videoModel(id, `Seedance ${id === 'sd-2.0-A' ? '2.0' : '2.5'} A`, {
    operations: ['text-to-video', 'image-to-video', 'video-to-video'], minDuration: 4, maxDuration,
    resolutions: ['480p', '720p', '1080p'], defaultResolution: '480p', ratios: ['16:9'], supportsAudio: true,
    // 应用首批只开放已核对的组合，不将未公开的纯音频输入当成厂商能力。
    supportsStandaloneAudio: false,
  }, { model: '{{model}}', prompt: '{{prompt}}', seconds: '{{durationText}}',
    output: { resolution: '{{resolution}}', aspect_ratio: '{{aspectRatio}}' },
    generate_audio: '{{generateAudio}}', references: referenceItems(true) });
}

function cVideo(id: string, minDuration: number, maxVideoReferences: number): ProviderModelSelection {
  return videoModel(id, `Seedance 2.0 ${id.endsWith('c1') ? 'C1' : 'C2'}`, {
    operations: maxVideoReferences ? ['text-to-video', 'image-to-video', 'video-to-video'] : ['text-to-video', 'image-to-video'],
    minDuration, maxDuration: 15, resolutions: ['720p'], defaultResolution: '720p',
    ratios: ['16:9', '9:16', '4:3', '3:4', '1:1'], maxImageReferences: 9, maxVideoReferences, maxAudioReferences: 3,
    supportsStandaloneAudio: false,
  }, { model: '{{model}}', prompt: '{{prompt}}', duration: '{{duration}}', resolution: '{{resolution}}',
    aspect_ratio: '{{aspectRatio}}', references: referenceItems(false) });
}

export const RELAYON_MODEL_MANIFEST: readonly ProviderModelSelection[] = [
  ...RELAYON_TEXT_MODEL_IDS.map((id): ProviderModelSelection => ({ id, name: TEXT_MODEL_NAMES[id],
    provider: 'relayonapi', category: 'text', inputModalities: ['text'], executionProfile: { preset: 'openai-chat' } })),
  imageModel('image-2-01', 'Image 2 01', IMAGE_2_PIXELS, 8),
  imageModel('Image-2.5-Flare', 'Image 2.5 Flare', IMAGE_25_PIXELS, 16),
  imageModel('image-2.5-flare-01', 'Image 2.5 Flare 01', IMAGE_25_PIXELS, 8),
  imageModel('Image-2.5-Sunburst', 'Image 2.5 Sunburst', IMAGE_25_PIXELS, 16),
  imageModel('image-2.5-sunburst-01', 'Image 2.5 Sunburst 01', IMAGE_25_PIXELS, 8),
  imageModel('nano-banana-2', 'Nano Banana 2', BANANA_PIXELS, 8),
  imageModel('nano-banana-2.1', 'Nano Banana 2.1', BANANA_PIXELS, 8),
  imageModel('nano-banana-pro', 'Nano Banana Pro', BANANA_PIXELS, 8),
  imageModel('Seedream 5.0 Pro', 'Seedream 5.0 Pro', SEEDREAM_PIXELS, 10),
  officialVideo('doubao-seedance-2-0-260128', 'Doubao Seedance 2.0', 15, ['480p', '720p', '1080p', '4k']),
  officialVideo('doubao-seedance-2-0-fast-260128', 'Doubao Seedance 2.0 Fast', 15, ['480p', '720p']),
  officialVideo('doubao-seedance-2-0-mini-260615', 'Doubao Seedance 2.0 Mini', 15, ['480p', '720p']),
  officialVideo('doubao-seedance-2-5-260628', 'Doubao Seedance 2.5', 30, ['480p', '720p', '1080p']),
  referenceVideo('sd-2.0-A', 15), referenceVideo('sd-2.5-A', 30),
  cVideo('sd-2.0-c1', 10, 3), cVideo('sd-2.0-c2', 4, 0),
];

const MODEL_BY_ID = new Map(RELAYON_MODEL_MANIFEST.map((model) => [model.id, model]));

/** 认证目录仅决定可用性；保留真实连接身份，合同取已核对快照，不接受猜测别名。 */
export function matchRelayonCatalog(models: readonly ProviderModelSelection[]): ProviderModelSelection[] {
  const seen = new Set<string>();
  return models.flatMap((remote) => {
    const known = MODEL_BY_ID.get(remote.id);
    if (!known || seen.has(remote.id)) return [];
    seen.add(remote.id);
    return [{ ...structuredClone(known), provider: remote.provider }];
  });
}

function comparableProtocol(profile: ModelExecutionProfile | undefined): string | undefined {
  try {
    const protocol = resolveModelExecutionProfile(profile);
    return protocol ? JSON.stringify(protocol, (_key, value: unknown) => (
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value
    )) : undefined;
  } catch {
    return undefined;
  }
}

/** 只转换完整命中的内置媒体合同；用户修改的协议不冒充厂商快照。 */
export function usesRelayonModelProtocol(modelId: string, profile: ModelExecutionProfile | undefined): boolean {
  const known = MODEL_BY_ID.get(modelId);
  if (!known || known.category === 'text') return false;
  const actual = comparableProtocol(profile);
  if (actual === undefined) return false;
  if (actual === comparableProtocol(known.executionProfile)) return true;
  if (known.category !== 'image' || !known.imageCapability?.qualities || !known.imageCapability.backgrounds) return false;
  // 上版普通 Flare／Sunburst 完整模板尚未映射 quality 和 background；其他字段必须全部一致。
  const previous = structuredClone(known.executionProfile!);
  const body = previous.protocol!.submit.body as Record<string, ProtocolJsonValue>;
  delete body.quality;
  delete body.background;
  return actual === comparableProtocol(previous);
}

/** 只为真实连接的完整新旧内置合同补临时能力；原配置、用户显式能力和自定义协议保持原值。 */
export function resolveRelayonImageModelContract(
  modelId: string, profile?: ModelExecutionProfile, capability?: ImageModelCapability,
): { executionProfile?: ModelExecutionProfile; imageCapability?: ImageModelCapability } {
  const known = MODEL_BY_ID.get(modelId);
  if (known?.category !== 'image' || !usesRelayonModelProtocol(modelId, profile)) {
    return { executionProfile: profile, imageCapability: capability };
  }
  const imageCapability = { ...structuredClone(known.imageCapability), ...structuredClone(capability) };
  // 缺少字段才添加兼容候选；显式缩窄过的候选及默认值不被覆盖。
  if (known.imageCapability?.qualities && capability?.qualities === undefined) {
    imageCapability.qualities = [...known.imageCapability.qualities];
  }
  if (known.imageCapability?.backgrounds && capability?.backgrounds === undefined) {
    imageCapability.backgrounds = [...known.imageCapability.backgrounds];
  }
  return { executionProfile: structuredClone(known.executionProfile), imageCapability };
}

export function resolveRelayonImageExecutionProfile(
  modelId: string, profile: ModelExecutionProfile | undefined, referenceCount: number, imageBackground?: string,
): ModelExecutionProfile | undefined {
  if (!usesRelayonModelProtocol(modelId, profile) || MODEL_BY_ID.get(modelId)?.category !== 'image') return profile;
  const maximum = MODEL_BY_ID.get(modelId)!.imageCapability!.maxImageReferences!;
  if (!Number.isInteger(referenceCount) || referenceCount < 0 || referenceCount > maximum) {
    throw new Error(`RelayOnAPI 图片模型“${modelId}”最多接受 ${maximum} 张参考图`);
  }
  const result = resolveRelayonImageModelContract(modelId, profile).executionProfile!;
  result.protocol!.submit.path = referenceCount ? '/images/edits' : '/images/generations';
  if (imageBackground?.toLowerCase() === 'transparent' && MODEL_BY_ID.get(modelId)!.imageCapability?.backgrounds) {
    (result.protocol!.submit.body as Record<string, ProtocolJsonValue>).output_format = 'png';
  }
  return result;
}

function stringArray(variables: ModelProtocolVariables, name: string): string[] {
  const value = variables[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`RelayOnAPI 参数 ${name} 必须是非空字符串组成的数组`);
  }
  return value as string[];
}

function assertSingleResult(variables: ModelProtocolVariables): void {
  if (['n', 'batchCount'].some((key) => variables[key] !== undefined && variables[key] !== 1)) {
    throw new Error('RelayOnAPI 每次生成仅提交一个结果，请将生成数量设为 1');
  }
}

/** 同一份像素快照同时决定 size、resolution 与 aspect_ratio，不静默改付费档位。 */
export function relayonImageVariables(modelId: string, variables: ModelProtocolVariables): ModelProtocolVariables {
  const capability = MODEL_BY_ID.get(modelId)?.imageCapability;
  if (!capability) throw new Error(`RelayOnAPI 图片模型“${modelId}”尚未适配`);
  assertSingleResult(variables);
  const urls = stringArray(variables, 'imageUrls');
  if (urls.length > capability.maxImageReferences!) throw new Error(`RelayOnAPI 图片模型“${modelId}”最多接受 ${capability.maxImageReferences} 张参考图`);
  for (const url of urls) {
    if (/^https:\/\//i.test(url)) continue;
    const data = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
    if (!data) throw new Error('RelayOnAPI 参考图仅支持 HTTPS 或 PNG、JPEG、WebP 的 Base64 data URI');
    const encoded = data[1].replace(/\s/g, '');
    const bytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (bytes > 20 * 1024 * 1024) throw new Error('RelayOnAPI 单张参考图不能超过 20 MiB');
  }
  const resolution = capability.resolutions!.find((value) => value.toLowerCase() === String(variables.imageSize ?? capability.defaultResolution).toLowerCase());
  const ratio = typeof variables.aspectRatio === 'string' ? variables.aspectRatio : capability.defaultRatio!;
  const dimensions = resolution && capability.dimensionPresets![resolution]?.[ratio];
  if (!dimensions) throw new Error(`RelayOnAPI 图片参数 ${String(variables.imageSize)} / ${ratio} 没有已公布的像素尺寸`);
  const size = `${dimensions[0]}x${dimensions[1]}`;
  if (variables.size !== undefined && variables.size !== size) throw new Error('RelayOnAPI 图片 size 与所选分辨率、比例不一致');
  return { ...variables, imageSize: resolution, aspectRatio: ratio, size, width: dimensions[0], height: dimensions[1],
    imageUrls: urls.length ? urls : undefined };
}

/** 普通参考按类别原序传递；C1 转换为 @图／视频／音频编号，C2 保留图片／音频编号。 */
export function relayonVideoVariables(modelId: string, variables: ModelProtocolVariables): ModelProtocolVariables {
  const capability = MODEL_BY_ID.get(modelId)?.videoCapability;
  if (!capability) throw new Error(`RelayOnAPI 视频模型“${modelId}”尚未适配`);
  assertSingleResult(variables);
  if (variables.firstImage || variables.lastImage || variables.videoInputMode === 'keyframe' || variables.videoInputMode === 'mixed') {
    throw new Error('RelayOnAPI 当前 JSON 合同未公布首尾帧字段，请改用普通参考素材');
  }
  const imageUrls = stringArray(variables, variables.referenceImageUrls === undefined ? 'imageUrls' : 'referenceImageUrls');
  const videoUrls = stringArray(variables, variables.referenceVideoUrls === undefined ? 'videoUrls' : 'referenceVideoUrls');
  const audioUrls = stringArray(variables, variables.referenceAudioUrls === undefined ? 'audioUrls' : 'referenceAudioUrls');
  for (const [label, urls, maximum] of [
    ['参考图', imageUrls, capability.maxImageReferences], ['参考视频', videoUrls, capability.maxVideoReferences],
    ['参考音频', audioUrls, capability.maxAudioReferences],
  ] as const) {
    if (maximum !== undefined && urls.length > maximum) throw new Error(`RelayOnAPI 模型“${modelId}”最多接受 ${maximum} 个${label}`);
  }
  if (audioUrls.length && !imageUrls.length && !videoUrls.length && capability.supportsStandaloneAudio === false) {
    throw new Error('RelayOnAPI 当前应用接入尚未开放仅使用参考音频生成视频，请同时提供图片或视频参考');
  }
  let prompt = variables.prompt;
  if (modelId === 'sd-2.0-c1') {
    const counts: Record<string, number> = { 图片: imageUrls.length, 视频: videoUrls.length, 音频: audioUrls.length };
    if (typeof prompt === 'string') prompt = prompt.replace(/@?(图片|视频|音频)(\d+)/gu, (label, kind: string, index: string) => (
      Number(index) >= 1 && Number(index) <= counts[kind] ? `@${kind === '图片' ? '图' : kind}${index}` : label
    ));
  }
  return { ...variables, prompt,
    referenceImageUrls: imageUrls.length ? imageUrls : undefined,
    referenceVideoUrls: videoUrls.length ? videoUrls : undefined,
    referenceAudioUrls: audioUrls.length ? audioUrls : undefined };
}
