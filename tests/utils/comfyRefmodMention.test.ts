import { describe, expect, it } from 'vitest';
import type { ComfyRefmodSelection } from '../../src/types/comfyRefmod';
import {
  assertNoComfyRefmodMentions,
  buildComfyRefmodMention,
  mergeComfyRefmodSelections,
  parseComfyRefmodMentions,
  resolveComfyRefmodMentionInputs,
} from '../../src/utils/comfyRefmodMention';

const ref: ComfyRefmodSelection = {
  endpointFingerprint: 'a'.repeat(64), loaderType: 'minimax-h3', fileName: '角色/alice', strength: 0.7,
  workflowId: 'wf', loaderNodeId: '12', slot: 1, originalFileName: '(none)',
};

describe('ComfyUI 角色提示词引用', () => {
  it('序列化绑定白名单并支持含括号、冒号与百分号的标签', () => {
    const token = buildComfyRefmodMention({ ...ref, path: 'must-not-survive', apiKey: 'fake-secret' } as ComfyRefmodSelection, '角色{甲}:100%');
    const parsed = parseComfyRefmodMentions(`前${token}后`);
    expect(parsed.prompt).toBe('前 后');
    expect(parsed.refs).toEqual([ref]);
    expect(parsed.mentions).toEqual([{ token, label: '角色{甲}:100%', selection: ref }]);
    expect(decodeURIComponent(token)).not.toContain('must-not-survive');
    expect(decodeURIComponent(token)).not.toContain('fake-secret');
  });

  it('同时处理主提示词与全部 IO 输入，同槽同值仅注入一次', () => {
    const token = buildComfyRefmodMention(ref, '女主');
    const result = resolveComfyRefmodMentionInputs({ prompt: `动作 ${token}`, workflowInputs: { '1': token, '2': '保留普通文本' }, manual: [ref] });
    expect(result.comfyRefmods).toEqual([ref]);
    expect(result.prompt).not.toContain('@refmod');
    expect(result.workflowInputs).toEqual({ '1': ' ', '2': '保留普通文本' });
  });

  it('删除最后一个 token 即停止传入该引用，保留独立手工绑定', () => {
    const token = buildComfyRefmodMention(ref, '女主');
    expect(resolveComfyRefmodMentionInputs({ prompt: token }).comfyRefmods).toHaveLength(1);
    expect(resolveComfyRefmodMentionInputs({ prompt: '动作' }).comfyRefmods).toEqual([]);
    expect(resolveComfyRefmodMentionInputs({ prompt: '动作', manual: [ref] }).comfyRefmods).toEqual([ref]);
  });

  it('不同文件、强度或工作流不能静默覆盖同一槽位', () => {
    for (const patch of [{ fileName: '角色/bob' }, { strength: 0.3 }, { workflowId: 'other' }]) {
      expect(() => mergeComfyRefmodSelections([ref], [{ ...ref, ...patch }])).toThrow('冲突');
    }
    expect(mergeComfyRefmodSelections([ref], [{ ...ref, slot: 2 }])).toHaveLength(2);
    expect(mergeComfyRefmodSelections([ref], [{ ...ref, replaceExisting: true }])).toEqual([ref]);
  });

  it('拒绝缺少映射上下文、无效编码、未闭合与未知版本引用', () => {
    const token = buildComfyRefmodMention(ref, '女主');
    for (const text of ['@refmod', '@refmod{', '@refmod{%xx}', '@refmod{null}', token.slice(0, -1),
      `@refmod{${encodeURIComponent(JSON.stringify({ v: 2, ref, label: '女主' }))}}`,
      `@refmod{${encodeURIComponent(JSON.stringify({ v: 1, ref: { ...ref, workflowId: undefined }, label: '女主' }))}}`]) {
      expect(() => parseComfyRefmodMentions(text)).toThrow();
    }
    expect(() => buildComfyRefmodMention({ ...ref, originalFileName: undefined }, '女主')).toThrow('槽位');
  });

  it('限制单 token 长度与跨输入的总引用数', () => {
    const token = buildComfyRefmodMention(ref, '女主');
    expect(() => parseComfyRefmodMentions(`@refmod{${'x'.repeat(16 * 1024)}}`)).toThrow('过长');
    expect(() => parseComfyRefmodMentions(token.repeat(101))).toThrow('100');
    expect(() => resolveComfyRefmodMentionInputs({ prompt: token.repeat(100), workflowInputs: { '1': token } })).toThrow('100');
  });

  it('普通模型通道拒绝完整及损坏的保留标记', () => {
    expect(() => assertNoComfyRefmodMentions('普通人物描述')).not.toThrow();
    expect(() => assertNoComfyRefmodMentions(buildComfyRefmodMention(ref, '女主'))).toThrow('仅支持本地');
    expect(() => assertNoComfyRefmodMentions('@refmod{')).toThrow('仅支持本地');
  });
});
