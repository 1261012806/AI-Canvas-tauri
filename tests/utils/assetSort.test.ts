import { describe, expect, it } from 'vitest';
import type { AssetFileEntry } from '../../src/services/fileService';
import { sortAssetFiles } from '../../src/utils/assetSort';

function file(name: string, patch: Partial<AssetFileEntry> = {}): AssetFileEntry {
  return { name, path: `/assets/${name}`, size: 10, category: 'image', ...patch };
}

describe('资产文件排序', () => {
  it('默认按中文名称中的数字自然升序，并支持降序', () => {
    const files = [file('镜头10.png'), file('镜头2.png'), file('镜头1.png')];
    expect(sortAssetFiles(files).map((item) => item.name)).toEqual(['镜头1.png', '镜头2.png', '镜头10.png']);
    expect(sortAssetFiles(files, 'name', 'desc').map((item) => item.name)).toEqual(['镜头10.png', '镜头2.png', '镜头1.png']);
  });

  it('文件大小可升降序，相同大小仍按名称、路径稳定排序', () => {
    const files = [file('镜头2.png', { size: 20 }), file('镜头1.png', { size: 10, path: '/b/镜头1.png' }),
      file('镜头1.png', { size: 10, path: '/a/镜头1.png' })];
    expect(sortAssetFiles(files, 'size', 'asc').map((item) => item.path)).toEqual([
      '/a/镜头1.png', '/b/镜头1.png', '/assets/镜头2.png',
    ]);
    expect(sortAssetFiles(files, 'size', 'desc').map((item) => item.path)).toEqual([
      '/assets/镜头2.png', '/a/镜头1.png', '/b/镜头1.png',
    ]);
  });

  it.each(['createdAt', 'modifiedAt'] as const)('%s 未知或非有限时间始终在末尾，零时间有效', (field) => {
    const files = [file('未知2.png'), file('新.png', { [field]: 200 }),
      file('未知1.png', { [field]: Number.NaN }), file('旧.png', { [field]: 0 })];
    expect(sortAssetFiles(files, field, 'asc').map((item) => item.name)).toEqual(['旧.png', '新.png', '未知1.png', '未知2.png']);
    expect(sortAssetFiles(files, field, 'desc').map((item) => item.name)).toEqual(['新.png', '旧.png', '未知1.png', '未知2.png']);
  });

  it('最近使用只按资产 ID 查询记录，不用文件修改时间替代未使用记录', () => {
    const recent = file('最近.png', { assetId: 'recent', modifiedAt: 1 });
    const older = file('较早.png', { assetId: 'older', modifiedAt: 999 });
    const unused = file('未使用2.png', { assetId: 'unused', modifiedAt: 99999 });
    const noId = file('未使用1.png', { modifiedAt: 99999 });
    const invalid = file('未使用3.png', { assetId: 'invalid', modifiedAt: 99999 });
    const files = [unused, recent, noId, invalid, older];
    const usage = new Map([['recent', 200], ['older', 0], ['invalid', Number.POSITIVE_INFINITY]]);
    expect(sortAssetFiles(files, 'usedAt', 'desc', usage)).toEqual([recent, older, noId, unused, invalid]);
    expect(sortAssetFiles(files, 'usedAt', 'asc', usage)).toEqual([older, recent, noId, unused, invalid]);
    expect(sortAssetFiles(files, 'usedAt', 'desc')).toEqual(sortAssetFiles(files));
  });

  it('不改变源数组和条目，并保留完全同值条目的原顺序', () => {
    const first = Object.freeze({ ...file('镜头2.png'), marker: 'first' });
    const second = Object.freeze({ ...file('镜头2.png'), marker: 'second' });
    const third = Object.freeze({ ...file('镜头1.png'), marker: 'third' });
    const files = Object.freeze([first, second, third]);
    const sorted = sortAssetFiles(files);
    expect(sorted).not.toBe(files);
    expect(sorted.map((item) => item.marker)).toEqual(['third', 'first', 'second']);
    expect(files).toEqual([first, second, third]);
    expect(sorted[1]).toBe(first);
  });
});
