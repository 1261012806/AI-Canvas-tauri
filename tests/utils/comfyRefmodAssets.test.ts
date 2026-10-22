import { describe, expect, it } from 'vitest';
import type { ComfyRefmodAsset, ComfyRefmodSelection } from '../../src/types/comfyRefmod';
import { comfyRefmodKey } from '../../src/utils/comfyRefmod';
import { readComfyRefmodDragPayload } from '../../src/utils/comfyRefmodDrag';
import { mergeRefmodCatalogEntries, refmodMatchesQuery } from '../../src/utils/comfyRefmodAssets';

const asset = (patch: Partial<ComfyRefmodAsset> = {}): ComfyRefmodAsset => {
  const entry = {
    serverId: 'local-h3', endpointFingerprint: 'a'.repeat(64), loaderType: 'minimax-h3' as const,
    fileName: '人物/actor.safetensors', id: '', name: 'actor', tags: [] as string[], updatedAt: 1,
    ...patch,
  };
  return { ...entry, id: comfyRefmodKey(entry) };
};
const selection = (patch: Partial<ComfyRefmodSelection> = {}): ComfyRefmodSelection => ({
  serverId: 'local-h3', endpointFingerprint: 'a'.repeat(64), loaderType: 'minimax-h3',
  fileName: '人物/actor.safetensors', strength: 0.7, ...patch,
});
const payload = (items: unknown[], version = 1) => JSON.stringify({ version, items });

describe('RefMod 资源元数据与搜索', () => {
  it('刷新保留用户名称、标签和已缺失的条目，并更新服务端元信息', () => {
    const saved = asset({ name: '主角·陈一', tags: ['主角', 'H3'], tokens: 64 });
    const missing = asset({ fileName: '人物/removed.safetensors', name: '暂时缺失' });
    const result = mergeRefmodCatalogEntries([saved, missing], [asset({ tokens: 128, kind: 'video' })]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: '主角·陈一', tags: ['主角', 'H3'], tokens: 128, kind: 'video' });
    expect(result[1]).toEqual(missing);
  });

  it('相同文件名在不同服务器、地址身份或插件格式中保持独立', () => {
    const sameName = asset();
    const entries = [
      asset({ serverId: 'other' }),
      asset({ endpointFingerprint: 'b'.repeat(64) }),
      asset({ loaderType: 'refmods-lab' }),
    ];
    expect(mergeRefmodCatalogEntries([sameName], entries)).toHaveLength(4);
  });

  it('搜索覆盖名称、精确子目录文件名和标签，忽略大小写与首尾空白', () => {
    const entry = asset({ name: '陈一', tags: ['Hero'] });
    expect(refmodMatchesQuery(entry, ' 陈一 ')).toBe(true);
    expect(refmodMatchesQuery(entry, '人物/actor')).toBe(true);
    expect(refmodMatchesQuery(entry, 'hero')).toBe(true);
    expect(refmodMatchesQuery(entry, '配角')).toBe(false);
  });
});

describe('RefMod 专用 DOM 拖放', () => {
  it('保留精确文件和服务身份，丢弃拖放中的槽位覆盖授权与额外字段', () => {
    const ref = selection({ loaderNodeId: '42', slot: 2, replaceExisting: true });
    expect(readComfyRefmodDragPayload(payload([{ ...ref, path: 'not-a-file-reference' }]))).toEqual([selection()]);
  });

  it('拒绝路径穿越、绝对路径或无效服务身份，不交给普通文件导入', () => {
    for (const fileName of ['../actor.safetensors', '/models/actor.safetensors', 'C:\\models\\actor.safetensors']) {
      expect(() => readComfyRefmodDragPayload(payload([selection({ fileName })]))).toThrow();
    }
    expect(() => readComfyRefmodDragPayload(payload([selection({ endpointFingerprint: '' })]))).toThrow();
  });

  it('拒绝未知版本、空负载、超量和过大的内容', () => {
    expect(() => readComfyRefmodDragPayload(payload([selection()], 2))).toThrow();
    expect(() => readComfyRefmodDragPayload(payload([]))).toThrow();
    expect(() => readComfyRefmodDragPayload(payload(Array.from({ length: 9 }, () => selection())))).toThrow();
    expect(() => readComfyRefmodDragPayload(' '.repeat(64 * 1024 + 1))).toThrow();
  });
});
