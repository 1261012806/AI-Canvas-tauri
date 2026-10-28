import type { DramaAsset, DramaAssetCategory, DramaCharacter } from '../types/dramaAssets';
import { MAX_CHARACTER_WEAPONS, MAX_DRAMA_REFERENCE_IMAGES, normalizeCharacterWeaponIds } from '../types/dramaAssets';
import { localMediaUrlToPath } from '../utils/mediaUrl';
import { expandCharacterWeaponDependencies, remapCharacterWeaponIds } from './characterWeapons';

export const DRAMA_ASSET_TRANSFER_FORMAT = 'ai-canvas-creative-assets';
export const DRAMA_ASSET_TRANSFER_VERSION = 1;
export const DRAMA_ASSET_TRANSFER_LIMITS = {
  assets: 500, media: 5000, manifestBytes: 16 * 1024 * 1024, textBytes: 64 * 1024,
  nestedItems: 1000, mediaBytes: 20 * 1024 * 1024 * 1024,
} as const;

export interface DramaAssetTransferMedia {
  id: string;
  kind: 'image' | 'audio' | 'video';
  path: string;
  bytes: number;
  sha256: string;
}

export interface DramaAssetTransferDocument {
  format: typeof DRAMA_ASSET_TRANSFER_FORMAT;
  version: typeof DRAMA_ASSET_TRANSFER_VERSION;
  exportedAt: number;
  name: string;
  assets: DramaAsset[];
  media: DramaAssetTransferMedia[];
}

export interface ImportedDramaAssetMedia {
  assetId: string;
  relativePath: string;
  url: string;
}

export interface DramaAssetIdentity { kind: DramaAsset['kind']; id: string }
export interface DramaAssetImportPreview {
  name: string;
  items: Array<DramaAssetIdentity & { name: string; category?: DramaAssetCategory; weaponIds?: string[]; mediaIds: string[]; sameName: boolean }>;
  media: Array<Pick<DramaAssetTransferMedia, 'id' | 'kind' | 'bytes'>>;
}

type Data = Record<string, unknown>;
type MediaKind = DramaAssetTransferMedia['kind'];
const BASE_KEYS = ['id', 'kind', 'name', 'key', 'summary', 'visualNotes', 'storyRole', 'importance', 'firstSeen',
  'appearances', 'imageUrl', 'confirmed', 'createdAt', 'updatedAt', 'source'];
const CHARACTER_KEYS = ['libraryOrder', 'aliases', 'identity', 'ageBand', 'gender', 'personality', 'relationships',
  'wardrobeDefault', 'voiceNotes', 'referenceImages', 'primaryReferenceImageId', 'avatarReferenceImageId', 'avatarCrop',
  'voiceClips', 'primaryVoiceClipId', 'actions', 'weaponIds'];
const VISUAL_KEYS = ['referenceImages', 'primaryReferenceImageId'];
const SCENE_KEYS = ['placeType', 'timeOfDay', 'atmosphere', 'spatialNotes'];
const PROP_KEYS = ['ownerName', 'category', 'significance', 'propType'];
const VISUAL_REFERENCE_KEYS = ['id', 'label', 'imageUrl', 'prompt', 'createdAt', 'updatedAt'];
const REFERENCE_KEYS = ['id', 'kind', 'imageUrl', 'prompt', 'createdAt', 'updatedAt'];
const VOICE_KEYS = ['id', 'kind', 'label', 'audioUrl', 'transcript', 'durationSec', 'createdAt', 'updatedAt'];
const ACTION_KEYS = ['id', 'category', 'customCategory', 'name', 'prompt', 'media', 'createdAt', 'updatedAt'];
const ACTION_MEDIA_KEYS = ['id', 'kind', 'name', 'mimeType', 'url', 'createdAt', 'updatedAt'];
const ACTION_CATEGORIES = ['standing', 'walking', 'running', 'jumping', 'sitting', 'crouching', 'lying', 'climbing',
  'swimming', 'attacking', 'defending', 'hit', 'death', 'casting', 'interacting', 'dancing', 'expression', 'custom'];
const encoder = new TextEncoder();

function invalid(detail: string): never { throw new Error(`创作资产包无效：${detail}`); }

function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('记录必须是普通对象');
  return value as Data;
}

function keys(value: Data, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid('包含不支持的字段');
}

