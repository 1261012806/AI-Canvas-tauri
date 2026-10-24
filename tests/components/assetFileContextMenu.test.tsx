import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { AssetFileContextMenuProps } from '../../src/components/assets/AssetFileContextMenu';

const driver = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>,
  stateIndex: 0, refIndex: 0, effectIndex: 0,
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
    useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
  useCallback: <T,>(callback: T) => callback,
  useState: <T,>(initial: T) => {
    const index = driver.stateIndex++;
    if (!(index in driver.states)) driver.states[index] = initial;
    return [driver.states[index], (value: T) => { driver.states[index] = value; }];
  },
  useRef: <T,>(initial: T) => driver.refs[driver.refIndex++] ??= { current: initial },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = driver.effectIndex++; const old = driver.effects[index];
    if (old && deps?.length === old.deps?.length && deps?.every((dep, i) => Object.is(dep, old.deps?.[i]))) return;
    driver.pending.push(() => { old?.cleanup?.(); driver.effects[index] = { deps, cleanup: effect() ?? undefined }; });
  },
}));
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: 'modal-overlay' }));
import AssetFileContextMenu from '../../src/components/assets/AssetFileContextMenu';

type Element = ReactElement<Record<string, unknown> & { children?: unknown; ref?: { current: unknown } }>;
let input: AssetFileContextMenuProps; let tree: unknown;
let win: EventTarget; let doc: { body: unknown; activeElement: unknown };
let trigger: { isConnected: boolean; focus: ReturnType<typeof vi.fn> };
let items: Array<{ focus: () => void }>;
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as Element; return [element, ...elements(element.props.children)];
}
function button(label: string) { return elements(tree).find((el) => el.type === 'button' && elementsText(el.props.children).includes(label))!; }
function elementsText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(elementsText).join('');
  return value && typeof value === 'object' && 'props' in value ? elementsText((value as Element).props.children) : '';
}
function click(label: string) { (button(label).props.onClick as () => void)(); }
function render() {
  driver.stateIndex = 0; driver.refIndex = 0; driver.effectIndex = 0;
  tree = AssetFileContextMenu(input);
  const menu = elements(tree).find((el) => el.props.role === 'menu');
  if (menu?.props.ref) {
    items = elements(tree).filter((el) => el.props.role === 'menuitem' && !el.props.disabled).map(() => {
      const item = { focus: () => { doc.activeElement = item; } }; return item;
    });
    menu.props.ref.current = { contains: (target: unknown) => items.includes(target as typeof items[number]), querySelectorAll: () => items };
  }
  const pending = driver.pending; driver.pending = []; pending.forEach((effect) => effect());
}
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); render(); }
function key(name: string) {
  const event = new Event('keydown', { cancelable: true }); Object.assign(event, { key: name }); win.dispatchEvent(event); return event;
}
function unmount() { driver.effects.forEach((effect) => effect.cleanup?.()); driver.effects = []; }

