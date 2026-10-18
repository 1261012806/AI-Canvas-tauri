/**
 * ComfyUI 历史输出的结构与取件地址拼接。
 *
 * 正常生成（comfyWorkflowService）和重启后的恢复轮询（pollManager）解析的是
 * 同一份 /history 输出，这里是两条路径共用的唯一定义，避免各自复制一份后跑偏。
 */

export interface ComfyOutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface ComfyOutputNode {
  images?: ComfyOutputFile[];
  videos?: ComfyOutputFile[];
  gifs?: ComfyOutputFile[];
  /** 内置 SaveAudio / PreviewAudio 用的是单数 audio，只有部分自定义节点写 audios */
  audio?: ComfyOutputFile[];
  audios?: ComfyOutputFile[];
  [key: string]: unknown;
}

export type ComfyOutputs = Record<string, ComfyOutputNode>;

export type ComfyOutputKind = 'image' | 'video' | 'audio';

/** 各类媒体的已知键名，单复数都收 —— 内置节点与自定义节点命名并不统一 */
const OUTPUT_KEYS: Record<ComfyOutputKind, string[]> = {
  image: ['images', 'image'],
  video: ['videos', 'video', 'gifs'],
  audio: ['audio', 'audios'],
};

/** 键名不认识时按扩展名兜底认领 */
const OUTPUT_EXTENSIONS: Record<ComfyOutputKind, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'bmp'],
  video: ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi'],
  audio: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'],
};

function toOutputFiles(value: unknown): ComfyOutputFile[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ComfyOutputFile =>
      !!item && typeof item === 'object' && typeof (item as ComfyOutputFile).filename === 'string',
  );
}

/** 从单个节点输出里取某类媒体：先认已知键名，认不出再按扩展名扫描其余键 */
function pickFromNode(node: ComfyOutputNode, kind: ComfyOutputKind, outputOnly = false): ComfyOutputFile | null {
  const extensions = OUTPUT_EXTENSIONS[kind];
  const hasMatchingExtension = (file: ComfyOutputFile) => extensions.includes(file.filename.split('.').pop()?.toLowerCase() ?? '');
  const accepts = (file: ComfyOutputFile) => (!outputOnly || !file.type || file.type === 'output')
    && (kind !== 'video' || hasMatchingExtension(file));
  for (const key of OUTPUT_KEYS[kind]) {
    const file = toOutputFiles(node[key]).find(accepts);
    if (file) return file;
  }
  for (const value of Object.values(node)) {
    const file = toOutputFiles(value).find((item) => accepts(item) && hasMatchingExtension(item));
    if (file) return file;
  }
  return null;
}

/**
 * 按给定媒体类型的优先级，在全部节点输出里找第一个可用文件。
 * 找不到返回 null，调用方据此判断「还没出结果」。
 */
export function findComfyOutputFile(
  outputs: ComfyOutputs,
  kinds: ComfyOutputKind[],
): ComfyOutputFile | null {
  for (const kind of kinds) {
    // 视频先找正式输出，再兼容只有临时预览的工作流，避免前置 Preview 抢走成片。
    for (const outputOnly of kind === 'video' ? [true, false] : [false]) {
      for (const node of Object.values(outputs)) {
        if (!node || typeof node !== 'object') continue;
        const file = pickFromNode(node, kind, outputOnly);
        if (file) return file;
      }
    }
  }
  return null;
}

/** 把 /history 输出里的文件拼成可直接下载的 /view 地址。 */
export function buildComfyFileUrl(baseUrl: string, file: ComfyOutputFile): string {
  const subfolder = file.subfolder ? `&subfolder=${encodeURIComponent(file.subfolder)}` : '';
  const type = file.type ? `&type=${encodeURIComponent(file.type)}` : '&type=output';
  return `${baseUrl}/view?filename=${encodeURIComponent(file.filename)}${subfolder}${type}`;
}

/** 找到目标媒体就拼成 /view 地址，没找到返回 null（表示还没出结果）。 */
export function resolveComfyOutputUrl(
  baseUrl: string,
  outputs: ComfyOutputs,
  kinds: ComfyOutputKind[],
): { url: string } | null {
  const file = findComfyOutputFile(outputs, kinds);
  return file ? { url: buildComfyFileUrl(baseUrl, file) } : null;
}