function pick(value: unknown, allowed: readonly string[]): Data {
  const source = object(value);
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function list(value: unknown, max: number = DRAMA_ASSET_TRANSFER_LIMITS.nestedItems): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid('条目数量超过限制或不是数组');
  return value;
}

function string(value: unknown, nonempty = false): string {
  if (typeof value !== 'string' || encoder.encode(value).byteLength > DRAMA_ASSET_TRANSFER_LIMITS.textBytes
    || value.includes('\0') || (nonempty && !value.trim())) invalid('文本为空、损坏或超过限制');
  return value;
}

function id(value: unknown): string {
  const result = string(value, true);
  if (result.length > 256 || hasControlCharacter(result)) invalid('ID 无效');
  return result;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function number(value: unknown, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
    || (integer && !Number.isSafeInteger(value))) invalid('数值无效');
  return value;
}

function choice(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid('类型或枚举值不受支持');
  return value;
}

/** 迁移文本保留可读标签，旧项目中的引用不会在新项目激活。 */
export function detachDramaAssetTransferMentions(value: string): string {
  const decode = (text: string) => { try { return decodeURIComponent(text); } catch { return text; } };
  return value
    .replace(/@asset\{([^}]*)\}/g, (_, path: string) => decode(path).split(/[\\/]/).filter(Boolean).pop() || '素材')
    .replace(/@(?:drama)?\{[^:}]*:([^}]*)\}/g, '$1')
    .replace(/@wf\{[^|}]*\|([^|}]*)\|[^}]*\}/g, '$1')
    .replace(/@(?:skill|model|image)\{[^|}]*\|([^}]*)\}/g, (_, label: string) => decode(label))
    .replace(/@refmod\{([^}]*)\}/g, (_, encoded: string) => {
      try { const payload = object(JSON.parse(decode(encoded))); return typeof payload.label === 'string' ? payload.label : '角色参考包'; }
      catch { return '角色参考包'; }
    })
    .replace(/@(?=(?:asset|drama|wf|refmod|skill|model|image)?\{)/g, '＠');
}

function textFields(value: Data, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) value[key] = text(value[key]);
  for (const key of optional) if (value[key] !== undefined) value[key] = text(value[key]);
}

function text(value: unknown, nonempty = false): string {
  return string(detachDramaAssetTransferMentions(string(value, nonempty)), nonempty);
}

function times(value: Data): void {
  value.createdAt = number(value.createdAt, true);
  value.updatedAt = number(value.updatedAt, true);
}

function unique(values: Data[]): void {
  const ids = new Set<string>();
  for (const value of values) {
    const next = id(value.id);
    if (ids.has(next)) invalid('存在重复 ID');
    ids.add(next);
  }
}

