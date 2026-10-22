import type { ComfyRefmodSelection } from '../types/comfyRefmod';
import { comfyRefmodKey, isComfyRefmodControlCharacter, normalizeComfyRefmodSelections } from './comfyRefmod';

const PREFIX = '@refmod{';
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_MENTIONS = 100;

export interface ComfyRefmodMention {
  token: string;
  label: string;
  selection: ComfyRefmodSelection;
}

/** 普通文本/图像/音频及远端工作流不能透传本地角色模型身份。 */
export function assertNoComfyRefmodMentions(text: string): void {
  if (text.includes('@refmod')) throw new Error('ComfyUI 角色引用仅支持本地 ComfyUI 视频工作流，请移除引用后再使用其他模型');
}

function selection(value: unknown, mapped: boolean): ComfyRefmodSelection {
  const normalized = normalizeComfyRefmodSelections([value])[0];
  if (!normalized || (mapped && (!normalized.workflowId || !normalized.loaderNodeId || normalized.slot === undefined
    || normalized.originalFileName === undefined))) {
    throw new Error('ComfyUI 角色引用缺少有效的服务器或工作流槽位，请重新 @ 选择');
  }
  const raw = value as Record<string, unknown>;
  for (const key of ['loaderNodeId', 'slot', 'workflowId', 'originalFileName'] as const) {
    if (raw[key] !== undefined && raw[key] !== normalized[key]) throw new Error('ComfyUI 角色引用的槽位信息无效，请重新选择');
  }
  return normalized;
}

/** 自包含的引用只保存白名单相对文件身份；提示词就是该引用的生命周期。 */
export function buildComfyRefmodMention(ref: ComfyRefmodSelection, label: string): string {
  const normalized = selection(ref, true);
  if (typeof label !== 'string') throw new Error('ComfyUI 角色引用名称无效');
  const display = (Array.from(label.trim(), (character) => isComfyRefmodControlCharacter(character) ? ' ' : character).join('') || normalized.fileName).slice(0, 200);
  const token = `${PREFIX}${encodeURIComponent(JSON.stringify({ v: 1, ref: normalized, label: display }))}}`;
  if (token.length > MAX_TOKEN_LENGTH) throw new Error('ComfyUI 角色引用过长，请缩短文件名或显示名称');
  return token;
}

/** 严格解析；未闭合、伪造或超限标记不得作为普通文字泄漏给其他模型。 */
export function parseComfyRefmodMentions(text: string): {
  refs: ComfyRefmodSelection[];
  prompt: string;
  mentions: ComfyRefmodMention[];
} {
  const mentions: ComfyRefmodMention[] = [];
  const parts: string[] = [];
  let cursor = 0;
  while (true) {
    const start = text.indexOf('@refmod', cursor);
    if (start < 0) break;
    if (!text.startsWith(PREFIX, start)) throw new Error('ComfyUI 角色引用格式无效，请删除后重新 @ 选择');
    const end = text.indexOf('}', start + PREFIX.length);
    if (end < 0) throw new Error('ComfyUI 角色引用未完整，请删除后重新 @ 选择');
    const token = text.slice(start, end + 1);
    if (token.length > MAX_TOKEN_LENGTH || mentions.length >= MAX_MENTIONS) throw new Error('ComfyUI 角色引用过长或超过 100 项，请减少引用');
    let payload: unknown;
    try { payload = JSON.parse(decodeURIComponent(token.slice(PREFIX.length, -1))) as unknown; }
    catch { throw new Error('ComfyUI 角色引用损坏，请删除后重新 @ 选择'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('ComfyUI 角色引用格式无效');
    const data = payload as Record<string, unknown>;
    if (data.v !== 1 || typeof data.label !== 'string' || !data.label.trim() || data.label.length > 200
      || Array.from(data.label).some(isComfyRefmodControlCharacter)) throw new Error('ComfyUI 角色引用版本或名称无效，请重新选择');
    const ref = selection(data.ref, true);
    mentions.push({ token, label: data.label, selection: ref });
    parts.push(text.slice(cursor, start), ' ');
    cursor = end + 1;
  }
  parts.push(text.slice(cursor));
  return { refs: mentions.map((mention) => mention.selection), prompt: parts.join(''), mentions };
}

/** 同槽完全相同的引用只发一次；手工绑定和提示词不能互相覆盖。 */
export function mergeComfyRefmodSelections(
  manual: readonly ComfyRefmodSelection[] = [],
  mentioned: readonly ComfyRefmodSelection[] = [],
): ComfyRefmodSelection[] {
  if (!Array.isArray(manual) || !Array.isArray(mentioned)) throw new Error('RefMod 绑定格式无效，请重新选择');
  if (manual.length > MAX_MENTIONS || mentioned.length > MAX_MENTIONS) throw new Error('RefMod 绑定超过 100 项，请减少引用');
  const merged = new Map<string, ComfyRefmodSelection>();
  for (const ref of [...manual, ...mentioned]) {
    const normalized = selection(ref, false);
    const key = normalized.loaderNodeId !== undefined && normalized.slot !== undefined
      ? JSON.stringify([normalized.loaderNodeId, normalized.slot])
      : `file:${comfyRefmodKey(normalized)}`;
    const previous = merged.get(key);
    if (previous) {
      const { replaceExisting: _previousReplace, ...previousIdentity } = previous;
      const { replaceExisting: _nextReplace, ...nextIdentity } = normalized;
      if (JSON.stringify(previousIdentity) !== JSON.stringify(nextIdentity)) {
        throw new Error('同一 RefMod 槽位存在不同的角色或强度，请移除冲突引用后重新选择');
      }
      // 手工绑定优先；提示词中的覆盖授权不能提升另一条绑定的权限。
      continue;
    }
    merged.set(key, normalized);
    if (merged.size > MAX_MENTIONS) throw new Error('RefMod 绑定超过 100 项，请减少引用');
  }
  return [...merged.values()];
}

/** 每个提交入口共用：提取全部文本输入中的引用，剥离后才走媒体/厂商解析。 */
export function resolveComfyRefmodMentionInputs(input: {
  prompt: string;
  workflowInputs?: Record<string, string>;
  manual?: readonly ComfyRefmodSelection[];
}): { prompt: string; workflowInputs?: Record<string, string>; comfyRefmods: ComfyRefmodSelection[] } {
  const parsed = parseComfyRefmodMentions(input.prompt);
  const refs = [...parsed.refs];
  let workflowInputs: Record<string, string> | undefined;
  if (input.workflowInputs) {
    const fields: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(input.workflowInputs)) {
      if (typeof value !== 'string') { fields.push([key, value]); continue; }
      const field = parseComfyRefmodMentions(value);
      fields.push([key, field.prompt]);
      refs.push(...field.refs);
      if (refs.length > MAX_MENTIONS) throw new Error('ComfyUI 角色引用超过 100 项，请减少引用');
    }
    workflowInputs = Object.fromEntries(fields);
  }
  return { prompt: parsed.prompt, workflowInputs, comfyRefmods: mergeComfyRefmodSelections(input.manual, refs) };
}
