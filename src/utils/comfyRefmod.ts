import type {
  ComfyRefmodAsset,
  ComfyRefmodFileRef,
  ComfyRefmodLoaderType,
  ComfyRefmodSelection,
} from '../types/comfyRefmod';

export const COMFY_REFMOD_MIME = 'application/x-ai-canvas-comfy-refmod';
const LOADER_TYPES = new Set<ComfyRefmodLoaderType>(['minimax-h3', 'refmods-lab', 'h3-refmods']);

export function isComfyRefmodControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 31 || code === 127;
}

export function isComfyRefmodFileName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !value.includes(':') && !Array.from(value).some(isComfyRefmodControlCharacter)
    && !/^[\\/]/.test(value)
    && !value.split(/[\\/]/).some((part) => !part || part === '.' || part === '..');
}

export function comfyRefmodKey(ref: ComfyRefmodFileRef): string {
  return JSON.stringify([ref.serverId ?? null, ref.endpointFingerprint, ref.loaderType, ref.fileName]);
}

function fileRef(value: unknown): ComfyRefmodFileRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ref = value as Record<string, unknown>;
  if (!isComfyRefmodFileName(ref.fileName)
    || typeof ref.endpointFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(ref.endpointFingerprint)
    || !LOADER_TYPES.has(ref.loaderType as ComfyRefmodLoaderType)
    || (ref.serverId !== undefined && (typeof ref.serverId !== 'string' || !ref.serverId || ref.serverId.length > 256))) return null;
  return {
    ...(typeof ref.serverId === 'string' ? { serverId: ref.serverId } : {}),
    endpointFingerprint: ref.endpointFingerprint,
    loaderType: ref.loaderType as ComfyRefmodLoaderType,
    fileName: ref.fileName,
  };
}

/** 白名单清洗，不把目录接口或拖放负载中的 path/config 等额外字段带入持久化。 */
export function normalizeComfyRefmodSelections(value: unknown): ComfyRefmodSelection[] {
  if (!Array.isArray(value)) return [];
  const selections: ComfyRefmodSelection[] = [];
  for (const raw of value.slice(0, 100)) {
    const ref = fileRef(raw);
    if (!ref) continue;
    const source = raw as Record<string, unknown>;
    if (typeof source.strength !== 'number' || !Number.isFinite(source.strength)
      || source.strength < 0 || source.strength > 10) continue;
    const loaderNodeId = typeof source.loaderNodeId === 'string' && /^[\w:.-]{1,128}$/.test(source.loaderNodeId)
      ? source.loaderNodeId : undefined;
    const slot = typeof source.slot === 'number' && Number.isInteger(source.slot) && source.slot >= 1 && source.slot <= 100
      ? source.slot : undefined;
    const workflowId = typeof source.workflowId === 'string' && /^[\w:.-]{1,256}$/.test(source.workflowId) ? source.workflowId : undefined;
    const originalFileName = source.originalFileName === '' || isComfyRefmodFileName(source.originalFileName) ? source.originalFileName : undefined;
    selections.push({ ...ref, strength: source.strength,
      ...(loaderNodeId ? { loaderNodeId } : {}), ...(slot !== undefined ? { slot } : {}),
      ...(workflowId ? { workflowId } : {}), ...(originalFileName !== undefined ? { originalFileName } : {}),
      ...(source.replaceExisting === true && loaderNodeId && slot !== undefined ? { replaceExisting: true } : {}),
    });
  }
  return selections;
}

export function normalizeComfyRefmodAssets(value: unknown): ComfyRefmodAsset[] {
  if (!Array.isArray(value)) return [];
  const entries = new Map<string, ComfyRefmodAsset>();
  for (const raw of value.slice(0, 5000)) {
    const ref = fileRef(raw);
    if (!ref) continue;
    const source = raw as Record<string, unknown>;
    const key = comfyRefmodKey(ref);
    entries.set(key, { ...ref, id: key,
      name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, 200) : ref.fileName,
      tags: Array.isArray(source.tags) ? [...new Set(source.tags.filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, 24) : [],
      ...(typeof source.description === 'string' ? { description: source.description.slice(0, 2000) } : {}),
      ...(typeof source.kind === 'string' ? { kind: source.kind.slice(0, 40) } : {}),
      ...(typeof source.tokens === 'number' && Number.isFinite(source.tokens) && source.tokens >= 0 ? { tokens: source.tokens } : {}),
      updatedAt: typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt) ? source.updatedAt : 0,
    });
  }
  return [...entries.values()];
}

/** 角色卡关联不携带某一工作流的槽位或覆盖授权。 */
export function normalizeCharacterRefmods(value: unknown): ComfyRefmodSelection[] {
  const refs = new Map<string, ComfyRefmodSelection>();
  for (const selection of normalizeComfyRefmodSelections(value)) {
    const reference: ComfyRefmodSelection = {
      ...(selection.serverId !== undefined ? { serverId: selection.serverId } : {}),
      endpointFingerprint: selection.endpointFingerprint, loaderType: selection.loaderType,
      fileName: selection.fileName, strength: selection.strength,
    };
    refs.set(comfyRefmodKey(reference), reference);
  }
  return [...refs.values()].slice(0, 16);
}
