import { describe, expect, it } from 'vitest';
import type { DramaCharacter, DramaProp, DramaScene } from '../../src/types/dramaAssets';
import { MAX_CHARACTER_WEAPONS, normalizeDramaCharacter, normalizeDramaVisualAsset } from '../../src/types/dramaAssets';
import { expandCharacterWeaponDependencies } from '../../src/services/characterWeapons';
import {
  buildDramaAssetTransferDocument, detachDramaAssetTransferMentions, DRAMA_ASSET_TRANSFER_LIMITS,
  parseDramaAssetTransferDocument, remapImportedAssets,
  buildDramaAssetImportPreview, getDramaAssetTransferMediaIds, selectDramaAssetTransferDocument,
  type DramaAssetTransferDocument, type DramaAssetTransferMedia, type ImportedDramaAssetMedia,
} from '../../src/services/dramaAssetTransferFormat';

const token = (id: string) => `aicasset-media:${id}`;
const media: DramaAssetTransferMedia[] = [
  { id: 'image', kind: 'image', path: 'media/人物.png', bytes: 10, sha256: 'a'.repeat(64) },
  { id: 'voice', kind: 'audio', path: 'media/声音.wav', bytes: 20, sha256: 'b'.repeat(64) },
  { id: 'video', kind: 'video', path: 'media/动作.mp4', bytes: 30, sha256: 'c'.repeat(64) },
];

function character(): DramaCharacter {
  return {
    id: 'source-character', kind: 'character', name: '人物甲', key: '人物甲', summary: '简介', visualNotes: '视觉',
    importance: 'main', source: 'manual', confirmed: true, createdAt: 1, updatedAt: 2, identity: '主角',
    aliases: ['甲'], relationships: [{ targetName: '乙', relation: '朋友' }], imageUrl: token('image'),
    referenceImages: [{ id: 'source-reference', kind: 'avatar', imageUrl: token('image'), prompt: '参考提示词', createdAt: 1, updatedAt: 2 }],
    primaryReferenceImageId: 'source-reference', avatarReferenceImageId: 'source-reference',
    avatarCrop: { x: 0, y: 0, width: 0.5, height: 1 },
    voiceClips: [{ id: 'source-voice', kind: 'line', label: '台词', audioUrl: token('voice'), transcript: '你好', durationSec: 2, createdAt: 1, updatedAt: 2 }],
    primaryVoiceClipId: 'source-voice',
    actions: [{ id: 'source-action', category: 'walking', name: '行走', prompt: '向前走', createdAt: 1, updatedAt: 2,
      media: [{ id: 'source-action-image', kind: 'image', name: '姿态', url: token('image'), createdAt: 1, updatedAt: 2 },
        { id: 'source-action-video', kind: 'video', name: '动作视频', mimeType: 'video/mp4', url: token('video'), createdAt: 1, updatedAt: 2 }] }],
  };
}

function weaponAsset(): DramaProp {
  return { id: 'source-weapon', kind: 'prop', propType: 'weapon', category: '剑', name: '剑', key: '剑',
    summary: '', visualNotes: '', importance: 'supporting', source: 'manual', confirmed: true,
    createdAt: 1, updatedAt: 2, imageUrl: token('image') };
}

function document(): DramaAssetTransferDocument {
  const scene: DramaScene = { id: 'source-scene', kind: 'scene', name: '客厅', key: '客厅', summary: '', visualNotes: '',
    importance: 'supporting', source: 'manual', confirmed: true, createdAt: 1, updatedAt: 2, imageUrl: token('image'), placeType: '室内' };
  return buildDramaAssetTransferDocument({ exportedAt: 3, name: '测试资产包', assets: [character(), scene], media });
}

