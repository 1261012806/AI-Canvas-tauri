import { describe, expect, it } from 'vitest';
import type { ComfyRefmodAsset, ComfyRefmodCatalog, ComfyRefmodLoaderSchema, ComfyRefmodSelection } from '../../src/types/comfyRefmod';
import type { DramaCharacter } from '../../src/types/dramaAssets';
import { comfyRefmodKey } from '../../src/utils/comfyRefmod';
import { buildComfyRefmodMentionEntries } from '../../src/utils/comfyRefmodMentionOptions';

const fingerprint = 'a'.repeat(64);

function asset(overrides: Partial<ComfyRefmodAsset> = {}): ComfyRefmodAsset {
  const value: ComfyRefmodAsset = {
    id: '', serverId: 'h3', endpointFingerprint: fingerprint, loaderType: 'minimax-h3',
    fileName: 'people/Alice', name: 'Alice', tags: [], updatedAt: 1, ...overrides,
  };
  return { ...value, id: comfyRefmodKey(value) };
}

function catalog(entries: ComfyRefmodAsset[], extra: Partial<ComfyRefmodCatalog> = {}): ComfyRefmodCatalog {
  return { serverId: 'h3', endpointFingerprint: fingerprint, serverName: 'H3', entries, loaders: [], warnings: [], fetchedAt: 1, ...extra };
}

function loader(names: string[], loaderType: ComfyRefmodLoaderSchema['loaderType'] = 'minimax-h3'): Pick<ComfyRefmodLoaderSchema, 'loaderType' | 'slots'> {
  return { loaderType, slots: [{ slot: 1, fileField: 'mod_1', allowedNames: names, emptyNames: ['(none)'] }] };
}

function character(name: string, references: ComfyRefmodSelection[], imageUrl?: string): DramaCharacter {
  return {
    id: name, kind: 'character', name, key: name, summary: '', visualNotes: '', identity: '',
    importance: 'supporting', confirmed: false, source: 'manual', createdAt: 1, updatedAt: 1,
    refmods: references, imageUrl,
  };
}

describe('ComfyUI @ 参考包候选', () => {
  it('仅保留当前服务目录中、当前图同格式加载器允许的精确文件名', () => {
    const alice = asset();
    const labAlice = asset({ loaderType: 'refmods-lab', fileName: 'people/Alice.safetensors' });
    const entries = buildComfyRefmodMentionEntries({
      catalog: catalog([alice, labAlice, asset({ fileName: 'people/Alice-extra' })]),
      loaders: [loader(['people/Alice'])],
    });
    expect(entries.map((entry) => entry.asset)).toEqual([alice]);
  });

  it('合并已保存名称和标签，但缓存里的缺失文件和旧端点不能成为候选', () => {
    const current = asset({ tokens: 100 });
    const entries = buildComfyRefmodMentionEntries({
      catalog: catalog([current]), loaders: [loader(['people/Alice', 'missing'])],
      savedAssets: [asset({ name: '爱丽丝', tags: ['主角'], tokens: 50 }), asset({ fileName: 'missing' }),
        asset({ endpointFingerprint: 'b'.repeat(64), name: '旧服务器同名' })],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].asset).toMatchObject({ name: '爱丽丝', tags: ['主角'], tokens: 100 });
  });

  it('按文件身份匹配角色主图，跨服务器或跨插件同名包不借用图片', () => {
    const current = asset();
    const entries = buildComfyRefmodMentionEntries({
      catalog: catalog([current]), loaders: [loader([current.fileName])],
      projectCharacters: [character('另一服务器', [{ ...current, endpointFingerprint: 'b'.repeat(64), strength: 1 }], 'wrong-server.png'),
        character('另一格式', [{ ...current, loaderType: 'h3-refmods', strength: 1 }], 'wrong-format.png')],
      globalCharacters: [character('正确角色', [{ ...current, strength: 1 }], 'correct.png')],
    });
    expect(entries[0]).toMatchObject({ thumbnailUrl: 'correct.png', characterName: '正确角色' });
  });

  it('选择角色主图，并优先使用当前项目的角色关联', () => {
    const current = asset();
    const project = character('项目角色', [{ ...current, strength: 1 }], 'legacy.png');
    project.primaryReferenceImageId = 'primary';
    project.referenceImages = [
      { id: 'first', kind: 'primary', imageUrl: 'first.png', prompt: '', createdAt: 1, updatedAt: 1 },
      { id: 'primary', kind: 'primary', imageUrl: 'primary.png', prompt: '', createdAt: 1, updatedAt: 1 },
    ];
    const entries = buildComfyRefmodMentionEntries({
      catalog: catalog([current]), loaders: [loader([current.fileName])], projectCharacters: [project],
      globalCharacters: [character('全局角色', [{ ...current, strength: 1 }], 'global.png')],
    });
    expect(entries[0]).toMatchObject({ thumbnailUrl: 'primary.png', characterName: '项目角色' });
  });

  it('部分目录读取失败时不把保存的旧条目当作已验证候选', () => {
    const saved = asset();
    expect(buildComfyRefmodMentionEntries({
      catalog: catalog([], { failedLoaderTypes: ['minimax-h3'] }),
      savedAssets: [saved], loaders: [loader([saved.fileName])],
    })).toEqual([]);
  });

  it('不同槽位允许值取并集，构造候选不修改目录或角色引用', () => {
    const current = asset();
    const originalCatalog = catalog([current]);
    const source = character('角色', [{ ...current, strength: 0.6 }]);
    const original = JSON.stringify([originalCatalog, source]);
    const descriptor = loader([]);
    descriptor.slots.push({ slot: 2, fileField: 'mod_2', allowedNames: [current.fileName], emptyNames: ['(none)'] });
    const entries = buildComfyRefmodMentionEntries({ catalog: originalCatalog, loaders: [descriptor], projectCharacters: [source] });
    expect(entries).toHaveLength(1);
    expect(entries[0].characterName).toBe('角色');
    expect(entries[0].thumbnailUrl).toBeUndefined();
    expect(JSON.stringify([originalCatalog, source])).toBe(original);
  });
});
