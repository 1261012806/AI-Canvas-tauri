import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryRecord } from '../../src/services/indexedDbService';

interface Harness {
  states: unknown[]; refs: Array<{ current: unknown }>;
  effects: Array<{ deps?: readonly unknown[]; cleanup?: () => void }>;
  pending: Array<() => void>; stateIndex: number; refIndex: number; effectIndex: number;
}
const driver = vi.hoisted(() => ({ current: null as Harness | null, load: vi.fn(), copy: vi.fn() }));
vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useState: <T,>(initial: T | (() => T)) => {
    const scope = driver.current!; const index = scope.stateIndex++;
    if (!(index in scope.states)) scope.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [scope.states[index], (value: T | ((old: T) => T)) => {
      scope.states[index] = typeof value === 'function' ? (value as (old: T) => T)(scope.states[index] as T) : value;
    }];
  },
  useRef: <T,>(initial: T) => { const scope = driver.current!; return scope.refs[scope.refIndex++] ??= { current: initial }; },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const scope = driver.current!; const index = scope.effectIndex++; const old = scope.effects[index];
    if (old && deps?.length === old.deps?.length && deps?.every((dep, i) => Object.is(dep, old.deps?.[i]))) return;
    scope.pending.push(() => { old?.cleanup?.(); scope.effects[index] = { deps, cleanup: effect() ?? undefined }; });
  },
}));
vi.mock('../../src/services/assetVideoDetails', async () => ({
  ...await vi.importActual<typeof import('../../src/services/assetVideoDetails')>('../../src/services/assetVideoDetails'),
  loadAssetVideoHistory: (...args: unknown[]) => driver.load(...args),
}));
vi.mock('../../src/services/clipboardService', () => ({ copyText: driver.copy }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: 'modal-overlay' }));
import AssetVideoPreview from '../../src/components/assets/AssetVideoPreview';
import VideoPlayer from '../../src/components/shared/VideoPlayer';

type Element = ReactElement<Record<string, unknown> & { children?: unknown; ref?: { current: unknown } }>;
type Props = ComponentProps<typeof AssetVideoPreview>;
let scope: Harness; let input: Props; let tree: unknown;
const history = (id = 'record'): HistoryRecord => ({ id, projectId: 'project', nodeId: 'node', nodeLabel: '视频', timestamp: 1,
  prompt: `提示词 ${id}`, output: 'https://videos.test/a.mp4', filePath: '/a.mp4', nodeType: 'ai-video', model: 'video-model',
  provider: 'provider', status: 'success', params: { seedanceResolution: '1080p', seedanceDuration: 5 } });
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element; return [element, ...elements(element.props.children)];
}
function find(predicate: (element: Element) => boolean): Element { const found = elements(tree).find(predicate); expect(found).toBeDefined(); return found!; }
function control(label: string) { return find((el) => el.props['aria-label'] === label || el.props.children === label
  || el.type === 'button' && Array.isArray(el.props.children) && el.props.children.includes(label)); }
function click(element: Element) { (element.props.onClick as () => void)(); }
function render() {
  driver.current = scope; scope.stateIndex = scope.refIndex = scope.effectIndex = 0; tree = AssetVideoPreview(input);
  scope.pending.splice(0).forEach((effect) => effect());
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function player() { return find((el) => el.type === VideoPlayer); }
beforeEach(() => {
  scope = { states: [], refs: [], effects: [], pending: [], stateIndex: 0, refIndex: 0, effectIndex: 0 };
  input = { src: 'https://videos.test/a.mp4?preview=1', querySrc: 'https://videos.test/a.mp4', filePath: '/a.mp4', name: '视频.mp4',
    projectId: 'project', unavailable: true, size: 1024, onClose: vi.fn(), onSourceError: vi.fn() };
  driver.load.mockReset().mockResolvedValue(history()); driver.copy.mockReset().mockResolvedValue(true);
});
afterEach(() => { scope.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe('asset video fullscreen preview', () => {
  it('读取原始媒体引用、提示词和真实尺寸，复制保留完整文本', async () => {
    render(); await settle();
    expect(driver.load).toHaveBeenCalledWith('/a.mp4', 'https://videos.test/a.mp4', 'project', expect.any(AbortSignal));
    expect(control('提示词 record')).toBeDefined(); expect(control('1080p')).toBeDefined();
    (player().props.onMetadata as (metadata: unknown) => void)({ width: 1920, height: 1080, duration: 5 }); render(); expect(control('1920 × 1080')).toBeDefined(); expect(control('5 秒')).toBeDefined();
    click(control('复制提示词')); await settle(); expect(driver.copy).toHaveBeenCalledWith('提示词 record');
    expect(control('提示词已复制')).toBeDefined();
    expect(player().props.autoPlay).toBe(true); expect(player().props.onEscape).toBe(input.onClose);
  });
  it('历史卡片使用指定记录，不查询另一条更晚记录', async () => {
    input = { ...input, historyRecord: history('old') }; render(); await settle();
    expect(driver.load).not.toHaveBeenCalled(); expect(control('提示词 old')).toBeDefined();
  });
  it('缺少记录与查询失败分别显示，失败可重试', async () => {
    driver.load.mockResolvedValueOnce(null); render(); await settle();
    expect(control('暂无生成信息')).toBeDefined(); expect(control('复制提示词').props.disabled).toBe(true);
    driver.load.mockRejectedValueOnce(new Error('read error')); input = { ...input, filePath: '/b.mp4' }; render(); await settle();
    expect(control('生成信息读取失败')).toBeDefined(); click(control('重试读取')); render(); await settle();
    expect(control('提示词 record')).toBeDefined();
  });
  it('切换来源取消旧读取并忽略迟到结果', async () => {
    let finish!: (record: HistoryRecord) => void;
    driver.load.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })); render();
    const request = driver.load.mock.calls[0][3] as AbortSignal;
    input = { ...input, filePath: '/b.mp4', src: 'https://videos.test/b.mp4', querySrc: 'https://videos.test/b.mp4' };
    render(); await settle(); finish(history('late')); await settle();
    expect(request.aborted).toBe(true); expect(control('提示词 record')).toBeDefined();
    expect(elements(tree).some((el) => el.props.children === '提示词 late')).toBe(false);
  });
  it('播放器上报错误与尺寸，外层关闭继续由资产预览处理', async () => {
    render(); await settle(); expect(player().props.src).toBe(input.src);
    (player().props.onError as () => void)(); render(); expect(input.onSourceError).toHaveBeenCalledOnce();
    expect(control('无法读取')).toBeDefined(); click(control('关闭视频预览')); expect(input.onClose).toHaveBeenCalledOnce();
    (player().props.onMetadata as (metadata: unknown) => void)({ width: 1280, height: 720, duration: 3.5 }); render();
    expect(control('1280 × 720')).toBeDefined(); expect(control('3.5 秒')).toBeDefined();
  });
});