describe('创作资产包纯格式', () => {
  it('武器子类型与角色绑定有界归一化，单卡保留尚未落地的目标身份', () => {
    const value = { ...character(), weaponIds: ['later-weapon', 'later-weapon', '', '../invalid', ...Array.from({ length: 70 }, (_, index) => `weapon-${index}`)] };
    const normalized = normalizeDramaCharacter(value);
    expect(normalized.weaponIds).toHaveLength(MAX_CHARACTER_WEAPONS);
    expect(normalized.weaponIds?.[0]).toBe('later-weapon');
    expect(normalized.weaponIds).not.toContain('../invalid');
    const prop = weaponAsset();
    expect(normalizeDramaVisualAsset(prop)).toMatchObject({ propType: 'weapon', category: '剑' });
    expect(normalizeDramaVisualAsset({ ...prop, propType: 'future' as 'weapon' }).propType).toBeUndefined();
  });

  it('角色依赖按同库武器身份展开，共用武器只加入一次且不按名称补配', () => {
    const role = { ...character(), weaponIds: ['blade'] };
    const weapon: DramaProp = { ...weaponAsset(), id: 'blade', category: '刀' };
    const second = { ...role, id: 'second-role' };
    expect(expandCharacterWeaponDependencies([role, second], [role, second, weapon])).toEqual([role, second, weapon]);
    expect(() => expandCharacterWeaponDependencies([role], [{ ...weapon, id: 'same-name' }])).toThrow();
    expect(() => expandCharacterWeaponDependencies([role], [{ ...weapon, propType: undefined }])).toThrow();
    expect(() => expandCharacterWeaponDependencies([role], [weapon, { ...weapon }])).toThrow();
    expect(expandCharacterWeaponDependencies([character()], [])).toHaveLength(1);
  });

  it('选择角色强制保留武器闭包与媒体，整批重映射后绑定指向新武器副本', () => {
    const role = { ...character(), weaponIds: ['blade', 'shield'] };
    const weapon: DramaProp = { ...weaponAsset(), id: 'blade', category: '刀', imageUrl: token('weapon-image') };
    const shield: DramaProp = { ...weapon, id: 'shield', name: '盾', imageUrl: undefined };
    const allMedia = [...media, { ...media[0], id: 'weapon-image', path: 'media/weapon.png' }];
    const value = buildDramaAssetTransferDocument({ exportedAt: 3, name: '武器包', assets: [role, weapon, shield], media: allMedia });
    const preview = buildDramaAssetImportPreview(value);
    expect(preview.items[0]).toMatchObject({ category: 'character', weaponIds: ['blade', 'shield'] });
    expect(preview.items[1]).toMatchObject({ category: 'weapon' });
    const selected = selectDramaAssetTransferDocument(value, [{ kind: 'character', id: role.id }]);
    expect(selected.assets).toHaveLength(3);
    expect(selected.media).toHaveLength(4);
    const local = new Map<string, ImportedDramaAssetMedia>(allMedia.map((entry) => [entry.id, {
      assetId: `local-${entry.id}`, relativePath: entry.path, url: `asset://localhost/project/${entry.path}`,
    }]));
    let sequence = 0;
    const restored = remapImportedAssets(selected.assets, local, () => `fresh-${++sequence}`);
    const imported = restored[0] as DramaCharacter;
    expect(imported.weaponIds).toEqual(restored.slice(1).map((asset) => asset.id));
    expect(imported.weaponIds).not.toContain('blade');
    expect(restored[1]).toMatchObject({ kind: 'prop', propType: 'weapon', category: '刀', assetId: 'local-weapon-image' });
    expect(role.weaponIds).toEqual(['blade', 'shield']);
  });

  it('单卡格式校验兼容云端跨卡关系，实际导入拒绝缺失武器与无效绑定字段', () => {
    const value = buildDramaAssetTransferDocument({ exportedAt: 3, name: '共享单卡', assets: [{ ...character(), weaponIds: ['remote-weapon'] }], media });
    expect((parseDramaAssetTransferDocument(value).assets[0] as DramaCharacter).weaponIds).toEqual(['remote-weapon']);
    expect(() => buildDramaAssetImportPreview(value)).toThrow();
    expect(() => selectDramaAssetTransferDocument(value, [{ kind: 'character', id: value.assets[0].id }])).toThrow();
    expect(() => remapImportedAssets(value.assets, new Map())).toThrow();
    for (const weaponIds of [['same', 'same'], ['../invalid'], Array.from({ length: MAX_CHARACTER_WEAPONS + 1 }, (_, index) => `weapon-${index}`)]) {
      expect(() => parseDramaAssetTransferDocument({ ...value, assets: [{ ...value.assets[0], weaponIds }] })).toThrow();
    }
    const prop = { ...document().assets[1], kind: 'prop', propType: 'future' };
    expect(() => parseDramaAssetTransferDocument({ ...value, assets: [prop], media: [media[0]] })).toThrow();
  });

  it('导出只保留白名单字段，移除本机身份、服务绑定及旧引用的执行语义', () => {
    const source = character();
    source.imageNodeId = 'local-node'; source.imageAssetId = 'old-image'; source.imageRelativePath = 'old.png';
    source.volcengineBinding = { projectName: '私有项目', imageAssetId: 'cloud-id' };
    source.refmods = [{ endpointFingerprint: 'endpoint', loaderType: 'h3-refmods', fileName: 'model.safetensors', strength: 1 }];
    Object.assign(source, { future: 'unknown', filePath: 'C:/private/root.png' });
    Object.assign(source.referenceImages![0], { sourceNodeId: 'node', assetId: 'old-index', filePath: 'C:/private/ref.png', relativePath: 'ref.png' });
    Object.assign(source.voiceClips![0], { sourceNodeId: 'audio-node', assetId: 'old-audio', filePath: 'C:/private/voice.wav' });
    source.actions![0].media![0].filePath = 'C:/private/action.png';
    source.summary = '@{old-node:节点名} @drama{global/old#voice/v:旧声音} @asset{C%3A%2Fprivate%2F原图.png}';
    const before = JSON.stringify(source);
    const result = buildDramaAssetTransferDocument({ exportedAt: 3, name: '资产包', assets: [source], media });
    expect(result.assets[0].summary).toBe('节点名 旧声音 原图.png');
    const serialized = JSON.stringify(result);
    for (const field of ['sourceNodeId', 'imageNodeId', 'assetId', 'filePath', 'relativePath', 'imageAssetId', 'refmods', 'volcengineBinding', 'future']) {
      expect(serialized).not.toContain(`"${field}"`);
    }
    expect(serialized).not.toContain('C:/private');
    expect(JSON.stringify(source)).toBe(before);
  });

  it('完整保留人物图声动作与场景元数据，解析返回独立对象', () => {
    const input = document(); const parsed = parseDramaAssetTransferDocument(JSON.stringify(input));
    expect(parsed).toEqual(input); expect(parsed).not.toBe(input);
    expect((parsed.assets[0] as DramaCharacter).actions![0].media).toHaveLength(2);
    expect(parsed.assets[1]).toMatchObject({ kind: 'scene', placeType: '室内', imageUrl: token('image') });
  });

  it('预览按同类别名称提示副本，所选闭包去重共享媒体并拒绝伪造身份', () => {
    const value = document();
    const existing = { ...value.assets[1], id: 'existing-scene', name: ' 客厅 ' };
    const preview = buildDramaAssetImportPreview(value, [existing]);
    expect(preview.items).toMatchObject([
      { kind: 'character', sameName: false, mediaIds: ['image', 'voice', 'video'] },
      { kind: 'scene', sameName: true, mediaIds: ['image'] },
    ]);
    expect(preview.media).toEqual(media.map(({ id, kind, bytes }) => ({ id, kind, bytes })));
    expect(JSON.stringify(preview)).not.toContain('media/人物.png');
    const selected = selectDramaAssetTransferDocument(value, [{ kind: 'scene', id: value.assets[1].id }]);
    expect(selected.assets).toEqual([value.assets[1]]);
    expect(selected.media).toEqual([media[0]]);
    expect(selectDramaAssetTransferDocument(value, value.assets.map(({ kind, id }) => ({ kind, id }))).media).toHaveLength(3);
    for (const selection of [[], [{ kind: 'scene' as const, id: 'missing' }],
      [{ kind: 'prop' as const, id: value.assets[1].id }],
      [{ kind: 'scene' as const, id: value.assets[1].id }, { kind: 'scene' as const, id: value.assets[1].id }]]) {
      expect(() => selectDramaAssetTransferDocument(value, selection)).toThrow();
    }
    expect(value.assets).toHaveLength(2);
    expect(value.media).toHaveLength(3);
  });

  it('场景道具多图保留标签、独立重映射与主图指针，剥离本机身份', () => {
    const scene: DramaScene = { ...document().assets[1], kind: 'scene',
      referenceImages: [{ id: 'day', label: '白天', prompt: '窗外阳光', imageUrl: token('image'), createdAt: 1, updatedAt: 2 },
        { id: 'night', label: '夜晚', prompt: '夜景', imageUrl: token('night'), createdAt: 1, updatedAt: 2 }],
      primaryReferenceImageId: 'night', imageUrl: token('night') };
    Object.assign(scene.referenceImages![0], { assetId: 'old', filePath: '/private/day.png', sourceNodeId: 'node' });
    const sceneMedia = [media[0], { ...media[0], id: 'night', path: 'media/night.png' }];
    const value = buildDramaAssetTransferDocument({ name: '场景包', exportedAt: 3, assets: [scene], media: sceneMedia });
    expect(getDramaAssetTransferMediaIds(value.assets[0])).toEqual(['night', 'image']);
    expect(JSON.stringify(value)).not.toMatch(/sourceNodeId|assetId|filePath/);
    const local = new Map<string, ImportedDramaAssetMedia>(sceneMedia.map((item) => [item.id, {
      assetId: `local-${item.id}`, relativePath: item.path, url: `asset://localhost/project/${item.path}`,
    }]));
    let counter = 0;
    const imported = remapImportedAssets(value.assets, local, () => `fresh-${++counter}`)[0];
    expect(imported.kind).toBe('scene');
    if (imported.kind !== 'scene') throw new Error('Missing imported scene');
    expect(imported.referenceImages).toMatchObject([{ label: '白天', assetId: 'local-image' }, { label: '夜晚', assetId: 'local-night' }]);
    expect(imported.primaryReferenceImageId).toBe(imported.referenceImages![1].id);
    expect(imported.referenceImages!.map((item) => item.id)).not.toContain('day');
    const invalid = { ...value, assets: [{ ...value.assets[0], primaryReferenceImageId: 'unknown' }] };
    expect(() => parseDramaAssetTransferDocument(invalid)).toThrow();
    Object.assign(value.assets[0].referenceImages![0], { filePath: '/private/escape.png' });
    expect(() => parseDramaAssetTransferDocument(value)).toThrow();
  });

  it('旧单图包导入时补带本地身份的参考图，明确清空的数组不复活图片', () => {
    const source = document().assets[1];
    const local = new Map<string, ImportedDramaAssetMedia>([['image', {
      assetId: 'local-image', relativePath: 'media/image.png', url: 'asset://localhost/project/media/image.png',
    }]]);
    let counter = 0;
    const restored = remapImportedAssets([source], local, () => `fresh-${++counter}`)[0];
    expect(restored.kind).toBe('scene');
    if (restored.kind !== 'scene') throw new Error('Missing scene');
    expect(restored.referenceImages).toMatchObject([{ assetId: 'local-image', relativePath: 'media/image.png',
      imageUrl: local.get('image')!.url, label: '', prompt: '' }]);
    expect(restored.primaryReferenceImageId).toBe(restored.referenceImages![0].id);
    const cleared = remapImportedAssets([{ ...source, imageUrl: undefined, referenceImages: [] }], new Map(), () => `clear-${++counter}`)[0];
    expect(cleared.referenceImages).toEqual([]);
    expect(cleared.imageUrl).toBeUndefined();
    expect(cleared.primaryReferenceImageId).toBeUndefined();
  });

  it('拒绝未知格式、版本、清单字段与资产种类', () => {
    const value = document();
    for (const invalid of [{ ...value, format: 'other' }, { ...value, version: 2 }, { ...value, future: true },
      { ...value, assets: [{ ...value.assets[0], kind: 'video' }] }]) {
      expect(() => parseDramaAssetTransferDocument(invalid)).toThrow();
    }
  });

  it.each([
    (value: DramaAssetTransferDocument) => { value.assets[0].imageAssetId = 'local-index'; },
    (value: DramaAssetTransferDocument) => { (value.assets[0] as DramaCharacter).voiceClips![0].sourceNodeId = 'local-node'; },
    (value: DramaAssetTransferDocument) => { (value.assets[0] as DramaCharacter).actions![0].media![0].filePath = '/private/file'; },
    (value: DramaAssetTransferDocument) => { Object.assign((value.assets[0] as DramaCharacter).relationships![0], { extra: true }); },
    (value: DramaAssetTransferDocument) => { Object.assign((value.assets[0] as DramaCharacter).avatarCrop!, { extra: true }); },
  ])('外部输入不能穿透任何层级的白名单', (mutate) => {
    const value = document(); mutate(value); expect(() => parseDramaAssetTransferDocument(value)).toThrow();
  });

  it.each(['https://example.com/a.png', 'asset://localhost/private/a.png', 'C:/private/a.png', 'data:image/png;base64,YQ==', 'blob:old', 'aicasset-media:missing'])('拒绝非包内或不存在的媒体引用 %s', (url) => {
    const value = document(); value.assets[0].imageUrl = url;
    expect(() => parseDramaAssetTransferDocument(value)).toThrow();
  });

  it.each(['../escape.png', '/absolute.png', 'C:/drive.png', 'media\\file.png', 'media//file.png', 'media/../file.png', 'media/NUL.png', 'media/file.'])('拒绝不安全路径 %s', (unsafe) => {
    const value = document(); value.media[0].path = unsafe;
    expect(() => parseDramaAssetTransferDocument(value)).toThrow();
  });

  it('拒绝重复身份、跨卡或丢失主素材指针、媒体类型不符和孤立媒体', () => {
    const mutations: Array<(value: DramaAssetTransferDocument) => void> = [
      (value) => { value.assets[1].id = value.assets[0].id; },
      (value) => { value.media[1].id = value.media[0].id; },
      (value) => { value.media[1].path = value.media[0].path.toUpperCase(); },
      (value) => { const refs = (value.assets[0] as DramaCharacter).referenceImages!; refs.push({ ...refs[0] }); },
      (value) => { (value.assets[0] as DramaCharacter).primaryVoiceClipId = 'source-reference'; },
      (value) => { (value.assets[0] as DramaCharacter).avatarReferenceImageId = 'missing'; },
      (value) => { value.media[0].kind = 'audio'; },
      (value) => { value.media.push({ ...value.media[0], id: 'unused', path: 'media/unused.png' }); },
      (value) => { value.media[0].sha256 = 'invalid'; },
      (value) => { value.media[0].bytes = -1; },
    ];
    for (const mutate of mutations) { const value = document(); mutate(value); expect(() => parseDramaAssetTransferDocument(value)).toThrow(); }
  });

  it('限制资产、媒体、文本和清单大小，不接收空资产包', () => {
    const value = document();
    expect(() => parseDramaAssetTransferDocument({ ...value, assets: [] })).toThrow();
    expect(() => parseDramaAssetTransferDocument({ ...value, assets: Array(DRAMA_ASSET_TRANSFER_LIMITS.assets + 1).fill(value.assets[0]) })).toThrow();
    expect(() => parseDramaAssetTransferDocument({ ...value, media: Array(DRAMA_ASSET_TRANSFER_LIMITS.media + 1).fill(value.media[0]) })).toThrow();
    value.assets[0].summary = '字'.repeat(DRAMA_ASSET_TRANSFER_LIMITS.textBytes);
    expect(() => parseDramaAssetTransferDocument(value)).toThrow();
    expect(() => parseDramaAssetTransferDocument(' '.repeat(DRAMA_ASSET_TRANSFER_LIMITS.manifestBytes + 1))).toThrow();
  });

  it('重分配全部卡片和嵌套身份，主素材指针与新本地文件保持一致', () => {
    const value = document(); const before = JSON.stringify(value);
    const local = new Map<string, ImportedDramaAssetMedia>(media.map((item) => [item.id, {
      assetId: `local-${item.id}`, relativePath: item.path, url: `asset://localhost/project/${item.path}`,
    }]));
    let counter = 0;
    const assets = remapImportedAssets(value.assets, local, () => `new-${++counter}`);
    const imported = assets[0] as DramaCharacter;
    expect(imported.id).not.toBe(value.assets[0].id);
    expect(imported.referenceImages![0]).toMatchObject({ id: imported.primaryReferenceImageId, assetId: 'local-image', imageUrl: local.get('image')!.url });
    expect(imported.avatarReferenceImageId).toBe(imported.referenceImages![0].id);
    expect(imported.primaryVoiceClipId).toBe(imported.voiceClips![0].id);
    expect(imported.actions![0].id).not.toBe('source-action');
    expect(imported.actions![0].media![1]).toMatchObject({ assetId: 'local-video', url: local.get('video')!.url });
    expect(imported.actions![0].media![1].id).not.toBe('source-action-video');
    expect(assets[1]).toMatchObject({ assetId: 'local-image', relativePath: media[0].path, imageUrl: local.get('image')!.url });
    expect(assets[1].imageAssetId).toBeUndefined();
    expect(JSON.stringify(assets)).not.toContain('aicasset-media:');
    expect(JSON.stringify(value)).toBe(before);
    expect(() => remapImportedAssets(value.assets, new Map(), () => 'new')).toThrow();
    expect(() => remapImportedAssets(value.assets, local, () => 'same')).toThrow();
    expect(() => remapImportedAssets(value.assets, local, () => 'source-character')).toThrow();
  });

  it('文本中的可识别引用降为标签，损坏或标签嵌套的旧引用保持不可执行', () => {
    const refmod = encodeURIComponent(JSON.stringify({ label: '动作包', ref: {} }));
    const result = detachDramaAssetTransferMentions(`@wf{io|参考输入|image}(正文) @model{old|模型名} @skill{s|技能} @refmod{${refmod}} @asset{未闭合`);
    expect(result).toBe('参考输入(正文) 模型名 技能 动作包 ＠asset{未闭合');
    expect(detachDramaAssetTransferMentions('@{a:@asset{local}}')).not.toMatch(/@asset\{/);
  });
});
