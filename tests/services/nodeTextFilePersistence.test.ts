import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

const mock = vi.hoisted(() => ({ save: vi.fn(), desktop: vi.fn(() => true) }));
vi.mock('../../src/services/fileService', () => ({
  saveBinaryToProjectData: mock.save,
  buildNodeFileName: (label: string | undefined, extension: string, fallback: string) => `${label || fallback}${extension}`,
}));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: mock.desktop }));

import { persistMissingNodeTextFiles } from '../../src/services/nodeTextFilePersistence';

type State = ReturnType<Parameters<typeof persistMissingNodeTextFiles>[0]>;
let state: State;
let current: boolean;
const getState = () => state;
const sync = () => persistMissingNodeTextFiles(getState, () => current);
function node(id: string, type: BaseNodeData['type'], output: string, patch: Partial<BaseNodeData> = {}) {
  return { id, type, position: { x: 0, y: 0 }, data: { type, label: id, status: 'success' as const, output, ...patch } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.desktop.mockReturnValue(true);
  current = true;
  state = { currentProjectId: 'p1', nodes: [], updateNodeDataTransient: vi.fn((id, patch) => {
    state.nodes = state.nodes.map((item) => item.id === id ? { ...item, data: { ...item.data, ...patch } } : item);
  }) };
  mock.save.mockImplementation(async (_bytes: Uint8Array, _project: string, fileName: string) => ({
    filePath: `D:/data/project/${fileName}`, assetUrl: `asset://project/${fileName}`,
  }));
});

describe('missing node text files', () => {
  it('为已存在的 MCP 正文补 UTF-8 md/txt 文件和真实文件身份，不改内容或节点类型', async () => {
    state.nodes = [node('剧本', 'ai-markdown', '# 序章\n借过，有人回家。'),
      node('对白', 'ai-text', '保留中文和表情🙂'), node('原文', 'source-text', '源文本')];
    const original = state.nodes.map((item) => ({ id: item.id, type: item.type, output: item.data.output }));
    expect(await sync()).toBe(true);
    expect(mock.save.mock.calls.map((call) => call[2])).toEqual(['剧本.md', '对白.txt', '原文.txt']);
    expect(mock.save.mock.calls.map((call) => new TextDecoder().decode(call[0]))).toEqual(original.map((item) => item.output));
    expect(state.nodes.map((item) => item.data.filePath)).toEqual([
      'D:/data/project/剧本.md', 'D:/data/project/对白.txt', 'D:/data/project/原文.txt',
    ]);
    expect(state.nodes.map((item) => ({ id: item.id, type: item.type, output: item.data.output }))).toEqual(original);
    await sync();
    expect(mock.save).toHaveBeenCalledTimes(3);
  });

  it('已有文件、生成中、空正文和媒体输出不创建文本副本', async () => {
    state.nodes = [node('已有', 'ai-markdown', '原文', { filePath: 'D:/data/project/已有.md' }),
      node('生成中', 'ai-text', '部分流式结果', { status: 'loading' }), node('空白', 'ai-text', ''),
      node('图片', 'source-image', 'asset://image.png')];
    expect(await sync()).toBe(true);
    expect(mock.save).not.toHaveBeenCalled();
    expect(state.updateNodeDataTransient).not.toHaveBeenCalled();
  });

  it.each(['project', 'content', 'path', 'removed', 'revision'])('写盘期间 %s 变化后不把旧结果挂回当前节点', async (change) => {
    state.nodes = [node('正文', 'ai-markdown', '原文')];
    mock.save.mockImplementationOnce(async () => {
      if (change === 'project') state.currentProjectId = 'p2';
      if (change === 'content') state.nodes = [node('正文', 'ai-markdown', '新正文')];
      if (change === 'path') state.nodes = [node('正文', 'ai-markdown', '原文', { filePath: 'D:/data/project/用户文件.md' })];
      if (change === 'removed') state.nodes = [];
      if (change === 'revision') current = false;
      return { filePath: 'D:/data/project/正文.md', assetUrl: 'asset://project/正文.md' };
    });
    expect(await sync()).toBe(false);
    expect(state.updateNodeDataTransient).not.toHaveBeenCalled();
  });

  it('保存失败保留节点正文，不记录虚假的文件路径', async () => {
    state.nodes = [node('正文', 'ai-text', '未丢失的正文')];
    mock.save.mockResolvedValueOnce(null);
    await expect(sync()).rejects.toThrow('文本文件保存失败');
    expect(state.nodes[0].data.output).toBe('未丢失的正文');
    expect(state.nodes[0].data.filePath).toBeUndefined();
    expect(state.updateNodeDataTransient).not.toHaveBeenCalled();
  });

  it('非桌面环境不尝试本地文件写入', async () => {
    mock.desktop.mockReturnValue(false);
    state.nodes = [node('正文', 'ai-markdown', '原文')];
    expect(await sync()).toBe(true);
    expect(mock.save).not.toHaveBeenCalled();
  });
});
