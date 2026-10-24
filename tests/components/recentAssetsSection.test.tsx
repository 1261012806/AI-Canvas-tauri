import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { RecentAssetEntry } from '../../src/services/fs/recentAssets';

interface Element { type: unknown; props: Record<string, unknown> & { children?: unknown } }
const driver = vi.hoisted(() => ({
  state: {} as AppState, values: [] as unknown[], index: 0,
  memoIndex: 0, memos: [] as Array<{ value: unknown; deps: readonly unknown[] }>,
  effectIndex: 0, effects: [] as Array<{ deps: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>, dirty: false, load: vi.fn(), mark: vi.fn(), open: vi.fn(),
}));
vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('react', async () => {
  const memo = <T,>(factory: () => T, deps: readonly unknown[]) => {
    const index = driver.memoIndex++; const previous = driver.memos[index];
    if (!previous || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      driver.memos[index] = { value: factory(), deps };
    }
    return driver.memos[index].value as T;
  };
  return { ...await vi.importActual<typeof import('react')>('react'), useMemo: memo,
    useCallback: <T,>(callback: T, deps: readonly unknown[]) => memo(() => callback, deps),
    useState: <T,>(initial: T | (() => T)) => {
      const index = driver.index++;
      if (!(index in driver.values)) driver.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [driver.values[index], (next: T | ((old: T) => T)) => {
        const value = typeof next === 'function' ? (next as (old: T) => T)(driver.values[index] as T) : next;
        if (!Object.is(value, driver.values[index])) driver.dirty = true;
        driver.values[index] = value;
      }];
    },
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const index = driver.effectIndex++; const old = driver.effects[index];
      if (old && deps.length === old.deps.length && deps.every((value, i) => Object.is(value, old.deps[i]))) return;
      driver.pending[index] = () => { old?.cleanup?.(); driver.effects[index] = { deps, cleanup: effect() ?? undefined }; };
    },
    useRef: <T,>(value: T) => ({ current: value }),
    useLayoutEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const index = driver.effectIndex++; const old = driver.effects[index];
      if (old && deps.length === old.deps.length && deps.every((v, i) => Object.is(v, old.deps[i]))) return;
      driver.pending[index] = () => { old?.cleanup?.(); driver.effects[index] = { deps, cleanup: effect() ?? undefined }; };
    },
  };
});
vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: (selector: (state: AppState) => unknown) => selector(driver.state) }));
vi.mock('../../src/services/fs/recentAssets', () => ({ loadRecentAssets: driver.load }));
vi.mock('../../src/services/fileService', () => ({ getConvertFileSrc: vi.fn() }));
vi.mock('../../src/components/shared/AssetThumb', () => ({ default: 'asset-thumb' }));
vi.mock('../../src/components/assets/AssetImagePreview', () => ({ default: 'image-preview' }));
import RecentAssetsSection from '../../src/components/assets/RecentAssetsSection';
let tree: Element; let win: EventTarget;
function all(root: unknown, predicate: (element: Element) => boolean): Element[] {
  if (Array.isArray(root)) return root.flatMap((child) => all(child, predicate));
  if (!root || typeof root !== 'object' || !('props' in root)) return [];
  const element = root as Element;
  return [...(predicate(element) ? [element] : []), ...all(element.props.children, predicate)];
}
function find(predicate: (element: Element) => boolean) {
  const result = all(tree, predicate)[0]; expect(result).toBeDefined(); return result;
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value === 'string') return value;
  return value && typeof value === 'object' && 'props' in value ? text((value as Element).props.children) : '';
}
function render() {
  for (let pass = 0; pass < 5; pass++) {
    driver.index = 0; driver.memoIndex = 0; driver.effectIndex = 0; driver.dirty = false;
    tree = RecentAssetsSection() as Element; if (!driver.dirty) break;
  }
  const pending = driver.pending; driver.pending = []; pending.forEach((effect) => effect());
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function entry(id = 'image', category: 'image' | 'video' | 'text' = 'image'): RecentAssetEntry {
  return { usedAt: 1, projectId: 'project', file: { assetId: id, name: `${id}.png`, path: `/projects/project/${id}.png`, assetUrl: `asset://${id}`, size: 12, category } };
}
beforeEach(() => {
  driver.values = []; driver.memos = []; driver.effects = []; driver.pending = [];
  driver.load.mockReset().mockResolvedValue([]); driver.open.mockReset(); driver.mark.mockReset().mockResolvedValue(true);
  driver.state = { projects: [{ id: 'project', name: '项目一' }], config: { assetFolders: ['/external/素材'] },
    recentAssetsRevision: 0, assetsPanelOpen: false, setAssetsPanelOpen: driver.open, markAssetUsed: driver.mark,
  } as unknown as AppState;
  win = new EventTarget(); vi.stubGlobal('window', win);
});
afterEach(() => { driver.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe('启动页最近使用资源区', () => {
  it('入口直接打开全局资产，空状态提供关联目录快捷入口', async () => {
    render(); await settle(); expect(text(tree)).toContain('暂无最近使用素材');
    const open = find((element) => element.type === 'button' && text(element).startsWith('进入资源库'));
    (open.props.onClick as () => void)();
    expect(driver.open).toHaveBeenLastCalledWith(true, 'page', { tab: 'permanent', folder: { kind: 'all' } });
    (find((element) => element.type === 'button' && text(element) === '素材').props.onClick as () => void)();
    expect(driver.open).toHaveBeenLastCalledWith(true, 'page', { tab: 'permanent', folder: { kind: 'folder', rootPath: '/external/素材', relativePath: '' } });
    expect(driver.mark).not.toHaveBeenCalled();
  });
  it('图片保留项目查询范围并复用全屏预览，关闭后保留资源列表', async () => {
    driver.load.mockResolvedValue([entry()]); render(); await settle();
    (find((element) => element.type === 'asset-thumb').props.onImagePreview as () => void)(); render();
    const preview = find((element) => element.props.initialPath === '/projects/project/image.png');
    expect(preview.props).toMatchObject({ projectId: 'project', initialPath: '/projects/project/image.png' });
    expect(driver.mark).toHaveBeenCalledWith(entry().file);
    (preview.props.onClose as () => void)(); render();
    expect(all(tree, (element) => typeof element.props.initialPath === 'string')).toHaveLength(0);
    expect(all(tree, (element) => !!element.props['data-recent-asset'])).toHaveLength(1);
    expect(driver.load).toHaveBeenCalledOnce();
  });
  it('视频使用全屏参数面板，只记录展开事件；文本直接打开所属项目的文档预览', async () => {
    driver.load.mockResolvedValue([entry('video', 'video'), entry('text', 'text')]); render(); await settle();
    const thumbnail = find((element) => element.type === 'asset-thumb' && element.props.category === 'video');
    expect(thumbnail.props.videoPresentation).toBe('fullscreen'); expect(thumbnail.props.videoProjectId).toBe('project');
    (thumbnail.props.onVideoExpandedChange as (open: boolean) => void)(true); render();
    (thumbnail.props.onVideoExpandedChange as (open: boolean) => void)(false); render();
    expect(driver.mark).toHaveBeenCalledOnce();
    (find((element) => element.type === 'asset-thumb' && element.props.category === 'text').props.onTextPreview as () => void)(); render();
    const preview = find((element) => (element.props.file as RecentAssetEntry['file'] | undefined)?.category === 'text');
    expect(preview.props).toMatchObject({ file: entry('text', 'text').file, projectId: 'project' });
    expect(driver.mark).toHaveBeenLastCalledWith(entry('text', 'text').file);
    (preview.props.onClose as () => void)(); render();
    expect(all(tree, (element) => !!element.props.file)).toHaveLength(0);
    expect(driver.open).not.toHaveBeenCalled();
  });
  it('目录范围改变时取消旧读取，过期结果不能恢复已撤销关联的资源', async () => {
    let finish!: (entries: RecentAssetEntry[]) => void;
    driver.load.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })); render();
    const signal = driver.load.mock.calls[0][1] as AbortSignal;
    driver.state = { ...driver.state, config: { ...driver.state.config, assetFolders: [] } }; render(); await settle();
    expect(signal.aborted).toBe(true); finish([entry()]); await settle();
    expect(all(tree, (element) => !!element.props['data-recent-asset'])).toHaveLength(0);
  });
  it('回到窗口和关闭资源库后刷新；读取失败仍保留进入资源库的入口', async () => {
    render(); await settle(); win.dispatchEvent(new Event('focus')); render(); await settle();
    expect(driver.load).toHaveBeenCalledTimes(2);
    driver.state = { ...driver.state, assetsPanelOpen: true }; render(); await settle();
    driver.load.mockRejectedValueOnce(new Error('storage failure'));
    driver.state = { ...driver.state, assetsPanelOpen: false }; render(); await settle();
    expect(text(tree)).toContain('最近使用读取失败');
    expect(all(tree, (element) => element.type === 'button' && text(element).startsWith('进入资源库'))).toHaveLength(1);
    expect(driver.mark).not.toHaveBeenCalled();
  });
});
