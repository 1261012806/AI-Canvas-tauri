import { describe, expect, it } from 'vitest';
import {
  comfyRefmodKey,
  isComfyRefmodFileName,
  normalizeCharacterRefmods,
  normalizeComfyRefmodAssets,
  normalizeComfyRefmodSelections,
} from '../../src/utils/comfyRefmod';

const ref = {
  serverId: 'local', endpointFingerprint: 'a'.repeat(64),
  loaderType: 'minimax-h3' as const, fileName: '角色/小明', strength: 0.8,
};

describe('RefMod 持久化引用边界', () => {
  it('保留插件精确的相对文件名和扩展名，拒绝路径穿越、地址和控制字符', () => {
    for (const name of ['角色/小明', 'folder\\character.safetensors', 'same-name.safetensors']) expect(isComfyRefmodFileName(name)).toBe(true);
    for (const name of ['F:\\models\\person', '/models/person', '\\\\host\\share', '../person', 'folder/../person', 'https://host/person', 'folder//person', 'person\u0000']) expect(isComfyRefmodFileName(name)).toBe(false);
  });

  it('服务地址变化或加载格式不同的同名文件具有不同身份', () => {
    expect(comfyRefmodKey(ref)).not.toBe(comfyRefmodKey({ ...ref, endpointFingerprint: 'b'.repeat(64) }));
    expect(comfyRefmodKey(ref)).not.toBe(comfyRefmodKey({ ...ref, loaderType: 'refmods-lab' }));
    expect(comfyRefmodKey(ref)).not.toBe(comfyRefmodKey({ ...ref, serverId: undefined }));
  });

  it('只保存白名单字段，拒绝未知格式、非法指纹和非有限强度', () => {
    expect(normalizeComfyRefmodSelections([{ ...ref, path: 'private', config: { private: true } }])).toEqual([ref]);
    expect(normalizeComfyRefmodSelections([
      { ...ref, endpointFingerprint: 'bad' }, { ...ref, loaderType: 'unknown' },
      { ...ref, strength: Number.NaN }, { ...ref, strength: Infinity }, { ...ref, strength: 11 },
    ])).toEqual([]);
    // 范围最终由对应加载器的 fresh schema 校验；Francky 声明允许大于 1。
    expect(normalizeComfyRefmodSelections([{ ...ref, loaderType: 'h3-refmods', strength: 5 }])[0].strength).toBe(5);
  });

  it('角色关联不会携带某工作流的槽位和替换授权，重复引用去重', () => {
    expect(normalizeCharacterRefmods([{ ...ref, loaderNodeId: '57:27', slot: 2, workflowId: 'wf-a', originalFileName: '(none)', replaceExisting: true }, ref])).toEqual([ref]);
    expect(normalizeComfyRefmodSelections([{ ...ref, replaceExisting: true }])).toEqual([ref]);
  });

  it('目录缓存丢弃服务端路径等额外字段，同时保留用户显示名与标签', () => {
    const [asset] = normalizeComfyRefmodAssets([{ ...ref, name: ' 小明 ', tags: ['角色', '角色', ' '], updatedAt: 123, path: 'private', config: { secret: true } }]);
    expect(asset.name).toBe('小明');
    expect(asset.tags).toEqual(['角色']);
    expect(asset.id).toBe(comfyRefmodKey(ref));
    expect(asset).not.toHaveProperty('path');
    expect(asset).not.toHaveProperty('config');
    expect(asset).not.toHaveProperty('strength');
  });
});
