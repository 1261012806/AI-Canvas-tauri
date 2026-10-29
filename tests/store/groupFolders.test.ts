import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';

const PROJECT_DIR = 'D:/data/proj-1';

const { ensureGroupFolder, renameGroupFolder, moveProjectFileToFolder } = vi.hoisted(() => ({
  ensureGroupFolder: vi.fn(async () => null),
  renameGroupFolder: vi.fn(async () => true),
  // 假磁盘：只按目标目录算出新路径，已在目标目录时返回 null（不移动）
  moveProjectFileToFolder: vi.fn(async (filePath: string | undefined, dir: string, folder: string | null, options?: { preserveSource?: boolean; forceCopy?: boolean }) => {
    if (!filePath) return null;
    const name = filePath.replaceAll('\\', '/').split('/').pop()!;
    const target = folder ? `${dir}/${folder}/${name}` : `${dir}/${name}`;
    return target === filePath && !options?.forceCopy ? null : target;
  }),
}));

vi.mock('../../src/services/fileService', () => ({
  waitForPendingNodeFileDeletions: vi.fn(async () => undefined),
  resolveGroupUndoTrashPaths: vi.fn(async () => []),
  resolveNodeUndoTrashPaths: vi.fn(async () => []),
  collectNodeFileReferences: vi.fn(() => new Set<string>()),
  deletedGroupFolderNames: vi.fn(() => []),
  deleteNodeFiles: vi.fn(async () => undefined),
  setBaseDataDir: vi.fn(),
  syncAuthorizedDirectories: vi.fn(async () => undefined),
  ensureGroupFolder,
  renameGroupFolder,
  moveProjectFileToFolder,
  removeEmptyProjectGroupFolder: vi.fn(async () => undefined),
  finishProjectFileRelocation: vi.fn(async () => undefined),
  copyFileToProjectData: vi.fn(async (_path: string, _project: string) => ({ filePath: 'D:/data/proj-1/copied.png', assetUrl: 'asset://D:/data/proj-1/copied.png', fileName: 'copied.png' })),
  getProjectDataDir: vi.fn(async () => PROJECT_DIR),
  getAssetUrlFromPath: vi.fn(async (p: string) => `asset://${p}`),
  sanitizeFolderName: (name: string) => name.replace(/[<>:"|?*/\\]/g, '_'),
  stripVerbatimPrefix: (path: string) => path.replace(/^[\\/]{2}\?[\\/]/, ''),
}));

vi.mock('../../src/services/indexedDb/mediaRelocations', async (original) => ({
  ...await original<typeof import('../../src/services/indexedDb/mediaRelocations')>(),
  persistMediaRelocation: vi.fn(async () => undefined),
  pendingMediaRelocations: vi.fn(async () => []),
  completeMediaRelocation: vi.fn(async () => undefined),
}));

vi.mock('../../src/services/pollManager', () => ({
  cancelNodePolling: vi.fn(),
  clearProjectTasks: vi.fn(),
  resumePendingTasks: vi.fn(async () => undefined),
}));

import { useAppStore } from '../../src/store/useAppStore';
import { copyFileToProjectData, finishProjectFileRelocation, getProjectDataDir, removeEmptyProjectGroupFolder } from '../../src/services/fileService';
import { persistMediaRelocation, pendingMediaRelocations } from '../../src/services/indexedDb/mediaRelocations';
import { copyNodeMedia } from '../../src/services/nodeMediaCopy';

function node(id: string): Node<BaseNodeData> {
  return {
    id,
    type: 'ai-text',
    position: { x: 0, y: 0 },
    data: { label: id, type: 'ai-text', status: 'success' },
  };
}

function createGroup(nodeIds: string[]) {
  useAppStore.setState({ selectedNodeIds: nodeIds });
  useAppStore.getState().groupSelectedNodes();
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'p1', nodes: [node('a'), node('b'), node('c'), node('d')] });
  useAppStore.setState({ saveCurrentProjectSilent: vi.fn(async () => 'p1') });
  ensureGroupFolder.mockClear();
  renameGroupFolder.mockClear();
  moveProjectFileToFolder.mockClear();
  vi.mocked(finishProjectFileRelocation).mockClear();
  vi.mocked(getProjectDataDir).mockClear();
  vi.mocked(getProjectDataDir).mockResolvedValue(PROJECT_DIR);
  vi.mocked(removeEmptyProjectGroupFolder).mockClear();
  vi.mocked(persistMediaRelocation).mockClear();
  vi.mocked(pendingMediaRelocations).mockClear();
  vi.mocked(pendingMediaRelocations).mockResolvedValue([]);
});

