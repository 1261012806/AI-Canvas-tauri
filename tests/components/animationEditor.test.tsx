vi.mock('../../src/hooks/useComfyImageSource', () => ({ useComfyImageSource: (source?: string) => source }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

interface ElementLike { type: unknown; props: Record<string, unknown> & { children?: unknown } }
type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
type ScrollAnimation = { from: number; to: number; options: { onUpdate: (value: number) => void; onComplete: () => void; type: string; bounce: number }; stop: ReturnType<typeof vi.fn> };
const driver = vi.hoisted(() => ({
  values: [] as unknown[], refs: [] as Array<{ current: unknown }>, effects: [] as Effect[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, pending: [] as Array<() => void>,
  nodeData: {} as BaseNodeData, projectId: 'project-a', revision: 1,
  update: vi.fn(), toast: vi.fn(), upload: vi.fn(), preview: vi.fn(), close: vi.fn(), dispose: vi.fn(), openDialog: vi.fn(),
  reduceMotion: false, animate: vi.fn(), animations: [] as ScrollAnimation[],
}));
vi.mock('framer-motion', () => ({ animate: driver.animate, useReducedMotion: () => driver.reduceMotion }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => {
      const index = driver.stateIndex++;
      if (!(index in driver.values)) driver.values[index] = typeof initial === 'function' ? initial() : initial;
      return [driver.values[index], (value: unknown) => { driver.values[index] = typeof value === 'function' ? value(driver.values[index]) : value; }];
    },
    useRef: (initial: unknown) => {
      const index = driver.refIndex++;
      return driver.refs[index] ?? (driver.refs[index] = { current: initial });
    },
    useMemo: (factory: () => unknown) => factory(),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = driver.effectIndex++;
      const previous = driver.effects[index];
      if (previous && deps && previous.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
      driver.pending.push(() => {
        previous?.cleanup?.();
        driver.effects[index] = { deps, cleanup: effect() || undefined };
      });
    },
  };
});
vi.mock('../../src/store/useAppStore', () => {
  const state = () => ({
    nodes: [{ id: 'animation', data: driver.nodeData }], currentProjectId: driver.projectId,
    getCurrentRevision: () => driver.revision, updateNodeData: driver.update, showToast: driver.toast, openNodeDialog: driver.openDialog,
  });
  return { useAppStore: Object.assign((selector: (value: ReturnType<typeof state>) => unknown) => selector(state()), { getState: state }) };
});
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/services/fileService', () => ({ uploadSourceFileToProject: driver.upload }));
vi.mock('../../src/services/animationService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/animationService')>('../../src/services/animationService'),
  prepareAnimationPreview: driver.preview,
}));
vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: () => null }));
vi.mock('../../src/components/shared/Select', () => ({ default: () => null }));
vi.mock('../../src/components/shared/NumberStepper', () => ({ default: () => null }));
vi.mock('../../src/components/shared/PopupCloseButton', () => ({ default: () => null }));
import AnimationEditor from '../../src/components/nodes/shared/AnimationEditor';

