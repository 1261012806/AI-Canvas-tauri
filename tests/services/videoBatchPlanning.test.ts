import { beforeEach, it, expect, vi } from 'vitest';
import { useAppStore } from '../../src/store/useAppStore';
import { inspectVideoNode, videoInputFingerprint } from '../../src/services/videoBatchPlanning';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'p', showToast: vi.fn(), nodes: [{ id: 'v', type: 'ai-video', position: { x: 0, y: 0 },
    data: { type: 'ai-video', label: 'SH001', model: 'general/test', provider: 'general', prompt: '@{img:参考图} 动作', seedanceDuration: 6, videoUrl: 'old.mp4' } },
    { id: 'img', type: 'source-image', position: { x: 0, y: 0 }, data: { type: 'source-image', label: '参考图', imageUrl: 'ref.png' } }] });
});
it('detects broken reference inputs and invalid duration', () => {
  const state = useAppStore.getState();
  expect(inspectVideoNode(state.nodes[0], state).issues).toEqual([]);
  useAppStore.getState().updateNodeDataTransient('img', { imageUrl: '' });
  useAppStore.getState().updateNodeDataTransient('v', { seedanceDuration: -1 });
  const next = useAppStore.getState();
  expect(inspectVideoNode(next.nodes[0], next).issues).toEqual(expect.arrayContaining(['视频时长无效', '参考缺少内容：参考图']));
});
it('detects reference/prompt changes but not canvas movement as stale results', () => {
  const s = useAppStore.getState();
  const fingerprint = videoInputFingerprint(s.nodes[0], s);
  useAppStore.getState().updateNodeDataTransient('v', { videoBatchFingerprint: fingerprint });
  let next = useAppStore.getState();
  expect(inspectVideoNode(next.nodes[0], next).stale).toBe(false);
  const moved = { ...next.nodes[0], position: { x: 500, y: 600 } };
  expect(videoInputFingerprint(moved, next)).toBe(fingerprint);
  expect(videoInputFingerprint({ ...moved, data: { ...moved.data, cameraSettings: { lens: '85mm' } } }, next)).not.toBe(fingerprint);
  useAppStore.getState().updateNodeDataTransient('img', { imageUrl: 'new.png' });
  next = useAppStore.getState();
  expect(inspectVideoNode(next.nodes[0], next).stale).toBe(true);
});
it('inherits project video workflow defaults using the same model contract as generation', () => {
  useAppStore.setState({ projects: [{ id: 'p', name: '集', createdAt: 1, updatedAt: 1, settings: { defaultModels: { video: 'comfyui/my-workflow' } } }] });
  useAppStore.getState().updateNodeDataTransient('v', { model: undefined, provider: undefined, seedanceDuration: undefined });
  const s = useAppStore.getState();
  const result = inspectVideoNode(s.nodes[0], s);
  expect(result.issues).toContain('工作流已删除或未载入');
  expect(result.issues).not.toContain('未选择视频模型');
  expect(result.duration).toBe(5);
});

it('RefMod 文件、服务器与强度变化都会使视频预检指纹失效', () => {
  const state = useAppStore.getState();
  const original = videoInputFingerprint(state.nodes[0], state);
  const data = { ...state.nodes[0].data, comfyRefmods: [{ endpointFingerprint: 'a'.repeat(64), loaderType: 'minimax-h3' as const,
    fileName: 'character/alice', strength: 0.6, loaderNodeId: '12', slot: 1 }] };
  const bound = { ...state.nodes[0], data };
  const first = videoInputFingerprint(bound, state);
  expect(first).not.toBe(original);
  for (const patch of [{ fileName: 'character/bob' }, { strength: 0.8 }, { endpointFingerprint: 'b'.repeat(64) }]) {
    expect(videoInputFingerprint({ ...bound, data: { ...data, comfyRefmods: [{ ...data.comfyRefmods[0], ...patch }] } }, state)).not.toBe(first);
  }
});

function configureShotReference(content = '@{img:参考图} 角色推开门') {
  const state = useAppStore.getState();
  useAppStore.setState({ nodes: [
    ...state.nodes.map((node) => node.id === 'v'
      ? { ...node, data: { ...node.data, prompt: '@{sheet/shot/row-1:分镜表 第1镜} 保持固定机位' } } : node),
    { id: 'sheet', type: 'ai-shotlist', position: { x: -400, y: 0 }, data: {
      type: 'ai-shotlist', label: '本集分镜', shotlistRows: [
        { id: 'row-1', shotNo: '1', content, dialogue: '小绘：我回来了。', audio: '轻轻的推门声', duration: 6 },
        { id: 'row-2', shotNo: '2', content: '窗外的街道', dialogue: '另一镜的台词', duration: 4 },
      ],
    } },
  ], edges: [{ id: 'sheet-video', source: 'sheet', target: 'v' }] });
  return useAppStore.getState();
}

