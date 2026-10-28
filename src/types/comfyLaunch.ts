export type ComfyMemorySwitch = 'auto' | 'enabled' | 'disabled';
export type ComfyH3MemoryPreset = 'off' | 'safe12' | 'custom';
export type ComfyH3MemoryOverride = 'inherit' | 'off' | 'safe12';

/** 仅作用于已识别 H3 的本次执行副本；不替换模型或调整输出分辨率。 */
export interface ComfyH3MemorySettings {
  preset: ComfyH3MemoryPreset;
  attentionHeadChunks: number;
  feedForwardChunks: number;
  feedForwardThreshold: number;
  textEncoderDevice: 'auto' | 'cpu';
  /** 0 保持原工作流；其余值限制参考图片长边。 */
  referenceImageMaxSize: number;
  vaeTiling: boolean;
  vaeTileSize: number;
  vaeTemporalSize: number;
}

/** 上次已提交任务的应用回执，仅含固定选项，不保存地址、文件或提示词。 */
export interface ComfyH3MemoryApplication {
  workflowId?: string;
  preset: 'safe12' | 'custom';
  settings: ComfyH3MemorySettings;
  applied: ('attention' | 'feedForward' | 'textEncoderCpu' | 'referenceImages' | 'vaeTiling')[];
}

export const DEFAULT_COMFY_H3_MEMORY_SETTINGS: ComfyH3MemorySettings = {
  preset: 'off',
  attentionHeadChunks: 4,
  feedForwardChunks: 2,
  feedForwardThreshold: 4096,
  textEncoderDevice: 'cpu',
  referenceImageMaxSize: 512,
  vaeTiling: true,
  vaeTileSize: 256,
  vaeTemporalSize: 16,
};

/** 本地 ComfyUI 启动选项；仅映射原生白名单参数，不接受脚本或任意命令行。 */
export interface ComfyUILaunchSettings {
  port: number;
  vramMode: 'auto' | 'high' | 'normal' | 'low' | 'no' | 'cpu';
  /** 仅覆盖扩散模型精度，VAE 与文本编码器沿用 ComfyUI 默认配置。 */
  precision: 'auto' | 'fp16' | 'bf16' | 'fp32';
  attention: 'auto' | 'pytorch' | 'split' | 'quad';
  /** auto 保留安装版本默认值，其余选项显式指定预览方式。 */
  previewMethod: 'auto' | 'none' | 'latent2rgb' | 'taesd';
  disableSmartMemory: boolean;
  dynamicVram: ComfyMemorySwitch;
  reserveVramGb: number | null;
  asyncOffload: ComfyMemorySwitch;
  asyncOffloadStreams: number;
  h3Memory: ComfyH3MemorySettings;
}

export const DEFAULT_COMFY_LAUNCH_SETTINGS: ComfyUILaunchSettings = {
  port: 8188,
  vramMode: 'auto',
  precision: 'auto',
  attention: 'auto',
  previewMethod: 'auto',
  disableSmartMemory: false,
  dynamicVram: 'auto',
  reserveVramGb: null,
  asyncOffload: 'auto',
  asyncOffloadStreams: 2,
  h3Memory: { ...DEFAULT_COMFY_H3_MEMORY_SETTINGS },
};

const integerIn = (value: number, min: number, max: number, step = 1) =>
  Number.isInteger(value) && value >= min && value <= max && value % step === 0;

export function isValidComfyH3MemorySettings(settings: ComfyH3MemorySettings): boolean {
  return !!settings && ['off', 'safe12', 'custom'].includes(settings.preset)
    && integerIn(settings.attentionHeadChunks, 1, 56)
    && integerIn(settings.feedForwardChunks, 1, 64)
    && integerIn(settings.feedForwardThreshold, 256, 262144, 256)
    && ['auto', 'cpu'].includes(settings.textEncoderDevice)
    && (settings.referenceImageMaxSize === 0 || integerIn(settings.referenceImageMaxSize, 64, 2048, 64))
    && typeof settings.vaeTiling === 'boolean'
    && integerIn(settings.vaeTileSize, 128, 2048, 64)
    && integerIn(settings.vaeTemporalSize, 8, 128, 4);
}

export function isValidComfyLaunchSettings(settings: ComfyUILaunchSettings): boolean {
  const switches = ['auto', 'enabled', 'disabled'];
  return integerIn(settings.port, 1024, 65535)
    && ['auto', 'high', 'normal', 'low', 'no', 'cpu'].includes(settings.vramMode)
    && ['auto', 'fp16', 'bf16', 'fp32'].includes(settings.precision)
    && ['auto', 'pytorch', 'split', 'quad'].includes(settings.attention)
    && ['auto', 'none', 'latent2rgb', 'taesd'].includes(settings.previewMethod)
    && typeof settings.disableSmartMemory === 'boolean'
    && switches.includes(settings.dynamicVram) && switches.includes(settings.asyncOffload)
    && (settings.reserveVramGb === null || integerIn(settings.reserveVramGb, 0, 64))
    && integerIn(settings.asyncOffloadStreams, 1, 4)
    && !(settings.dynamicVram === 'enabled' && ['high', 'no', 'cpu'].includes(settings.vramMode))
    && isValidComfyH3MemorySettings(settings.h3Memory);
}

export function isValidComfyH3MemoryApplication(value: unknown): value is ComfyH3MemoryApplication {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as ComfyH3MemoryApplication;
  return (receipt.preset === 'safe12' || receipt.preset === 'custom')
    && isValidComfyH3MemorySettings(receipt.settings) && receipt.settings.preset === receipt.preset
    && (receipt.workflowId === undefined || typeof receipt.workflowId === 'string')
    && Array.isArray(receipt.applied) && receipt.applied.length <= 5
    && new Set(receipt.applied).size === receipt.applied.length
    && receipt.applied.every((key) => ['attention', 'feedForward', 'textEncoderCpu', 'referenceImages', 'vaeTiling'].includes(key));
}

/** 非安全用途的策略变化检测；固定字段顺序，不持久化完整配置。 */
export function comfyH3MemoryFingerprint(settings: ComfyH3MemorySettings | undefined): string {
  const value = settings ? JSON.stringify([settings.preset, settings.attentionHeadChunks, settings.feedForwardChunks,
    settings.feedForwardThreshold, settings.textEncoderDevice, settings.referenceImageMaxSize,
    settings.vaeTiling, settings.vaeTileSize, settings.vaeTemporalSize]) : 'off';
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16);
}