function path(value: unknown): string {
  const result = string(value, true);
  if (result.length > 1024 || /[\\<>:"|?*]/.test(result) || hasControlCharacter(result)
    || result.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) invalid('媒体路径不安全');
  return result;
}

function mediaToken(value: unknown): string {
  const match = /^aicasset-media:([a-zA-Z0-9_-]{1,128})$/.exec(string(value, true));
  if (!match) invalid('媒体必须使用包内引用');
  return match[1];
}

interface ReadContext { media: ReadonlyMap<string, MediaKind | undefined>; used: Set<string> }

function mediaField(value: Data, field: string, expected: MediaKind, context: ReadContext, required = false): void {
  if (value[field] === undefined && !required) return;
  const token = mediaToken(value[field]);
  if (!context.media.has(token)) invalid('媒体引用不存在');
  const kind = context.media.get(token);
  if (kind !== undefined && kind !== expected) invalid('媒体类型与绑定用途不符');
  context.used.add(token);
}

function readMember(value: unknown, allowed: readonly string[]): Data {
  const record = { ...object(value) };
  keys(record, allowed); record.id = id(record.id); times(record);
  return record;
}

function readAssets(value: unknown, context: ReadContext): DramaAsset[] {
  const assets = list(value, DRAMA_ASSET_TRANSFER_LIMITS.assets).map((input) => {
    const asset = { ...object(input) };
    const kind = choice(asset.kind, ['character', 'scene', 'prop']);
    keys(asset, [...BASE_KEYS, ...(kind === 'character' ? CHARACTER_KEYS : [...VISUAL_KEYS, ...(kind === 'scene' ? SCENE_KEYS : PROP_KEYS)])]);
    asset.id = id(asset.id); times(asset);
    textFields(asset, ['name', 'key', 'summary', 'visualNotes'], ['storyRole', 'firstSeen']);
    string(asset.name, true);
    choice(asset.importance, ['main', 'supporting', 'minor']); choice(asset.source, ['ai', 'manual', 'merge']);
    if (typeof asset.confirmed !== 'boolean') invalid('确认状态无效');
    if (asset.appearances !== undefined) asset.appearances = list(asset.appearances).map((item) => text(item));
    mediaField(asset, 'imageUrl', 'image', context);
    if (kind !== 'character') {
      textFields(asset, [], kind === 'scene' ? SCENE_KEYS : ['ownerName', 'category', 'significance']);
      if (kind === 'prop' && asset.propType !== undefined) choice(asset.propType, ['weapon']);
      if (asset.referenceImages !== undefined) {
        const references = list(asset.referenceImages, MAX_DRAMA_REFERENCE_IMAGES).map((item) => {
          const reference = readMember(item, VISUAL_REFERENCE_KEYS);
          textFields(reference, ['label', 'prompt']);
          mediaField(reference, 'imageUrl', 'image', context, true);
          return reference;
        });
        unique(references); asset.referenceImages = references;
        if (asset.primaryReferenceImageId !== undefined
          && !references.some((reference) => reference.id === id(asset.primaryReferenceImageId))) invalid('主参考图指针无效');
      } else if (asset.primaryReferenceImageId !== undefined) invalid('主参考图指针无效');
      return asset;
    }
    textFields(asset, ['identity'], ['ageBand', 'gender', 'personality', 'wardrobeDefault', 'voiceNotes']);
    if (asset.weaponIds !== undefined) {
      const weaponIds = list(asset.weaponIds, MAX_CHARACTER_WEAPONS).map(id);
      if (new Set(weaponIds).size !== weaponIds.length) invalid('武器绑定身份重复');
      if (normalizeCharacterWeaponIds(weaponIds).length !== weaponIds.length) invalid('武器绑定身份无效');
      asset.weaponIds = weaponIds;
    }
    if (asset.libraryOrder !== undefined) asset.libraryOrder = number(asset.libraryOrder);
    if (asset.aliases !== undefined) asset.aliases = list(asset.aliases).map((item) => text(item));
    if (asset.relationships !== undefined) asset.relationships = list(asset.relationships).map((item) => {
      const relation = { ...object(item) }; keys(relation, ['targetName', 'relation']);
      textFields(relation, ['targetName', 'relation']); return relation;
    });
    const references = asset.referenceImages === undefined ? [] : list(asset.referenceImages).map((item) => {
      const reference = readMember(item, REFERENCE_KEYS);
      choice(reference.kind, ['primary', 'avatar', 'full_body', 'expression', 'turnaround', 'outfit', 'other']);
      textFields(reference, ['prompt']); mediaField(reference, 'imageUrl', 'image', context, true); return reference;
    });
    const voices = asset.voiceClips === undefined ? [] : list(asset.voiceClips).map((item) => {
      const voice = readMember(item, VOICE_KEYS); choice(voice.kind, ['timbre', 'line', 'emotion', 'other']);
      textFields(voice, ['transcript'], ['label']); mediaField(voice, 'audioUrl', 'audio', context, true);
      if (voice.durationSec !== undefined && number(voice.durationSec) === 0) invalid('声音时长无效');
      return voice;
    });
    const actions = asset.actions === undefined ? [] : list(asset.actions).map((item) => {
      const action = readMember(item, ACTION_KEYS); choice(action.category, ACTION_CATEGORIES);
      textFields(action, ['name', 'prompt'], ['customCategory']); string(action.name, true);
      const media = action.media === undefined ? [] : list(action.media).map((entry) => {
        const result = readMember(entry, ACTION_MEDIA_KEYS); choice(result.kind, ['image', 'gif', 'video']);
        textFields(result, ['name']); string(result.name, true);
        if (result.mimeType !== undefined) string(result.mimeType);
        mediaField(result, 'url', result.kind === 'video' ? 'video' : 'image', context, true); return result;
      });
      unique(media); return { ...action, media };
    });
    unique(references); unique(voices); unique(actions);
    for (const [field, entries] of [['primaryReferenceImageId', references], ['avatarReferenceImageId', references], ['primaryVoiceClipId', voices]] as const) {
      if (asset[field] !== undefined && !entries.some((entry) => entry.id === id(asset[field]))) invalid('角色主素材指针无效');
    }
    if (asset.avatarCrop !== undefined) {
      if (!asset.avatarReferenceImageId) invalid('头像裁剪缺少对应参考图');
      const crop = { ...object(asset.avatarCrop) }; keys(crop, ['x', 'y', 'width', 'height']);
      for (const field of ['x', 'y', 'width', 'height']) if (number(crop[field]) > 1) invalid('头像裁剪超出图片');
      if (!crop.width || !crop.height || (crop.x as number) + (crop.width as number) > 1 + 1e-9
        || (crop.y as number) + (crop.height as number) > 1 + 1e-9) invalid('头像裁剪超出图片');
      asset.avatarCrop = crop;
    }
    return { ...asset, referenceImages: references, voiceClips: voices, actions };
  });
  if (!assets.length) invalid('没有创作资产');
  unique(assets);
  return assets as unknown as DramaAsset[];
}

function sanitizeAsset(asset: DramaAsset): Data {
  const result = pick(asset, [...BASE_KEYS, ...(asset.kind === 'character' ? CHARACTER_KEYS : [...VISUAL_KEYS, ...(asset.kind === 'scene' ? SCENE_KEYS : PROP_KEYS)])]);
  if (asset.kind !== 'character') {
    if (asset.referenceImages !== undefined) result.referenceImages = list(asset.referenceImages, MAX_DRAMA_REFERENCE_IMAGES).map((item) => pick(item, VISUAL_REFERENCE_KEYS));
    return result;
  }
  if (asset.relationships !== undefined) result.relationships = list(asset.relationships).map((item) => pick(item, ['targetName', 'relation']));
  if (asset.avatarCrop !== undefined) result.avatarCrop = pick(asset.avatarCrop, ['x', 'y', 'width', 'height']);
  if (asset.referenceImages !== undefined) result.referenceImages = list(asset.referenceImages).map((item) => pick(item, REFERENCE_KEYS));
  if (asset.voiceClips !== undefined) result.voiceClips = list(asset.voiceClips).map((item) => pick(item, VOICE_KEYS));
  if (asset.actions !== undefined) result.actions = list(asset.actions).map((item) => {
    const action = pick(item, ACTION_KEYS);
    if (action.media !== undefined) action.media = list(action.media).map((entry) => pick(entry, ACTION_MEDIA_KEYS));
    return action;
  });
  return result;
}

/** 导出调用方先收集真实媒体并替换 token；这里不读取 URL，也不导出本机运行期身份。 */
export function buildDramaAssetTransferDocument(input: {
  exportedAt: number; name: string; assets: readonly DramaAsset[]; media: readonly DramaAssetTransferMedia[];
}): DramaAssetTransferDocument {
  return parseDramaAssetTransferDocument({ format: DRAMA_ASSET_TRANSFER_FORMAT, version: DRAMA_ASSET_TRANSFER_VERSION,
    exportedAt: input.exportedAt, name: input.name, assets: input.assets.map(sanitizeAsset),
    media: input.media.map((entry) => pick(entry, ['id', 'kind', 'path', 'bytes', 'sha256'])) });
}

/** 外部格式失败关闭，不沿用应用持久化兼容器对未知字段或损坏数据的宽松归一化。 */
export function parseDramaAssetTransferDocument(input: unknown): DramaAssetTransferDocument {
  let value: unknown = input;
  try {
    if (typeof input === 'string') {
      if (encoder.encode(input).byteLength > DRAMA_ASSET_TRANSFER_LIMITS.manifestBytes) invalid('清单超过大小限制');
      value = JSON.parse(input);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('创作资产包无效')) throw error;
    invalid('清单不是有效 JSON');
  }
  const document = object(value); keys(document, ['format', 'version', 'exportedAt', 'name', 'assets', 'media']);
  if (document.format !== DRAMA_ASSET_TRANSFER_FORMAT || document.version !== DRAMA_ASSET_TRANSFER_VERSION) invalid('格式或版本不受支持');
  const exportedAt = number(document.exportedAt, true);
  const name = text(document.name, true);
  let totalBytes = 0;
  const paths = new Set<string>();
  const media = list(document.media, DRAMA_ASSET_TRANSFER_LIMITS.media).map((item) => {
    const entry = object(item); keys(entry, ['id', 'kind', 'path', 'bytes', 'sha256']);
    const mediaId = id(entry.id);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(mediaId)) invalid('媒体 ID 无效');
    const kind = choice(entry.kind, ['image', 'audio', 'video']) as MediaKind;
    const relative = path(entry.path); const pathKey = relative.normalize('NFC').toLowerCase();
    if (paths.has(pathKey)) invalid('存在重复媒体路径'); paths.add(pathKey);
    const bytes = number(entry.bytes, true); totalBytes += bytes;
    if (bytes === 0 || totalBytes > DRAMA_ASSET_TRANSFER_LIMITS.mediaBytes) invalid('媒体大小超过限制或为空');
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) invalid('媒体摘要无效');
    return { id: mediaId, kind, path: relative, bytes, sha256: entry.sha256.toLowerCase() };
  });
  unique(media);
  const context: ReadContext = { media: new Map(media.map((entry) => [entry.id, entry.kind])), used: new Set() };
  const assets = readAssets(document.assets, context);
  if (context.used.size !== media.length) invalid('清单包含未绑定的媒体');
  const result: DramaAssetTransferDocument = { format: DRAMA_ASSET_TRANSFER_FORMAT, version: DRAMA_ASSET_TRANSFER_VERSION, exportedAt, name, assets, media };
  if (encoder.encode(JSON.stringify(result)).byteLength > DRAMA_ASSET_TRANSFER_LIMITS.manifestBytes) invalid('清单超过大小限制');
  return result;
}