it('accepts a precise shot and its sheet edge without requiring a generated sheet output', () => {
  const state = configureShotReference();
  expect(inspectVideoNode(state.nodes[0], state).issues).toEqual([]);
  useAppStore.getState().updateNodeDataTransient('img', { imageUrl: '' });
  const next = useAppStore.getState();
  expect(inspectVideoNode(next.nodes[0], next).issues).toContain('参考缺少内容：参考图');
});

it('invalidates only the referenced shot text and real media, including when the sheet is connected', () => {
  const state = configureShotReference();
  const fingerprint = videoInputFingerprint(state.nodes[0], state);
  useAppStore.getState().updateNodeDataTransient('v', { videoBatchFingerprint: fingerprint });
  const rows = state.nodes.find((node) => node.id === 'sheet')!.data.shotlistRows!;
  useAppStore.getState().updateNodeDataTransient('sheet', {
    shotlistRows: rows.map((row) => row.id === 'row-2' ? { ...row, content: '无关镜头修改', dialogue: '新台词' } : row),
  });
  let next = useAppStore.getState();
  expect(videoInputFingerprint(next.nodes[0], next)).toBe(fingerprint);
  expect(inspectVideoNode(next.nodes[0], next).stale).toBe(false);
  useAppStore.getState().updateNodeDataTransient('sheet', {
    shotlistRows: rows.map((row) => row.id === 'row-1' ? { ...row, dialogue: '小绘：门怎么锁了？' } : row),
  });
  next = useAppStore.getState();
  expect(inspectVideoNode(next.nodes[0], next).stale).toBe(true);
  const changedDialogue = videoInputFingerprint(next.nodes[0], next);
  useAppStore.getState().updateNodeDataTransient('img', { imageUrl: 'new-reference.png' });
  next = useAppStore.getState();
  expect(videoInputFingerprint(next.nodes[0], next)).not.toBe(changedDialogue);
});

it('reports a deleted referenced shot while retaining a stable non-throwing fingerprint', () => {
  const state = configureShotReference();
  useAppStore.getState().updateNodeDataTransient('sheet', {
    shotlistRows: state.nodes.find((node) => node.id === 'sheet')!.data.shotlistRows!.slice(1),
  });
  const next = useAppStore.getState();
  expect(() => videoInputFingerprint(next.nodes[0], next)).not.toThrow();
  const inspected = inspectVideoNode(next.nodes[0], next);
  expect(inspected.issues).toEqual(expect.arrayContaining([expect.stringMatching(/镜头|分镜/)]));
  expect(inspected.fingerprint).toBe(videoInputFingerprint(next.nodes[0], next));
});

it('retains a main-prompt whole-sheet dependency when a workflow input selects a precise shot', () => {
  const state = configureShotReference();
  useAppStore.getState().updateNodeDataTransient('v', {
    prompt: '@{sheet:本集分镜}', workflowInputs: { prompt: '@{sheet/shot/row-1:第1镜}' },
  });
  let next = useAppStore.getState();
  const fingerprint = videoInputFingerprint(next.nodes[0], next);
  expect(inspectVideoNode(next.nodes[0], next).issues).toEqual([]);
  useAppStore.getState().updateNodeDataTransient('v', { videoBatchFingerprint: fingerprint });
  const rows = state.nodes.find((node) => node.id === 'sheet')!.data.shotlistRows!;
  useAppStore.getState().updateNodeDataTransient('sheet', {
    shotlistRows: rows.map((row) => row.id === 'row-2' ? { ...row, content: '整表包含的其他镜头已修改' } : row),
  });
  next = useAppStore.getState();
  expect(videoInputFingerprint(next.nodes[0], next)).not.toBe(fingerprint);
  expect(inspectVideoNode(next.nodes[0], next).stale).toBe(true);
});

it('fingerprints library media referenced inside the selected shot without unrelated library entries', () => {
  const state = configureShotReference('@drama{cup:茶杯} 茶杯放在桌上');
  useAppStore.setState({ dramaAssets: { version: 2, characters: [], scenes: [], props: [
    { id: 'cup', kind: 'prop', name: '茶杯', key: 'cup', summary: '白瓷杯', visualNotes: '', importance: 'main',
      confirmed: true, createdAt: 1, updatedAt: 1, source: 'manual', imageNodeId: 'img' },
  ] } });
  const original = videoInputFingerprint(state.nodes[0], useAppStore.getState());
  useAppStore.getState().updateNodeDataTransient('img', { imageUrl: 'new-cup.png' });
  let next = useAppStore.getState();
  const changedMedia = videoInputFingerprint(next.nodes[0], next);
  expect(changedMedia).not.toBe(original);
  useAppStore.setState({ dramaAssets: { ...next.dramaAssets, props: [...next.dramaAssets.props, {
    ...next.dramaAssets.props[0], id: 'other-cup', key: 'other-cup', name: '未使用的杯子', updatedAt: 2,
  }] } });
  next = useAppStore.getState();
  expect(videoInputFingerprint(next.nodes[0], next)).toBe(changedMedia);
});
