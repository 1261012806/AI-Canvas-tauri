vi.mock('../../src/hooks/useComfyMediaSource', () => ({ useComfyMediaSource: (source?: string) => source }));
vi.mock('../../src/hooks/useComfyImageSource', () => ({ useComfyImageSource: (source?: string) => source }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';

interface Element { type: unknown; key?: string; props: Record<string, unknown> & { children?: unknown } }
const driver = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>,
  stateIndex: 0, refIndex: 0, effectIndex: 0,
  store: { nodes: [] as Node<BaseNodeData>[], currentProjectId: 'project-a' },
  prepare: vi.fn(async () => true), keys: new Map<string, (event: KeyboardEvent) => void>(),
}));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useMemo: <T,>(callback: () => T) => callback(),
    useCallback: <T,>(value: T) => value,
    useState: <T,>(initial: T | (() => T)) => {
      const index = driver.stateIndex++;
      if (!(index in driver.states)) driver.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [driver.states[index], (value: T | ((previous: T) => T)) => {
        driver.states[index] = typeof value === 'function' ? (value as (previous: T) => T)(driver.states[index] as T) : value;
      }];
    },
    useRef: <T,>(initial: T) => {
      const index = driver.refIndex++; driver.refs[index] ??= { current: initial }; return driver.refs[index];
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = driver.effectIndex++; const previous = driver.effects[index];
      if (previous && deps?.length === previous.deps?.length && deps?.every((dep, i) => Object.is(dep, previous.deps?.[i]))) return;
      driver.pending.push(() => { previous?.cleanup?.(); driver.effects[index] = { deps, cleanup: effect() ?? undefined }; });
    },
  };
});
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: (selector: (state: typeof driver.store) => unknown) => selector(driver.store) }));
vi.mock('../../src/hooks/useAudioSpectrum', () => ({ useAudioSpectrum: () => driver.prepare }));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
import CanvasAudioPreview, { AudioTrackPlayer } from '../../src/components/shared/CanvasAudioPreview';

class FakeAudio {
  src = 'asset://tone.wav'; currentTime = 0; duration = 120; paused = true; volume = 1; muted = false;
  play = vi.fn(async () => { this.paused = false; }); pause = vi.fn(() => { this.paused = true; });
  load = vi.fn(); removeAttribute = vi.fn(() => { this.src = ''; }); getAttribute = () => this.src;
  closest = vi.fn().mockReturnValue(null);
}
class FakeElement { isConnected = true; focus = vi.fn(); }
class FakeInput extends FakeElement {}
class FakeButton extends FakeElement {}
let tree: unknown;
let audio: FakeAudio;
let hidden: EventTarget & { hidden: boolean; activeElement: FakeElement; querySelector: ReturnType<typeof vi.fn> };
const onClose = vi.fn(); const navigate = vi.fn(); const fallback = vi.fn();
const onVolume = vi.fn(); const onMuted = vi.fn();
const base = { src: 'asset://tone.wav', initialTime: 0, autoPlay: false, analysis: true, volume: 0.7, muted: false,
  onVolume, onMuted, hasPrevious: true, hasNext: true, onNavigate: navigate, onAnalysisUnavailable: fallback };