describe('展开分组内创建和拖入空节点', () => {
  function setup() {
    const group: Node<BaseNodeData> = {
      id: 'group-test', type: 'group', position: { x: 100, y: 100 },
      data: { label: '分组', type: 'comment', groupId: 'group-test' },
      style: { width: 300, height: 200 },
      width: 1000, height: 700, measured: { width: 1000, height: 700 },
    };
    const empty: Node<BaseNodeData> = {
      id: 'empty', type: 'ai-image', position: { x: 700, y: 400 },
      data: { label: '空图像', type: 'ai-image', status: 'idle', nodeWidth: 280, nodeHeight: 160 },
    };
    useAppStore.setState({
      nodes: [group], edges: [],
      groups: [{ id: group.id, name: '分组', nodeIds: [], color: '#888888', createdAt: 0 }],
    });
    return { group, empty };
  }

  it('在扩大后的分组空白区新建无内容节点，位置和成员关系一起撤销', async () => {
    const { group, empty } = setup();
    useAppStore.getState().addNode(empty);
    expect(useAppStore.getState().nodes[1]).toMatchObject({ parentId: group.id, position: { x: 600, y: 300 } });
    expect(useAppStore.getState().groups[0].nodeIds).toEqual(['empty']);
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes.map((n) => n.id)).toEqual([group.id]);
    expect(useAppStore.getState().groups[0].nodeIds).toEqual([]);
    await useAppStore.getState().redo();
    expect(useAppStore.getState().nodes[1].parentId).toBe(group.id);
  });

  it('连线创建节点时同时入组，一次撤销清除节点、连线和成员关系', async () => {
    const { group, empty } = setup();
    useAppStore.setState({ nodes: [group, node('source')] });
    useAppStore.getState().addNodeWithEdge(empty, { id: 'edge', source: 'source', target: 'empty' });
    expect(useAppStore.getState().nodes[2].parentId).toBe(group.id);
    expect(useAppStore.getState().edges).toHaveLength(1);
    await useAppStore.getState().undo();
    expect(useAppStore.getState().nodes).toHaveLength(2);
    expect(useAppStore.getState().edges).toEqual([]);
    expect(useAppStore.getState().groups[0].nodeIds).toEqual([]);
  });

  it('空节点早于分组创建，拖入后父节点在前，且保留其他空分组', () => {
    const { group, empty } = setup();
    const other = { ...group, id: 'other', position: { x: 2000, y: 0 }, data: { ...group.data, groupId: 'other' } };
    useAppStore.setState({ nodes: [empty, group, other], groups: [
      ...useAppStore.getState().groups,
      { id: 'other', name: '空分组', nodeIds: [], color: '#888888', createdAt: 0 },
    ] });
    useAppStore.getState().settleNodeGroupingOnDragStop(empty);
    const state = useAppStore.getState();
    expect(state.nodes.find((n) => n.id === 'empty')).toMatchObject({ parentId: group.id, position: { x: 600, y: 300 } });
    expect(state.nodes.findIndex((n) => n.id === group.id)).toBeLessThan(state.nodes.findIndex((n) => n.id === 'empty'));
    expect(state.groups.find((g) => g.id === 'other')).toBeDefined();
  });

  it('拖动使用节点实际尺寸，不因历史业务尺寸过大误判在组外', () => {
    const { group, empty } = setup();
    const dragged = { ...empty, measured: { width: 100, height: 100 }, position: { x: 1000, y: 600 }, data: { ...empty.data, nodeWidth: 1000 } };
    useAppStore.setState({ nodes: [group, dragged] });
    useAppStore.getState().settleNodeGroupingOnDragStop(dragged);
    expect(useAppStore.getState().nodes[1].parentId).toBe(group.id);
  });

  it('拖出分组还原绝对坐标，不影响其他分组的成员', () => {
    const { group, empty } = setup();
    useAppStore.getState().addNode(empty);
    const moved = { ...useAppStore.getState().nodes[1], position: { x: 1400, y: 900 } };
    useAppStore.getState().settleNodeGroupingOnDragStop(moved);
    expect(useAppStore.getState().nodes.find((n) => n.id === empty.id)).toMatchObject({ parentId: undefined, position: { x: 1500, y: 1000 } });
    expect(useAppStore.getState().groups.some((g) => g.id === group.id)).toBe(false);
  });

  it('新建节点不会自动藏进折叠分组，显式父节点保持原坐标', () => {
    const { group, empty } = setup();
    useAppStore.setState({ nodes: [{ ...group, data: { ...group.data, groupCollapsed: true } }] });
    useAppStore.getState().addNode(empty);
    expect(useAppStore.getState().nodes[1].parentId).toBeUndefined();
    useAppStore.getState().addNode({ ...empty, id: 'child', parentId: group.id, position: { x: 20, y: 30 } });
    expect(useAppStore.getState().nodes[2]).toMatchObject({ parentId: group.id, position: { x: 20, y: 30 } });
  });
});