/** Only media-bearing fields participate; token-looking prose is not a dependency. */
export function getDramaAssetTransferMediaIds(asset: DramaAsset): string[] {
  const urls = [asset.imageUrl, ...(asset.referenceImages ?? []).map((reference) => reference.imageUrl)];
  if (asset.kind === 'character') {
    urls.push(...(asset.voiceClips ?? []).map((clip) => clip.audioUrl),
      ...(asset.actions ?? []).flatMap((action) => (action.media ?? []).map((media) => media.url)));
  }
  return [...new Set(urls.filter((url): url is string => url !== undefined).map(mediaToken))];
}

export function buildDramaAssetImportPreview(
  document: DramaAssetTransferDocument, existingAssets: readonly DramaAsset[] = [],
): DramaAssetImportPreview {
  expandCharacterWeaponDependencies(document.assets, document.assets);
  const nameKey = (asset: DramaAsset) => `${asset.kind === 'prop' && asset.propType === 'weapon' ? 'weapon' : asset.kind}:${asset.name.normalize('NFKC').trim().toLowerCase()}`;
  const existing = new Set(existingAssets.map(nameKey));
  const names = new Map<string, number>();
  for (const asset of document.assets) names.set(nameKey(asset), (names.get(nameKey(asset)) ?? 0) + 1);
  return { name: document.name,
    items: document.assets.map((asset) => ({ kind: asset.kind, id: asset.id, name: asset.name,
      category: asset.kind === 'prop' && asset.propType === 'weapon' ? 'weapon' : asset.kind,
      ...(asset.kind === 'character' && asset.weaponIds !== undefined ? { weaponIds: [...asset.weaponIds] } : {}),
      mediaIds: getDramaAssetTransferMediaIds(asset), sameName: existing.has(nameKey(asset)) || names.get(nameKey(asset))! > 1 })),
    media: document.media.map(({ id: mediaId, kind, bytes }) => ({ id: mediaId, kind, bytes })),
  };
}