function all(root: unknown, predicate: (element: Element) => boolean): Element[] {
  if (Array.isArray(root)) return root.flatMap((child) => all(child, predicate));
  if (!root || typeof root !== 'object' || !('props' in root)) return [];
  const element = root as Element;
  return [...(predicate(element) ? [element] : []), ...all(element.props.children, predicate)];
}
function find(predicate: (element: Element) => boolean) {
  const element = all(tree, predicate)[0]; if (!element) throw new Error('Missing element'); return element;
}
function label(name: string) { return find((element) => element.props['aria-label'] === name); }
function fire(element: Element, name: string, event?: unknown) { return (element.props[name] as (event?: unknown) => unknown)(event); }
function render(playerProps?: Partial<typeof base>) {
  driver.stateIndex = driver.refIndex = driver.effectIndex = 0;
  tree = playerProps ? AudioTrackPlayer({ ...base, ...playerProps }) : CanvasAudioPreview({ nodeId: 'ten', openingProjectId: 'project-a', onClose });
  if (playerProps) {
    (find((el) => el.type === 'audio').props.ref as { current: unknown }).current = audio;
    (find((el) => el.type === 'canvas').props.ref as { current: unknown }).current = {};
    (label('播放').props.ref as { current: unknown }).current = new FakeButton();
  }
  driver.pending.splice(0).forEach((effect) => effect());
  return tree;
}
function track(id: string, displayId?: number, extra: Partial<BaseNodeData> = {}, type = 'ai-audio'): Node<BaseNodeData> {
  return { id, type, position: { x: 0, y: 0 }, data: { type: 'ai-audio', label: id, displayId, audioUrl: `asset://${id}.wav`, ...extra } };
}
function key(key: string, target: unknown = new FakeElement()) {
  const event = { key, code: key === ' ' ? 'Space' : key, target, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
  driver.keys.get('keydown')?.(event as unknown as KeyboardEvent); return event;
}
beforeEach(() => {
  vi.clearAllMocks(); driver.states = []; driver.refs = []; driver.effects = []; driver.pending = []; driver.keys.clear();
  driver.store = { currentProjectId: 'project-a', nodes: [track('thirty', 30), track('ten', 10), track('two', 2, {}, 'source-audio'), track('unnumbered'), track('empty', 1, { audioUrl: '' }), track('hidden', 3, { hiddenByCharacterLibrary: true }), track('image', 4, {}, 'ai-image')] };
  audio = new FakeAudio();
  hidden = Object.assign(new EventTarget(), { hidden: false, activeElement: new FakeElement(), querySelector: vi.fn().mockReturnValue(null) });
  vi.stubGlobal('document', hidden); vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('HTMLInputElement', FakeInput); vi.stubGlobal('HTMLButtonElement', FakeButton);
  vi.stubGlobal('window', { addEventListener: (name: string, fn: (event: KeyboardEvent) => void) => driver.keys.set(name, fn), removeEventListener: (name: string) => driver.keys.delete(name) });
  driver.prepare.mockResolvedValue(true);
});
afterEach(() => { driver.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe('canvas audio navigation', () => {
  it('sorts numerically, skips unavailable tracks and preserves canvas order and selection', () => {
    const original = driver.store.nodes.slice(); render();
    fire(find((el) => el.type === AudioTrackPlayer), 'onNavigate', -1);
    render(); expect(find((el) => el.type === AudioTrackPlayer).props.src).toBe('asset://two.wav');
    expect(find((el) => el.type === AudioTrackPlayer).props.hasPrevious).toBe(false);
    fire(find((el) => el.type === AudioTrackPlayer), 'onNavigate', -1); render();
    expect(find((el) => el.type === AudioTrackPlayer).props.src).toBe('asset://two.wav');
    for (let i = 0; i < 3; i += 1) { fire(find((el) => el.type === AudioTrackPlayer), 'onNavigate', 1); render(); }
    expect(find((el) => el.type === AudioTrackPlayer).props.src).toBe('asset://unnumbered.wav');
    expect(find((el) => el.type === AudioTrackPlayer).props.hasNext).toBe(false);
    expect(driver.store.nodes).toEqual(original);
  });
  it.each(['project', 'delete', 'source'])('closes immediately when %s changes', (kind) => {
    render();
    if (kind === 'project') driver.store.currentProjectId = 'project-b';
    if (kind === 'delete') driver.store.nodes = driver.store.nodes.filter((node) => node.id !== 'ten');
    if (kind === 'source') driver.store.nodes = driver.store.nodes.map((node) => node.id === 'ten' ? track('ten', 10, { audioUrl: 'asset://changed.wav' }) : node);
    expect(render()).toBeNull(); expect(onClose).toHaveBeenCalledOnce();
  });
  it('uses a fresh keyed media player for analysis fallback', () => {
    render(); const first = find((el) => el.type === AudioTrackPlayer);
    (first.props.onAnalysisUnavailable as typeof fallback)(25, true); render();
    const next = find((el) => el.type === AudioTrackPlayer);
    expect(next.key).not.toBe(first.key); expect(next.props.analysis).toBe(false);
    expect(next.props.initialTime).toBe(25); expect(next.props.autoPlay).toBe(true);
  });
});

describe('audio player controls and lifetime', () => {
  it('restores metadata time, seeks and propagates volume without changing the source', () => {
    render({ initialTime: 15 }); fire(find((el) => el.type === 'audio'), 'onLoadedMetadata'); render({});
    expect(audio.currentTime).toBe(15);
    fire(label('播放进度'), 'onChange', { target: { value: '83.2' } }); expect(audio.currentTime).toBe(83.2);
    fire(label('音量'), 'onChange', { target: { value: '0.25' } }); expect(onVolume).toHaveBeenCalledWith(0.25); expect(onMuted).toHaveBeenCalledWith(false);
    expect(audio.volume).toBe(0.7); expect(audio.src).toBe(base.src);
  });
  it('plays, pauses, advances on end and does not wrap the final track', async () => {
    render({}); fire(label('播放'), 'onClick'); await Promise.resolve(); await Promise.resolve();
    expect(audio.play).toHaveBeenCalledOnce();
    fire(label('播放'), 'onClick'); expect(audio.pause).toHaveBeenCalledOnce();
    fire(find((el) => el.type === 'audio'), 'onEnded'); expect(navigate).toHaveBeenCalledWith(1, true);
    navigate.mockClear(); render({ hasNext: false }); fire(find((el) => el.type === 'audio'), 'onEnded'); expect(navigate).not.toHaveBeenCalled();
  });
  it('protects canvas shortcuts while allowing native range key behavior', () => {
    render({}); const arrow = key('ArrowRight'); expect(arrow.preventDefault).toHaveBeenCalled(); expect(navigate).toHaveBeenCalledWith(1, false);
    navigate.mockClear(); const slider = key('ArrowRight', new FakeInput());
    expect(slider.stopImmediatePropagation).toHaveBeenCalled(); expect(slider.preventDefault).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
    expect(key('Delete').stopImmediatePropagation).toHaveBeenCalled();
  });
  it('lets the top reference preview own shortcuts while its own audio player can still navigate', () => {
    render({}); hidden.querySelector.mockReturnValue({});
    const backgroundArrow = key('ArrowRight');
    expect(backgroundArrow.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(backgroundArrow.preventDefault).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    audio.closest.mockReturnValue({});
    expect(key('ArrowRight').preventDefault).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(1, false);
  });
  it('remounts without analysis after CORS or Web Audio failure', async () => {
    render({ initialTime: 12, autoPlay: true }); fire(find((el) => el.type === 'audio'), 'onError'); expect(fallback).toHaveBeenCalledWith(12, true);
    fallback.mockClear(); driver.prepare.mockResolvedValue(false);
    fire(label('播放'), 'onClick'); await Promise.resolve(); await Promise.resolve();
    expect(fallback).toHaveBeenCalledWith(0, true); expect(audio.play).not.toHaveBeenCalled();
  });
  it('ignores delayed play after unmount and releases the audio source', async () => {
    let finish!: (ready: boolean) => void;
    driver.prepare.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render({}); fire(label('播放'), 'onClick');
    driver.effects.forEach((effect) => effect.cleanup?.()); driver.effects = []; finish(true);
    await Promise.resolve(); await Promise.resolve();
    expect(audio.play).not.toHaveBeenCalled(); expect(audio.removeAttribute).toHaveBeenCalledWith('src'); expect(audio.load).toHaveBeenCalled();
  });
  it('pauses when the page becomes hidden', () => {
    render({}); hidden.hidden = true; hidden.dispatchEvent(new Event('visibilitychange')); expect(audio.pause).toHaveBeenCalledOnce();
  });
});