describe('分组与本地文件夹同步', () => {
  it('MCP 导入的深层图片入组后提交路径迁移并放入分组目录', async () => {
    const path = `${PROJECT_DIR}/images/EP000/portrait.png`;
    const imported = { ...node('imported'), type: 'source-image', data: { ...node('imported').data,
      type: 'source-image', role: 'source', filePath: path, imageUrl: `asset://${path}`, relativePath: 'images/EP000/portrait.png' } } as Node<BaseNodeData>;
    useAppStore.setState({ nodes: [imported, node('b')] });
    createGroup(['imported', 'b']);
    await useAppStore.getState().syncGroupFiles();
    expect(moveProjectFileToFolder).toHaveBeenCalledWith(path, PROJECT_DIR, '分组', { preserveSource: true, forceCopy: false });
    expect(useAppStore.getState().nodes.find((item) => item.id === 'imported')?.data).toMatchObject({
      type: 'source-image', filePath: `${PROJECT_DIR}/分组/portrait.png`, relativePath: '分组/portrait.png',
    });
    expect(persistMediaRelocation).toHaveBeenCalledWith(expect.objectContaining({ oldPath: path,
      newPath: `${PROJECT_DIR}/分组/portrait.png`, projectId: 'p1' }), undefined);
    expect(finishProjectFileRelocation).toHaveBeenCalledWith(path, `${PROJECT_DIR}/分组/portrait.png`, PROJECT_DIR);
  });

  it('未分组的深层导入素材保持原目录，隐藏及私有子目录不参与归档', async () => {
    const untouched = { ...node('outside'), data: { ...node('outside').data, filePath: `${PROJECT_DIR}/images/EP000/outside.png` } };
    const protectedNodes = ['.trash/EP000', 'images/.thumbnail', 'images/AppData', 'images/agent-private',
      'images/plugin-private', 'images/blender-private', 'images/secrets', 'images/../EP000'].map((folder, index) => ({
      ...node(`protected-${index}`), data: { ...node(`protected-${index}`).data, filePath: `${PROJECT_DIR}/${folder}/portrait.png` },
    }));
    useAppStore.setState({ nodes: [untouched, ...protectedNodes] });
    createGroup(protectedNodes.map((item) => item.id));
    await useAppStore.getState().syncGroupFiles();
    expect(moveProjectFileToFolder).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes.find((item) => item.id === untouched.id)?.data.filePath).toBe(untouched.data.filePath);
  });

  it('深层共享文件仅复制入组节点的引用，未分组节点继续读取原文件', async () => {
    const path = `${PROJECT_DIR}/images/EP000/shared.png`;
    const original = { ...node('a'), data: { ...node('a').data, filePath: path, imageUrl: `asset://${path}` } };
    const outside = { ...node('outside'), data: { ...node('outside').data, filePath: path, imageUrl: `asset://${path}` } };
    useAppStore.setState({ nodes: [original, node('b'), outside] });
    createGroup(['a', 'b']);
    await useAppStore.getState().syncGroupFiles();
    expect(moveProjectFileToFolder).toHaveBeenCalledWith(path, PROJECT_DIR, '分组', { preserveSource: true, forceCopy: true });
    expect(persistMediaRelocation).toHaveBeenCalledWith(expect.objectContaining({ oldPath: path, ownerId: 'a' }), 'a');
    expect(useAppStore.getState().nodes.find((item) => item.id === 'a')?.data.filePath).toBe(`${PROJECT_DIR}/分组/shared.png`);
    expect(useAppStore.getState().nodes.find((item) => item.id === 'outside')?.data.filePath).toBe(path);
    expect(finishProjectFileRelocation).not.toHaveBeenCalled();
  });

  it('没有迁移时不保存，正文更新也不重新遍历或请求项目目录', async () => {
    await useAppStore.getState().syncGroupFiles();
    const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent);
    expect(save).not.toHaveBeenCalled();
    vi.mocked(getProjectDataDir).mockClear();
    useAppStore.getState().updateNodeDataTransient('a', { output: '新的正文' });
    await useAppStore.getState().syncGroupFiles();
    expect(getProjectDataDir).not.toHaveBeenCalled();
    expect(moveProjectFileToFolder).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('媒体签名未变也检查并恢复 pending，不依赖下一次编辑', async () => {
    await useAppStore.getState().syncGroupFiles();
    const move = { oldPath: `${PROJECT_DIR}/old.png`, newPath: `${PROJECT_DIR}/new.png`,
      projectId: 'p1', assetUrl: `asset://${PROJECT_DIR}/new.png`, relativePath: 'new.png' };
    vi.mocked(pendingMediaRelocations).mockResolvedValueOnce([move]);
    await useAppStore.getState().syncGroupFiles();
    expect(useAppStore.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
    expect(finishProjectFileRelocation).toHaveBeenCalledWith(move.oldPath, move.newPath, PROJECT_DIR);
  });

  it('只保留最近项目的媒体签名，回访项目会重新检查目录', async () => {
    await useAppStore.getState().syncGroupFiles();
    useAppStore.setState({ currentProjectId: 'p2' });
    await useAppStore.getState().syncGroupFiles();
    vi.mocked(getProjectDataDir).mockClear();
    useAppStore.setState({ currentProjectId: 'p1' });
    await useAppStore.getState().syncGroupFiles();
    expect(getProjectDataDir).toHaveBeenCalledOnce();
    expect(getProjectDataDir).toHaveBeenCalledWith('p1');
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
  });

  it('已在目标目录的大画布只线性读取媒体字段', async () => {
    const count = 1000;
    let pathReads = 0;
    const nodes = Array.from({ length: count }, (_, index) => {
      const result = node(`media-${index}`);
      Object.defineProperty(result.data, 'filePath', {
        enumerable: true, get: () => { pathReads += 1; return `${PROJECT_DIR}/${index}.png`; },
      });
      return result;
    });
    useAppStore.setState({ nodes });
    await useAppStore.getState().syncGroupFiles();
    expect(pathReads).toBeLessThan(count * 20);
    expect(moveProjectFileToFolder).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
  });

  it('复制租约暂时跳过的源文件不会被缓存为已同步', async () => {
    const path = `${PROJECT_DIR}/pinned.png`;
    const source = { ...node('a'), data: { ...node('a').data, filePath: path } };
    useAppStore.setState({ nodes: [source, node('b')] });
    createGroup(['a', 'b']);
    let release!: (result: { filePath: string; assetUrl: string; fileName: string }) => void;
    vi.mocked(copyFileToProjectData).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const copying = copyNodeMedia(source.data, 'p1');
    await useAppStore.getState().syncGroupFiles();
    expect(moveProjectFileToFolder).not.toHaveBeenCalled();
    release({ filePath: `${PROJECT_DIR}/copied.png`, assetUrl: 'asset://copied.png', fileName: 'copied.png' });
    await copying;
    await useAppStore.getState().syncGroupFiles();
    expect(useAppStore.getState().nodes.find((item) => item.id === 'a')?.data.filePath).toBe(`${PROJECT_DIR}/分组/pinned.png`);
  });

  it('一个项目等待 IO 时，另一个项目的恢复请求会在退出后执行', async () => {
    let release!: (moves: []) => void;
    vi.mocked(pendingMediaRelocations).mockImplementationOnce(() => new Promise<[]>((resolve) => { release = resolve; }));
    const first = useAppStore.getState().syncGroupFiles();
    const move = { oldPath: `${PROJECT_DIR}/old.png`, newPath: `${PROJECT_DIR}/new.png`,
      projectId: 'p2', assetUrl: `asset://${PROJECT_DIR}/new.png`, relativePath: 'new.png' };
    useAppStore.setState({ currentProjectId: 'p2' });
    vi.mocked(useAppStore.getState().saveCurrentProjectSilent).mockResolvedValue('p2');
    vi.mocked(pendingMediaRelocations).mockResolvedValueOnce([move]);
    await useAppStore.getState().syncGroupFiles();
    release([]);
    await first;
    expect(pendingMediaRelocations).toHaveBeenCalledWith('p2');
    expect(finishProjectFileRelocation).toHaveBeenCalledWith(move.oldPath, move.newPath, PROJECT_DIR);
  });

  it('同项目只有 revision 变化时不立即重跑，显式请求仍可重试', async () => {
    let revision = 0;
    useAppStore.setState({ getCurrentRevision: () => revision });
    let release!: (moves: []) => void;
    vi.mocked(pendingMediaRelocations).mockImplementationOnce(() => new Promise<[]>((resolve) => { release = resolve; }));
    const syncing = useAppStore.getState().syncGroupFiles();
    revision += 1;
    release([]);
    await syncing;
    expect(pendingMediaRelocations).toHaveBeenCalledOnce();
    expect(getProjectDataDir).not.toHaveBeenCalled();
    await useAppStore.getState().syncGroupFiles();
    expect(pendingMediaRelocations).toHaveBeenCalledTimes(2);
    expect(getProjectDataDir).toHaveBeenCalledOnce();
  });

  it('忙碌期间的同项目请求合并成后续一轮', async () => {
    useAppStore.setState({ nodes: [node('coalesced')] });
    let release!: (moves: []) => void;
    vi.mocked(pendingMediaRelocations).mockImplementationOnce(() => new Promise<[]>((resolve) => { release = resolve; }));
    const syncing = useAppStore.getState().syncGroupFiles();
    await useAppStore.getState().syncGroupFiles();
    await useAppStore.getState().syncGroupFiles();
    release([]);
    await syncing;
    expect(pendingMediaRelocations).toHaveBeenCalledTimes(2);
    expect(getProjectDataDir).toHaveBeenCalledOnce();
  });

  it('复制期间同项目改源会重扫最新文件，旧结果不写回', async () => {
    let revision = 0;
    useAppStore.setState({ getCurrentRevision: () => revision });
    const oldPath = `${PROJECT_DIR}/old.png`;
    const newPath = `${PROJECT_DIR}/regenerated.png`;
    useAppStore.setState({ nodes: [{ ...node('a'), data: { ...node('a').data, filePath: oldPath } }, node('b')] });
    createGroup(['a', 'b']);
    let release!: (path: string) => void;
    moveProjectFileToFolder.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const syncing = useAppStore.getState().syncGroupFiles();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    useAppStore.getState().updateNodeDataTransient('a', { filePath: newPath, output: '生成完成' });
    revision += 1;
    release(`${PROJECT_DIR}/分组/old.png`);
    await syncing;
    expect(persistMediaRelocation).not.toHaveBeenCalledWith(expect.objectContaining({ oldPath }), undefined);
    expect(useAppStore.getState().nodes.find((item) => item.id === 'a')?.data)
      .toMatchObject({ filePath: `${PROJECT_DIR}/分组/regenerated.png`, output: '生成完成' });
  });

  it('等待保存期间新增旧路径引用时，重扫并再次保存后才清理源文件', async () => {
    const path = `${PROJECT_DIR}/a.png`;
    useAppStore.setState({ nodes: [{ ...node('a'), data: { ...node('a').data, filePath: path } }, node('b')] });
    createGroup(['a', 'b']);
    let release!: (id: string) => void;
    vi.mocked(useAppStore.getState().saveCurrentProjectSilent)
      .mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const syncing = useAppStore.getState().syncGroupFiles();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    useAppStore.getState().updateNodeDataTransient('b', { filePath: path });
    release('p1');
    await syncing;
    const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent);
    expect(save).toHaveBeenCalledTimes(2);
    expect(finishProjectFileRelocation).toHaveBeenCalledOnce();
    expect(vi.mocked(finishProjectFileRelocation).mock.invocationCallOrder[0]).toBeGreaterThan(save.mock.invocationCallOrder[1]);
  });

  it('空分组改名也先保存，再清理旧空目录', async () => {
    createGroup(['a', 'b']);
    const groupId = useAppStore.getState().groups[0].id;
    useAppStore.getState().renameGroup(groupId, '空镜头');
    await vi.waitFor(() => expect(removeEmptyProjectGroupFolder).toHaveBeenCalledWith(PROJECT_DIR, '分组'));
    const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent);
    expect(save).toHaveBeenCalled();
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(removeEmptyProjectGroupFolder).mock.invocationCallOrder[0]);
  });

  it('保存失败时保留源文件，下次同步完成已提交迁移', async () => {
    const path = `${PROJECT_DIR}/a.png`;
    useAppStore.setState({ nodes: [{ ...node('a'), data: { ...node('a').data, filePath: path } }, node('b')] });
    createGroup(['a', 'b']);
    useAppStore.setState({ saveCurrentProjectSilent: vi.fn(async () => undefined) });
    await useAppStore.getState().syncGroupFiles();
    expect(finishProjectFileRelocation).not.toHaveBeenCalled();
    vi.mocked(pendingMediaRelocations).mockResolvedValueOnce([{
      oldPath: path, newPath: `${PROJECT_DIR}/分组/a.png`, projectId: 'p1',
      assetUrl: `asset://${PROJECT_DIR}/分组/a.png`, relativePath: '分组/a.png',
    }]);
    useAppStore.setState({ saveCurrentProjectSilent: vi.fn(async () => 'p1') });
    await useAppStore.getState().syncGroupFiles();
    expect(finishProjectFileRelocation).toHaveBeenCalledWith(path, `${PROJECT_DIR}/分组/a.png`, PROJECT_DIR);
  });

  it('引用事务失败时不删除源文件也不改写节点', async () => {
    const path = `${PROJECT_DIR}/a.png`;
    useAppStore.setState({ nodes: [{ ...node('a'), data: { ...node('a').data, filePath: path } }, node('b')] });
    createGroup(['a', 'b']);
    vi.mocked(persistMediaRelocation).mockRejectedValueOnce(new Error('quota exceeded'));
    await useAppStore.getState().syncGroupFiles();
    expect(finishProjectFileRelocation).not.toHaveBeenCalled();
    expect(useAppStore.getState().nodes.find((item) => item.id === 'a')?.data.filePath).toBe(path);
  });

  it('复制节点使用独立文件，入组和重新生成不影响另一节点', async () => {
    const original = `${PROJECT_DIR}/original.png`;
    useAppStore.setState({ nodes: [{
      ...node('a'), type: 'ai-image',
      data: { label: 'image', type: 'ai-image', filePath: original, imageUrl: `asset://${original}` },
    }, node('b')] });
    await useAppStore.getState().duplicateNode('a');
    const clone = useAppStore.getState().nodes.find((n) => n.id !== 'a' && n.id !== 'b')!;
    createGroup(['a', 'b']);
    await useAppStore.getState().syncGroupFiles();
    expect(useAppStore.getState().nodes.find((n) => n.id === clone.id)?.data.filePath).toBe(`${PROJECT_DIR}/copied.png`);

    const regenerated = `${PROJECT_DIR}/regenerated.png`;
    useAppStore.getState().updateNodeData('a', { filePath: regenerated, imageUrl: `asset://${regenerated}` });
    await useAppStore.getState().syncGroupFiles();
    expect(useAppStore.getState().nodes.find((n) => n.id === 'a')?.data.filePath)
      .toBe(`${PROJECT_DIR}/分组/regenerated.png`);
    expect(useAppStore.getState().nodes.find((n) => n.id === clone.id)?.data.imageUrl).toBe(`asset://${PROJECT_DIR}/copied.png`);
  });

  it('旧分镜格与图片共用文件时，归档先拆分独立副本再迁移最后一个引用', async () => {
    const path = `${PROJECT_DIR}/shared.png`;
    useAppStore.setState({ nodes: [
      { ...node('a'), data: { ...node('a').data, filePath: path, imageUrl: `asset://${path}` } },
      { ...node('b'), data: { ...node('b').data, storyboardOverrides: [{ filePath: path.replaceAll('/', '\\'), url: `asset://${path}` }] } },
    ] });
    createGroup(['a', 'b']);
    await useAppStore.getState().syncGroupFiles();
    const calls = moveProjectFileToFolder.mock.calls.filter(([file]) => !!file);
    expect(calls).toHaveLength(2);
    expect(calls[0][3]?.forceCopy).toBe(true);
    expect(calls[1][3]?.forceCopy).toBe(false);
    expect(calls.every((call) => call[3]?.preserveSource)).toBe(true);
  });

  it('文件移动期间切换项目，不把旧结果写入新项目的同名节点', async () => {
    const path = `${PROJECT_DIR}/a.png`;
    useAppStore.setState({ nodes: [{ ...node('a'), data: { ...node('a').data, filePath: path } }, node('b')] });
    createGroup(['a', 'b']);
    let finish!: (path: string) => void;
    moveProjectFileToFolder.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const syncing = useAppStore.getState().syncGroupFiles();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    useAppStore.setState({ currentProjectId: 'p2', nodes: [{ ...node('a'), data: { ...node('a').data, filePath: path } }] });
    finish(`${PROJECT_DIR}/分组/a.png`);
    await syncing;
    expect(useAppStore.getState().nodes[0].data.filePath).toBe(path);
  });

  it('创建分组时用不重名的分组名建文件夹', () => {
    createGroup(['a', 'b']);
    createGroup(['c', 'd']);

    expect(useAppStore.getState().groups.map((g) => g.name)).toEqual(['分组', '分组 2']);
    expect(ensureGroupFolder.mock.calls).toEqual([
      ['p1', '分组'],
      ['p1', '分组 2'],
    ]);
  });

  it('改名时同步重命名文件夹并更新分组节点标签', async () => {
    createGroup(['a', 'b']);
    const groupId = useAppStore.getState().groups[0].id;

    useAppStore.getState().renameGroup(groupId, '镜头一');

    expect(ensureGroupFolder).toHaveBeenCalledWith('p1', '镜头一');
    expect(renameGroupFolder).not.toHaveBeenCalled();
    expect(useAppStore.getState().groups[0].name).toBe('镜头一');
    expect(useAppStore.getState().nodes.find((n) => n.id === groupId)?.data.label).toBe('镜头一');
    await vi.waitFor(() => expect(removeEmptyProjectGroupFolder).toHaveBeenCalledWith(PROJECT_DIR, '分组'));
  });

  it('文件跟着分组走：入组搬进分组文件夹，出组搬回项目根目录', async () => {
    const media = (id: string): Node<BaseNodeData> => ({
      id,
      type: 'ai-image',
      position: { x: 0, y: 0 },
      data: {
        label: id,
        type: 'ai-image',
        filePath: `${PROJECT_DIR}/${id}.png`,
        imageUrl: `asset://${PROJECT_DIR}/${id}.png`,
        thumbnailUrl: `asset://${PROJECT_DIR}/${id}.png`,
      },
    });
    useAppStore.setState({ nodes: [media('a'), media('b')] });

    createGroup(['a', 'b']);
    await useAppStore.getState().syncGroupFiles();

    const grouped = useAppStore.getState().nodes.find((n) => n.id === 'a')!;
    expect(grouped.data.filePath).toBe(`${PROJECT_DIR}/分组/a.png`);
    expect(grouped.data.relativePath).toBe('分组/a.png');
    expect(grouped.data.imageUrl).toBe(`asset://${PROJECT_DIR}/分组/a.png`);
    expect(grouped.data.thumbnailUrl).toBe(`asset://${PROJECT_DIR}/分组/a.png`);

    // 再跑一次：文件已在目标目录，不应重复搬运
    moveProjectFileToFolder.mockClear();
    await useAppStore.getState().syncGroupFiles();
    expect(useAppStore.getState().nodes.find((n) => n.id === 'a')!.data.filePath)
      .toBe(`${PROJECT_DIR}/分组/a.png`);

    useAppStore.setState({ selectedNodeIds: ['a', 'b'] });
    useAppStore.getState().ungroupSelectedNodes();
    await useAppStore.getState().syncGroupFiles();

    const ungrouped = useAppStore.getState().nodes.find((n) => n.id === 'a')!;
    expect(ungrouped.data.filePath).toBe(`${PROJECT_DIR}/a.png`);
    expect(ungrouped.data.relativePath).toBe('a.png');
  });

  it('分组改名后节点路径改写到新文件夹', async () => {
    useAppStore.setState({
      nodes: [{
        id: 'a',
        type: 'ai-image',
        parentId: 'g1',
        position: { x: 0, y: 0 },
        data: {
          label: 'a',
          type: 'ai-image',
          filePath: `${PROJECT_DIR}/分组/a.png`,
          imageUrl: `asset://${PROJECT_DIR}/分组/a.png`,
          relativePath: '分组/a.png',
          storyboardOverrides: [{ url: `asset://${PROJECT_DIR}/分组/cell.png`, filePath: `${PROJECT_DIR}/分组/cell.png` }],
        },
      } as Node<BaseNodeData>],
      groups: [{ id: 'g1', name: '分组', nodeIds: ['a'], color: '#fff', createdAt: 0 }],
    });

    useAppStore.getState().renameGroup('g1', 'Na');
    await vi.waitFor(() => {
      expect(useAppStore.getState().nodes[0].data.filePath).toBe(`${PROJECT_DIR}/Na/a.png`);
    });

    const data = useAppStore.getState().nodes[0].data;
    expect(data.relativePath).toBe('Na/a.png');
    expect(data.imageUrl).toBe(`asset://${PROJECT_DIR}/Na/a.png`);
    expect(data.storyboardOverrides?.[0]?.filePath).toBe(`${PROJECT_DIR}/Na/cell.png`);
    expect(data.storyboardOverrides?.[0]?.url).toBe(`asset://${PROJECT_DIR}/Na/cell.png`);
  });

  it('同名改名不触发文件夹操作', () => {
    createGroup(['a', 'b']);
    const groupId = useAppStore.getState().groups[0].id;

    useAppStore.getState().renameGroup(groupId, '分组');

    expect(renameGroupFolder).not.toHaveBeenCalled();
  });
});