beforeEach(() => {
  driver.states = []; driver.refs = []; driver.effects = []; driver.pending = [];
  trigger = { isConnected: true, focus: vi.fn() };
  doc = { body: {}, activeElement: trigger }; items = [];
  win = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 });
  vi.stubGlobal('window', win); vi.stubGlobal('document', doc);
  input = { name: '示例.png', x: 795, y: 590, canFileActions: true, canCopyPrompt: true,
    onCopy: vi.fn().mockResolvedValue(undefined), onCopyPrompt: vi.fn().mockResolvedValue(undefined),
    onReveal: vi.fn().mockResolvedValue(undefined), onDelete: vi.fn().mockResolvedValue(undefined), onClose: vi.fn() };
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe('资产文件右键菜单', () => {
  it('使用 UI Kit 菜单与危险项，四项操作完整并限制在窗口内', () => {
    render(); const menu = elements(tree).find((el) => el.props.role === 'menu')!;
    expect(menu.props.className).toBe('ui-menu w-52');
    expect(menu.props.style).toMatchObject({ position: 'fixed', left: 584, top: 428 });
    expect(elements(tree).filter((el) => el.props.role === 'menuitem')).toHaveLength(4);
    expect(button('删除').props.className).toContain('is-danger');
  });
  it('不可用操作禁用，方向键跳过禁用项，Esc 只关闭菜单并恢复焦点', () => {
    input.canFileActions = false; render();
    expect(button('复制').props.disabled).toBe(true); expect(button('复制提示词').props.disabled).toBe(false);
    expect(items).toHaveLength(1); key('ArrowDown'); expect(doc.activeElement).toBe(items[0]);
    const downstream = vi.fn(); win.addEventListener('keydown', downstream);
    expect(key('Escape').defaultPrevented).toBe(true); expect(downstream).not.toHaveBeenCalled(); expect(input.onClose).toHaveBeenCalledOnce();
    unmount(); expect(trigger.focus).toHaveBeenCalledOnce();
  });
  it('上下方向、Home/End 和 Tab 导航保持在菜单内', () => {
    render(); expect(doc.activeElement).toBe(items[0]);
    key('End'); expect(doc.activeElement).toBe(items[3]); key('ArrowDown'); expect(doc.activeElement).toBe(items[0]);
    key('ArrowUp'); expect(doc.activeElement).toBe(items[3]); key('Home'); expect(doc.activeElement).toBe(items[0]);
    expect(key('Tab').defaultPrevented).toBe(true); expect(input.onClose).toHaveBeenCalledOnce();
  });
  it.each(['pointerdown', 'resize', 'scroll'])('%s 外部变化关闭菜单，卸载移除监听', (type) => {
    render(); win.dispatchEvent(new Event(type)); expect(input.onClose).toHaveBeenCalledOnce();
    unmount(); win.dispatchEvent(new Event(type)); expect(input.onClose).toHaveBeenCalledOnce();
  });
  it.each(['复制', '复制提示词', '打开文件所在目录'] as const)('%s 完成后关闭菜单', async (label) => {
    render(); click(label); await settle();
    expect(label === '复制' ? input.onCopy : label === '复制提示词' ? input.onCopyPrompt : input.onReveal).toHaveBeenCalledOnce();
    expect(input.onClose).toHaveBeenCalledOnce(); expect(input.onDelete).not.toHaveBeenCalled();
  });
  it('删除先确认磁盘影响，取消不删除；失败保留确认框，允许重试', async () => {
    render(); click('删除'); render(); expect(input.onDelete).not.toHaveBeenCalled();
    expect(elementsText(tree)).toContain('可能影响画布中的引用'); expect(elementsText(tree)).toContain('生成历史将保留');
    const modal = elements(tree).find((el) => el.type === 'modal-overlay')!;
    expect(modal.props).toMatchObject({ ariaLabel: '移入回收站', zIndex: 360 });
    click('取消'); expect(input.onClose).toHaveBeenCalledOnce();
    vi.mocked(input.onClose).mockClear(); vi.mocked(input.onDelete).mockRejectedValueOnce(new Error('locked'));
    click('移入回收站'); await settle();
    expect(input.onClose).not.toHaveBeenCalled(); expect(elementsText(tree)).toContain('删除失败，文件仍保留');
    click('移入回收站'); await settle(); expect(input.onClose).toHaveBeenCalledOnce(); expect(input.onDelete).toHaveBeenCalledTimes(2);
  });
  it('删除执行中拒绝连点和关闭，迟到完成不关闭后来打开的菜单', async () => {
    let finish!: () => void; input.confirmDelete = true;
    vi.mocked(input.onDelete).mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    render(); click('移入回收站'); click('移入回收站'); render();
    expect(input.onDelete).toHaveBeenCalledOnce(); expect(button('取消').props.disabled).toBe(true);
    (elements(tree).find((el) => el.type === 'modal-overlay')!.props.onClose as () => void)();
    expect(input.onClose).not.toHaveBeenCalled(); unmount(); finish(); await Promise.resolve(); await Promise.resolve();
    expect(input.onClose).not.toHaveBeenCalled();
  });
});