/** The chooser cannot introduce identities or omit a selected asset's media. */
export function selectDramaAssetTransferDocument(
  document: DramaAssetTransferDocument, selection: readonly DramaAssetIdentity[],
): DramaAssetTransferDocument {
  const selected = new Set<string>();
  for (const item of list(selection, DRAMA_ASSET_TRANSFER_LIMITS.assets)) {
    const value = object(item); keys(value, ['kind', 'id']);
    const key = `${choice(value.kind, ['character', 'scene', 'prop'])}:${id(value.id)}`;
    if (selected.has(key) || !document.assets.some((asset) => `${asset.kind}:${asset.id}` === key)) invalid('所选资产身份无效');
    selected.add(key);
  }
  if (!selected.size) invalid('没有选择创作资产');
  const assets = expandCharacterWeaponDependencies(document.assets.filter((asset) => selected.has(`${asset.kind}:${asset.id}`)), document.assets);
  const used = new Set(assets.flatMap(getDramaAssetTransferMediaIds));
  return { ...document, assets, media: document.media.filter((media) => used.has(media.id)) };
}

/** 媒体已由宿主复制并重新索引；返回项目本地引用，不继承源机器或全局库的身份。 */
export function remapImportedAssets(
  assets: readonly DramaAsset[], mediaById: ReadonlyMap<string, ImportedDramaAssetMedia>,
  createId: () => string = () => crypto.randomUUID(),
): DramaAsset[] {
  const context: ReadContext = { media: new Map([...mediaById.keys()].map((key) => [key, undefined])), used: new Set() };
  const safeAssets = readAssets(assets, context);
  expandCharacterWeaponDependencies(safeAssets, safeAssets);
  const allocated = new Set(safeAssets.flatMap((asset) => [asset.id, ...(asset.referenceImages ?? []).map((reference) => reference.id), ...(asset.kind === 'character' ? [
    ...(asset.voiceClips ?? []).map((voice) => voice.id),
    ...(asset.actions ?? []).flatMap((action) => [action.id, ...(action.media ?? []).map((media) => media.id)]),
  ] : [])]));
  const allocate = () => {
    const next = id(createId());
    if (allocated.has(next)) invalid('新资产 ID 冲突'); allocated.add(next); return next;
  };
  const rootIds = new Map(safeAssets.map((asset) => [`${asset.kind}:${asset.id}`, allocate()]));
  const bind = (token: string | undefined, field: 'imageUrl' | 'audioUrl' | 'url'): Data => {
    if (token === undefined) return {};
    const target = mediaById.get(mediaToken(token));
    if (!target || !localMediaUrlToPath(target.url)) invalid('导入媒体没有本地文件');
    return { assetId: id(target.assetId), relativePath: path(target.relativePath), [field]: target.url };
  };
  return safeAssets.map((source) => {
    const asset = remapCharacterWeaponIds(source, rootIds);
    const next = { ...asset, ...bind(asset.imageUrl, 'imageUrl'), id: rootIds.get(`${asset.kind}:${asset.id}`)! };
    if (asset.kind !== 'character') {
      const referenceIds = new Map<string, string>();
      const referenceImages = (asset.referenceImages ?? []).map((reference) => {
        const nextId = allocate(); referenceIds.set(reference.id, nextId);
        return { ...reference, ...bind(reference.imageUrl, 'imageUrl'), id: nextId };
      });
      if (asset.referenceImages === undefined && asset.imageUrl) {
        const referenceId = allocate();
        referenceImages.push({ id: referenceId, label: '', prompt: '', ...bind(asset.imageUrl, 'imageUrl'),
          createdAt: asset.createdAt, updatedAt: asset.updatedAt });
      }
      return { ...next, kind: asset.kind, referenceImages,
        primaryReferenceImageId: asset.primaryReferenceImageId ? referenceIds.get(asset.primaryReferenceImageId) : referenceImages[0]?.id };
    }
    const character = asset as DramaCharacter;
    const referenceIds = new Map<string, string>(); const voiceIds = new Map<string, string>();
    const referenceImages = (character.referenceImages ?? []).map((reference) => {
      const nextId = allocate(); referenceIds.set(reference.id, nextId);
      return { ...reference, ...bind(reference.imageUrl, 'imageUrl'), id: nextId };
    });
    const voiceClips = (character.voiceClips ?? []).map((voice) => {
      const nextId = allocate(); voiceIds.set(voice.id, nextId);
      return { ...voice, ...bind(voice.audioUrl, 'audioUrl'), id: nextId };
    });
    const actions = (character.actions ?? []).map((action) => ({ ...action, id: allocate(),
      media: (action.media ?? []).map((media) => ({ ...media, ...bind(media.url, 'url'), id: allocate() })) }));
    return { ...next, kind: 'character' as const, referenceImages, voiceClips, actions,
      primaryReferenceImageId: character.primaryReferenceImageId ? referenceIds.get(character.primaryReferenceImageId) : undefined,
      avatarReferenceImageId: character.avatarReferenceImageId ? referenceIds.get(character.avatarReferenceImageId) : undefined,
      primaryVoiceClipId: character.primaryVoiceClipId ? voiceIds.get(character.primaryVoiceClipId) : undefined } as DramaCharacter;
  });
}