function elements(root: unknown): ElementLike[] {
  if (Array.isArray(root)) return root.flatMap(elements);
  if (!root || typeof root !== 'object' || !('props' in root)) return [];
  const element = root as ElementLike;
  return [element, ...elements(element.props.children)];
}
function text(root: unknown): string {
  if (typeof root === 'string' || typeof root === 'number') return String(root);
  if (Array.isArray(root)) return root.map(text).join('');
  return root && typeof root === 'object' && 'props' in root ? text((root as ElementLike).props.children) : '';
}
function find(root: unknown, predicate: (element: ElementLike) => boolean) {
  const result = elements(root).find(predicate);
  if (!result) throw new Error('Missing editor control');
  return result;
}
function button(root: unknown, label: string) { return find(root, (element) => element.type === 'button' && text(element) === label); }
function onionFrames(root: unknown) {
  return elements(root).filter((element) => String(element.props.className ?? '').split(' ').includes('animation-editor-onion-frame'));
}
function onionImages(root: unknown) { return onionFrames(root).map((frame) => find(frame, (element) => element.type === 'img')); }
function setPreviewBounds(root: unknown) {
  const preview = find(root, (element) => element.props.className === 'animation-editor-preview animation-cell');
  (preview.props.ref as { current: unknown }).current = { getBoundingClientRect: () => ({ left: 100, top: 50, right: 500, bottom: 250, width: 400, height: 200 }) };
}
function pointer(element: ElementLike, handler: string, x: number, y: number, pointerId = 1) {
  (element.props[handler] as (event: unknown) => void)({ button: 0, pointerId, clientX: x, clientY: y,
    currentTarget: { setPointerCapture: vi.fn() }, preventDefault: vi.fn(), stopPropagation: vi.fn() });
}
function keyDown(element: ElementLike, key: string, shiftKey = false) {
  (element.props.onKeyDown as (event: unknown) => void)({ key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() });
}
function frameScrollHarness(root: unknown) {
  const buttons = Array.from({ length: 4 }, (_, index) => ({ offsetLeft: index * 108, offsetWidth: 100 }));
  let active = buttons[0];
  const list = Object.assign(new EventTarget(), { clientWidth: 200, scrollLeft: 0,
    scrollTo: vi.fn(({ left }: { left: number }) => { list.scrollLeft = left; }) });
  const content = { offsetWidth: 424, lastElementChild: buttons[3], querySelector: () => active,
    style: { transform: '', removeProperty: vi.fn(() => { content.style.transform = ''; }) } };
  const observers: Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; observers.push(this); }
  });
  (find(root, (element) => element.props.className === 'animation-editor-frames').props.ref as { current: unknown }).current = list;
  (find(root, (element) => element.props.className === 'animation-editor-frames-content').props.ref as { current: unknown }).current = content;
  return { list, content, observers, select: (index: number) => { active = buttons[index]; } };
}
function click(element: ElementLike) { return (element.props.onClick as () => unknown)(); }
function change(element: ElementLike, value: unknown) { (element.props.onChange as (value: unknown) => void)(value); }
function render() {
  driver.stateIndex = 0; driver.refIndex = 0; driver.effectIndex = 0;
  const wrapper = AnimationEditor({ nodeId: 'animation', onClose: driver.close })!;
  const root = (wrapper.type as (props: typeof wrapper.props) => unknown)(wrapper.props);
  driver.pending.splice(0).forEach((effect) => effect());
  return root;
}
function unmount() { driver.effects.forEach((effect) => effect.cleanup?.()); driver.effects = []; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis);
  driver.values = []; driver.refs = []; driver.effects = []; driver.pending = [];
  driver.projectId = 'project-a'; driver.revision = 1;
  driver.nodeData = { type: 'ai-animation', label: '动画', status: 'success', imageUrl: 'original-image', animationSheet: { cols: 4, rows: 1, frameCount: 4, action: 'idle' } };
  driver.preview.mockReset().mockResolvedValue({ url: 'blob:processed', width: 400, height: 100, cols: 4, rows: 1, cellWidth: 100, cellHeight: 100, warnings: [], dispose: driver.dispose });
  driver.upload.mockReset(); driver.dispose.mockReset(); driver.update.mockReset(); driver.toast.mockReset(); driver.close.mockReset(); driver.openDialog.mockReset();
  driver.reduceMotion = false; driver.animations = [];
  driver.animate.mockReset().mockImplementation((from: number, to: number, options: ScrollAnimation['options']) => {
    const animation = { from, to, options, stop: vi.fn() }; driver.animations.push(animation); return animation;
  });
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('animation editor interactions', () => {
  it('centers a selected frame with the Tabs spring and bounded edge rebound', () => {
    let root = render(); const scroll = frameScrollHarness(root); scroll.select(2);
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 3'))); root = render();
    const animation = driver.animations[0];
    expect(animation).toMatchObject({ from: 0, to: 166, options: { type: 'spring', bounce: 0.35 } });
    animation.options.onUpdate(250);
    expect(scroll.list.scrollLeft).toBe(224);
    expect(scroll.content.style.transform).toBe('translate3d(-12px, 0, 0)');
    animation.options.onComplete();
    expect(scroll.list.scrollLeft).toBe(166); expect(scroll.content.style.transform).toBe('');
    scroll.select(3);
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 4'))); render();
    expect(driver.animations.at(-1)?.to).toBe(224);
  });
  it('allows manual interruption and re-centering the same selected frame, and releases animations on close', () => {
    let root = render(); const scroll = frameScrollHarness(root); scroll.select(2);
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 3'))); root = render();
    const animation = driver.animations[0]; animation.options.onUpdate(250);
    scroll.list.dispatchEvent(new Event('wheel'));
    expect(animation.stop).toHaveBeenCalledOnce(); expect(scroll.content.style.transform).toBe('');
    scroll.list.scrollLeft = 0;
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 3'))); render();
    expect(driver.animations.at(-1)).toMatchObject({ from: 0, to: 166 });
    const repeated = driver.animations.at(-1)!;
    scroll.list.dispatchEvent(new Event('pointerdown'));
    expect(repeated.stop).toHaveBeenCalledOnce();
    unmount();
    expect(scroll.observers[0].disconnect).toHaveBeenCalledOnce();
    const stopped = repeated.stop.mock.calls.length;
    scroll.list.dispatchEvent(new Event('wheel'));
    expect(repeated.stop).toHaveBeenCalledTimes(stopped);
  });
  it('centers instantly for reduced motion, responds to resize, and leaves playback scrolling alone', async () => {
    driver.reduceMotion = true;
    let root = render(); const scroll = frameScrollHarness(root); scroll.select(2);
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 3'))); root = render();
    expect(scroll.list.scrollTo).toHaveBeenLastCalledWith({ left: 166, behavior: 'instant' });
    expect(driver.animate).not.toHaveBeenCalled();
    scroll.list.clientWidth = 300; scroll.observers[0].callback();
    expect(scroll.list.scrollTo).toHaveBeenLastCalledWith({ left: 116, behavior: 'instant' });
    scroll.list.scrollTo.mockClear();
    click(button(root, '播放')); render();
    await vi.advanceTimersByTimeAsync(125); render();
    expect(scroll.list.scrollTo).not.toHaveBeenCalled(); expect(driver.animate).not.toHaveBeenCalled();
  });
  it('drags pixel rulers into frame-relative reference lines, keeps them across frames, and excludes them from saving', () => {
    driver.nodeData.imageWidth = 400; driver.nodeData.imageHeight = 100;
    let root = render(); setPreviewBounds(root);
    const leftRuler = find(root, (element) => element.props['aria-label'] === '左侧像素刻度尺');
    const bottomRuler = find(root, (element) => element.props['aria-label'] === '底部像素刻度尺');
    expect(find(leftRuler, (element) => String(element.props.className).includes('ruler-tick') && text(element) === '0').props.style).toEqual({ bottom: '0%' });
    expect(find(leftRuler, (element) => String(element.props.className).includes('ruler-tick') && text(element) === '20').props.style).toEqual({ bottom: '20%' });
    expect(find(bottomRuler, (element) => String(element.props.className).includes('ruler-tick') && text(element) === '0').props.style).toEqual({ left: '0%' });
    pointer(find(root, (element) => element.props['aria-label'] === '左侧像素刻度尺'), 'onPointerDown', 90, 100);
    root = render();
    pointer(find(root, (element) => element.props.className === 'animation-editor-preview-shell'), 'onPointerMove', 300, 100);
    root = render();
    pointer(find(root, (element) => element.props.className === 'animation-editor-preview-shell'), 'onPointerUp', 300, 100);
    root = render();
    const vertical = find(root, (element) => element.props['aria-label'] === '竖向参考线');
    expect(vertical.props).toMatchObject({ role: 'slider', 'aria-valuenow': 50, 'aria-valuemax': 100, style: { left: '50%' } });
    expect(button(root, '播放')).toBeDefined();
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 4'))); root = render();
    expect(find(root, (element) => element.props['aria-label'] === '竖向参考线').props['aria-valuenow']).toBe(50);
    pointer(find(root, (element) => element.props['aria-label'] === '底部像素刻度尺'), 'onPointerDown', 200, 260);
    root = render();
    pointer(find(root, (element) => element.props.className === 'animation-editor-preview-shell'), 'onPointerUp', 200, 200);
    root = render();
    expect(find(root, (element) => element.props['aria-label'] === '横向参考线').props).toMatchObject({ 'aria-valuenow': 25, style: { top: '75%' } });
    expect(driver.update).not.toHaveBeenCalled();
    click(button(root, '应用'));
    expect(Object.keys(driver.update.mock.calls[0][1]).sort()).toEqual(['animationEdits', 'animationFps', 'animationLoop', 'animationProcessing', 'animationSheet']);
  });
  it('moves reference lines, restores cancelled drags, ignores other pointers, and deletes lines dragged outside', () => {
    let root = render(); setPreviewBounds(root);
    keyDown(find(root, (element) => element.props['aria-label'] === '左侧像素刻度尺'), 'Enter'); root = render();
    pointer(find(root, (element) => element.props['aria-label'] === '竖向参考线'), 'onPointerDown', 300, 100);
    root = render();
    pointer(find(root, (element) => element.props.className === 'animation-editor-preview-shell'), 'onPointerMove', 400, 100, 2);
    root = render();
    expect(find(root, (element) => element.props['aria-label'] === '竖向参考线').props['aria-valuenow']).toBe(1);
    pointer(find(root, (element) => element.props.className === 'animation-editor-preview-shell'), 'onPointerMove', 500, 100);
    root = render();
    pointer(find(root, (element) => element.props.className === 'animation-editor-preview-shell'), 'onPointerCancel', 500, 100);
    root = render();
    expect(find(root, (element) => element.props['aria-label'] === '竖向参考线').props.style).toEqual({ left: '50%' });
    pointer(find(root, (element) => element.props['aria-label'] === '竖向参考线'), 'onPointerDown', 300, 100);
    root = render();
    pointer(find(root, (element) => element.props.className === 'animation-editor-preview-shell'), 'onPointerUp', 90, 100);
    root = render();
    expect(elements(root).filter((element) => element.props.role === 'slider')).toHaveLength(0);
    pointer(find(root, (element) => element.props['aria-label'] === '底部像素刻度尺'), 'onPointerDown', 200, 260);
    root = render();
    pointer(find(root, (element) => element.props.className === 'animation-editor-preview-shell'), 'onLostPointerCapture', 200, 100);
    root = render();
    expect(elements(root).filter((element) => element.props.role === 'slider')).toHaveLength(0);
  });
  it('supports pixel keyboard nudges and deletion, and hides custom lines with the guide checkbox', () => {
    driver.nodeData.imageWidth = 400; driver.nodeData.imageHeight = 100;
    let root = render();
    keyDown(find(root, (element) => element.props['aria-label'] === '底部像素刻度尺'), ' '); root = render();
    keyDown(find(root, (element) => element.props['aria-label'] === '横向参考线'), 'ArrowUp', true); root = render();
    expect(find(root, (element) => element.props['aria-label'] === '横向参考线').props['aria-valuenow']).toBe(60);
    keyDown(find(root, (element) => element.props['aria-label'] === '横向参考线'), 'ArrowDown'); root = render();
    expect(find(root, (element) => element.props['aria-label'] === '横向参考线').props['aria-valuenow']).toBe(59);
    change(find(root, (element) => element.props.id === 'animation-guides'), { target: { checked: false } }); root = render();
    expect(elements(root).filter((element) => element.props.role === 'slider')).toHaveLength(0);
    change(find(root, (element) => element.props.id === 'animation-guides'), { target: { checked: true } }); root = render();
    keyDown(find(root, (element) => element.props['aria-label'] === '横向参考线'), 'End'); root = render();
    expect(find(root, (element) => element.props['aria-label'] === '横向参考线').props['aria-valuenow']).toBe(100);
    keyDown(find(root, (element) => element.props['aria-label'] === '横向参考线'), 'Home'); root = render();
    expect(find(root, (element) => element.props['aria-label'] === '横向参考线').props).toMatchObject({ 'aria-valuenow': 0, style: { top: '100%' } });
    keyDown(find(root, (element) => element.props['aria-label'] === '横向参考线'), 'Delete'); root = render();
    expect(elements(root).filter((element) => element.props.role === 'slider')).toHaveLength(0);
  });
  it('steps from the playing frame into a paused selection and toggles guides without saving a draft', async () => {
    render();
    await vi.advanceTimersByTimeAsync(125); let root = render();
    click(find(root, (element) => element.props['aria-label'] === '下一帧')); root = render();
    expect(find(root, (element) => element.props.alt === '动画预览').props.style).toMatchObject({ left: '-200%' });
    expect(find(root, (element) => element.type === 'button' && text(element).includes('原帧 3')).props['aria-pressed']).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const guides = find(root, (element) => element.props['aria-label'] === '显示对齐辅助线');
    expect(guides.type).toBe('input'); expect(guides.props.type).toBe('checkbox'); expect(guides.props.checked).toBe(true);
    change(guides, { target: { checked: false } }); root = render();
    expect(find(root, (element) => element.props['aria-label'] === '显示对齐辅助线').props.checked).toBe(false);
    expect(elements(root).some((element) => element.props.className === 'animation-anchor-axis')).toBe(false);
    expect(driver.update).not.toHaveBeenCalled();
  });
  it('keeps previous frames off by default and layers them behind the current frame without wrapping or saving preview options', async () => {
    let root = render();
    expect(find(root, (element) => element.props.id === 'animation-previous-frames').props.checked).toBe(false);
    expect(find(root, (element) => element.props['aria-label'] === '前帧显示数量').props).toMatchObject({ value: 1, min: 1, max: 3, disabled: true });
    expect(onionFrames(root)).toHaveLength(0);
    change(find(root, (element) => element.props.id === 'animation-previous-frames'), { target: { checked: true } }); root = render();
    expect(onionFrames(root)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(125); root = render();
    expect(onionImages(root).map((element) => element.props.style)).toEqual([expect.objectContaining({ left: '0%' })]);
    expect(find(root, (element) => element.props.alt === '动画预览').props.style).toMatchObject({ left: '-100%' });
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 3'))); root = render();
    change(find(root, (element) => element.props['aria-label'] === '前帧显示数量'), 2); root = render();
    expect(onionImages(root).map((element) => element.props.style)).toEqual([
      expect.objectContaining({ left: '0%' }), expect.objectContaining({ left: '-100%' }),
    ]);
    const current = find(root, (element) => element.props.alt === '动画预览');
    for (const frame of onionFrames(root)) {
      expect(frame.props.className).toContain('opacity-30');
      const image = find(frame, (element) => element.type === 'img');
      expect(image.props).toMatchObject({ src: 'original-image', alt: '', 'aria-hidden': 'true' });
      expect(elements(root).indexOf(image)).toBeLessThan(elements(root).indexOf(current));
    }
    expect(driver.update).not.toHaveBeenCalled();
    click(button(root, '应用'));
    expect(Object.keys(driver.update.mock.calls[0][1]).sort()).toEqual(['animationEdits', 'animationFps', 'animationLoop', 'animationProcessing', 'animationSheet']);
  });
  it('uses the edited sequence and offsets for previous frames while skipping disabled frames', () => {
    driver.nodeData.imageWidth = 400; driver.nodeData.imageHeight = 100;
    driver.nodeData.animationEdits = [
      { sourceIndex: 0, enabled: true, offsetX: 3, offsetY: -2 },
      { sourceIndex: 1, enabled: false, offsetX: 0, offsetY: 0 },
      { sourceIndex: 2, enabled: true, offsetX: -4, offsetY: 5 },
      { sourceIndex: 3, enabled: true, offsetX: 0, offsetY: 0 },
    ];
    let root = render();
    change(find(root, (element) => element.props.id === 'animation-previous-frames'), { target: { checked: true } }); root = render();
    change(find(root, (element) => element.props['aria-label'] === '前帧显示数量'), 2); root = render();
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 4'))); root = render();
    expect(onionImages(root).map((element) => element.props.style)).toEqual([
      expect.objectContaining({ left: '3%', top: '-2%' }), expect.objectContaining({ left: '-204%', top: '5%' }),
    ]);
    click(button(root, '前移')); root = render();
    expect(onionImages(root).map((element) => element.props.style)).toEqual([expect.objectContaining({ left: '3%', top: '-2%' })]);
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 2'))); root = render();
    expect(onionImages(root).map((element) => element.props.style)).toEqual([expect.objectContaining({ left: '3%', top: '-2%' })]);
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 1'))); root = render();
    change(find(root, (element) => element.props.id === 'animation-enabled'), { target: { checked: false } }); root = render();
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 4'))); root = render();
    expect(onionFrames(root)).toHaveLength(0);
  });
  it('clamps the previous-frame count to whole frames, at most five and the available enabled frames', () => {
    driver.nodeData.animationSheet = { cols: 8, rows: 1, frameCount: 8, action: 'idle' };
    let root = render();
    change(find(root, (element) => element.props.id === 'animation-previous-frames'), { target: { checked: true } }); root = render();
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 8'))); root = render();
    change(find(root, (element) => element.props['aria-label'] === '前帧显示数量'), 100); root = render();
    expect(find(root, (element) => element.props['aria-label'] === '前帧显示数量').props).toMatchObject({ value: 5, min: 1, max: 5, disabled: false });
    expect(onionImages(root).map((element) => (element.props.style as { left: string }).left)).toEqual(['-200%', '-300%', '-400%', '-500%', '-600%']);
    change(find(root, (element) => element.props['aria-label'] === '前帧显示数量'), 2.6); root = render();
    expect(onionFrames(root)).toHaveLength(3);
    change(find(root, (element) => element.props['aria-label'] === '前帧显示数量'), 0); root = render();
    expect(find(root, (element) => element.props['aria-label'] === '前帧显示数量').props.value).toBe(1);
    change(find(root, (element) => element.props['aria-label'] === '前帧显示数量'), 5); root = render();
    for (let index = 1; index <= 6; index++) {
      click(find(root, (element) => element.type === 'button' && text(element).includes(`原帧 ${index}`))); root = render();
      change(find(root, (element) => element.props.id === 'animation-enabled'), { target: { checked: false } }); root = render();
    }
    expect(find(root, (element) => element.props['aria-label'] === '前帧显示数量').props).toMatchObject({ value: 1, max: 1, disabled: false });
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 8'))); root = render();
    expect(onionImages(root).map((element) => (element.props.style as { left: string }).left)).toEqual(['-600%']);
    change(find(root, (element) => element.props.id === 'animation-enabled'), { target: { checked: false } }); root = render();
    expect(find(root, (element) => element.props['aria-label'] === '前帧显示数量').props).toMatchObject({ value: 1, max: 1, disabled: true });
    expect(find(root, (element) => element.props.id === 'animation-previous-frames').props.disabled).toBe(true);
  });
  it('closes the editor before opening generation, without applying its draft', () => {
    const root = render(); click(button(root, '生成帧动画'));
    expect(driver.close).toHaveBeenCalledOnce();
    expect(driver.openDialog).toHaveBeenCalledExactlyOnceWith('animation');
    expect(driver.close.mock.invocationCallOrder[0]).toBeLessThan(driver.openDialog.mock.invocationCallOrder[0]);
    expect(driver.update).not.toHaveBeenCalled();
  });
  it('shows the selected frame while paused, saves order and nudges in one action, and protects the last enabled frame', () => {
    let root = render();
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 3')));
    root = render();
    expect(find(root, (element) => element.props.alt === '动画预览').props.style).toMatchObject({ left: '-200%' });
    click(button(root, '前移')); root = render();
    change(find(root, (element) => element.props['aria-label'] === '帧横向偏移'), 3); root = render();
    click(button(root, '应用'));
    expect(driver.update).toHaveBeenCalledExactlyOnceWith('animation', expect.objectContaining({
      animationEdits: [
        { sourceIndex: 0, enabled: true, offsetX: 0, offsetY: 0 },
        { sourceIndex: 2, enabled: true, offsetX: 3, offsetY: 0 },
        { sourceIndex: 1, enabled: true, offsetX: 0, offsetY: 0 },
        { sourceIndex: 3, enabled: true, offsetX: 0, offsetY: 0 },
      ],
    }));
    for (const index of [1, 2, 4]) {
      click(find(root, (element) => element.type === 'button' && text(element).includes(`原帧 ${index}`))); root = render();
      change(find(root, (element) => element.props.id === 'animation-enabled'), { target: { checked: false } }); root = render();
    }
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 3'))); root = render();
    expect(find(root, (element) => element.props.id === 'animation-enabled').props.disabled).toBe(true);
    change(find(root, (element) => element.props.id === 'animation-enabled'), { target: { checked: false } });
    root = render(); expect(find(root, (element) => element.props.id === 'animation-enabled').props.checked).toBe(true);
  });
  it('stops a single playback on the final frame and replays from the beginning', async () => {
    driver.nodeData.animationLoop = false;
    let root = render();
    for (let frame = 1; frame < 4; frame++) { await vi.advanceTimersByTimeAsync(125); root = render(); }
    expect(vi.getTimerCount()).toBe(0);
    expect(find(root, (element) => element.props.alt === '动画预览').props.style).toMatchObject({ left: '-300%' });
    click(button(root, '播放')); root = render();
    expect(find(root, (element) => element.props.alt === '动画预览').props.style).toMatchObject({ left: '0%' });
    expect(vi.getTimerCount()).toBe(1);
  });
  it.each(['project', 'revision'] as const)('rejects an editor draft after the %s changes', (kind) => {
    const root = render();
    if (kind === 'project') driver.projectId = 'project-b'; else driver.revision++;
    click(button(root, '应用')); click(button(root, '导入精灵图'));
    expect(driver.update).not.toHaveBeenCalled(); expect(driver.upload).not.toHaveBeenCalled();
    expect(driver.toast).toHaveBeenCalledWith('画布已变化，请重新打开帧编辑器', 'error');
  });
  it.each(['project', 'revision', 'close'] as const)('drops an imported result after %s and releases its preview', async (kind) => {
    const pending = deferred<Awaited<ReturnType<typeof driver.preview>>>();
    driver.upload.mockResolvedValue({ filePath: 'imported-sheet', fileName: 'sheet.png', dataUrl: 'imported-image' });
    driver.preview.mockReturnValue(pending.promise);
    const root = render(); click(button(root, '导入精灵图'));
    await Promise.resolve();
    if (kind === 'project') driver.projectId = 'project-b';
    else if (kind === 'revision') driver.revision++;
    else unmount();
    pending.resolve({ width: 400, height: 100, dispose: driver.dispose }); await vi.advanceTimersByTimeAsync(0);
    expect(driver.update).not.toHaveBeenCalled(); expect(driver.dispose).toHaveBeenCalledOnce();
  });
  it('imports the original image after validation and disposes only the temporary processed preview', async () => {
    driver.upload.mockResolvedValue({ filePath: 'imported-sheet', fileName: 'sheet.png', dataUrl: 'imported-image' });
    const root = render(); click(button(root, '导入精灵图')); await vi.advanceTimersByTimeAsync(0);
    expect(driver.update).toHaveBeenCalledExactlyOnceWith('animation', expect.objectContaining({ imageUrl: 'imported-image', filePath: 'imported-sheet', imageWidth: 400, imageHeight: 100 }));
    expect(driver.dispose).toHaveBeenCalledOnce(); expect(driver.close).toHaveBeenCalledOnce();
  });
});
