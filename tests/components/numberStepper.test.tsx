import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useRef: <T,>(value: T) => ({ current: value }),
  useEffect: (callback: () => void | (() => void)) => hooks.effects.push(callback),
  useState: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (next: T | ((value: T) => T)) => {
        hooks.states[index] = typeof next === 'function' ? (next as (value: T) => T)(hooks.states[index] as T) : next;
      },
    ];
  },
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

import NumberStepper from '../../src/components/shared/NumberStepper';

interface ElementLike {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown; ref?: { current: unknown } };
}

function elements(node: unknown): ElementLike[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as ElementLike;
  return [element, ...elements(element.props.children)];
}

function invoke(element: ElementLike, handler: string, event?: unknown) {
  (element.props[handler] as (event: unknown) => void)(event);
}

describe('NumberStepper component', () => {
  beforeEach(() => {
    hooks.states = [];
    hooks.cursor = 0;
    hooks.effects = [];
    vi.useFakeTimers();
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', {
      activeElement: null,
      body: { classList: { add: vi.fn(), remove: vi.fn() } },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders static HTML markup with value, unit, and stepper buttons', () => {
    const html = renderToStaticMarkup(
      <NumberStepper value={40} onChange={vi.fn()} unit="px" />
    );

    expect(html).toContain('ui-stepper');
    expect(html).toContain('value="40"');
    expect(html).toContain('ui-stepper__unit');
    expect(html).toContain('px');
    expect(html).toContain('ui-stepper__btn--up');
    expect(html).toContain('ui-stepper__btn--down');
  });

  it('renders small and large size variants', () => {
    const smHtml = renderToStaticMarkup(
      <NumberStepper value={24} onChange={vi.fn()} size="sm" />
    );
    expect(smHtml).toContain('ui-stepper--sm');

    hooks.states = [];
    hooks.cursor = 0;
    const lgHtml = renderToStaticMarkup(
      <NumberStepper value={100} onChange={vi.fn()} size="lg" />
    );
    expect(lgHtml).toContain('ui-stepper--lg');
  });

  it('handles disabled state in markup', () => {
    const html = renderToStaticMarkup(
      <NumberStepper value={40} onChange={vi.fn()} disabled />
    );
    expect(html).toContain('is-disabled');
    expect(html).toContain('disabled=""');
  });

  it('将字段名称传给真正的数字输入，未传名称时保留外部 label 关联', () => {
    const named = elements(NumberStepper({ value: 40, onChange: vi.fn(), 'aria-label': '背景透明度' }))
      .find((element) => element.type === 'input')!;
    expect(named.props['aria-label']).toBe('背景透明度');
    hooks.cursor = 0;
    const labelled = elements(NumberStepper({ value: 40, onChange: vi.fn(), id: 'duration' }))
      .find((element) => element.type === 'input')!;
    expect(labelled.props.id).toBe('duration');
    expect(labelled.props['aria-label']).toBeUndefined();
  });

  it('Esc 取消草稿先于父弹窗捕获监听，随后同步 blur 不提交旧草稿', () => {
    const onChange = vi.fn();
    const input = elements(NumberStepper({ value: 40, onChange, unit: 'px' }))
      .find((element) => element.type === 'input')!;
    const target = { blur: vi.fn(() => invoke(input, 'onBlur')) };
    input.props.ref!.current = target;
    invoke(input, 'onChange', { target: { value: '80px' } });
    const cleanups = hooks.effects.map((effect) => effect());
    const keydown = vi.mocked(window.addEventListener).mock.calls.find(([name]) => name === 'keydown')!;
    const keyup = vi.mocked(window.addEventListener).mock.calls.find(([name]) => name === 'keyup')!;
    expect(keydown[2]).toBe(true);
    const escape = { key: 'Escape', target, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    (keydown[1] as (event: unknown) => void)(escape);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(escape.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(target.blur).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    expect(hooks.states[0]).toBeNull();
    const release = { ...escape, target: {}, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    (keyup[1] as (event: unknown) => void)(release);
    expect(release.stopImmediatePropagation).toHaveBeenCalledOnce();
    const unrelated = { ...release, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    (keydown[1] as (event: unknown) => void)(unrelated);
    expect(unrelated.stopImmediatePropagation).not.toHaveBeenCalled();
    cleanups.forEach((cleanup) => cleanup?.());
  });

  it.each(['keyboard', 'wheel', 'button'])('未提交草稿通过 %s 继续步进，失焦不会覆盖步进结果', (source) => {
    const onChange = vi.fn();
    const nodes = elements(NumberStepper({ value: 40, onChange, min: 0, max: 100, unit: 'px' }));
    const input = nodes.find((element) => element.type === 'input')!;
    invoke(input, 'onChange', { target: { value: '80px' } });
    if (source === 'keyboard') {
      invoke(input, 'onKeyDown', { key: 'ArrowUp', shiftKey: false, preventDefault: vi.fn() });
    } else if (source === 'wheel') {
      invoke(nodes.find((element) => element.props.className === 'ui-stepper__drag')!, 'onWheel',
        { deltaY: -1, shiftKey: false, preventDefault: vi.fn() });
    } else {
      invoke(nodes.find((element) => element.props.className === 'ui-stepper__btn ui-stepper__btn--up')!,
        'onPointerDown', { shiftKey: false });
    }
    invoke(input, 'onBlur');
    expect(onChange).toHaveBeenCalledExactlyOnceWith(81);
    expect(hooks.states[0]).toBeNull();
  });

  it('草稿步进保留小数精度、Shift 倍率和边界，非法草稿回退到已提交值', () => {
    const onChange = vi.fn();
    const input = elements(NumberStepper({ value: 1.2, onChange, min: 0.1, max: 10, step: 0.1, unit: 'x' }))
      .find((element) => element.type === 'input')!;
    invoke(input, 'onChange', { target: { value: '2.4x' } });
    invoke(input, 'onKeyDown', { key: 'ArrowUp', shiftKey: false, preventDefault: vi.fn() });
    expect(onChange).toHaveBeenLastCalledWith(2.5);
    invoke(input, 'onChange', { target: { value: '9.8x' } });
    invoke(input, 'onKeyDown', { key: 'ArrowUp', shiftKey: true, preventDefault: vi.fn() });
    expect(onChange).toHaveBeenLastCalledWith(10);
    invoke(input, 'onChange', { target: { value: '-' } });
    invoke(input, 'onKeyDown', { key: 'ArrowDown', shiftKey: false, preventDefault: vi.fn() });
    expect(onChange).toHaveBeenLastCalledWith(1.1);
  });

  it('已提交值在上限时，输入范围内草稿仍可使用增加按钮', () => {
    const props = { value: 100, onChange: vi.fn(), min: 0, max: 100 };
    const input = elements(NumberStepper(props)).find((element) => element.type === 'input')!;
    invoke(input, 'onChange', { target: { value: '50' } });
    hooks.cursor = 0;
    const upButton = elements(NumberStepper(props))
      .find((element) => element.props.className === 'ui-stepper__btn ui-stepper__btn--up')!;
    expect(upButton.props.disabled).toBe(false);
  });

  it('卸载时移除正在运行的拖拽监听并释放拖拽状态', () => {
    const onScrubStateChange = vi.fn();
    const nodes = elements(NumberStepper({ value: 40, onChange: vi.fn(), onScrubStateChange }));
    const input = nodes.find((element) => element.type === 'input')!;
    input.props.ref!.current = {};
    const cleanups = hooks.effects.map((effect) => effect());
    const drag = nodes.find((element) => element.props.className === 'ui-stepper__drag')!;
    invoke(drag, 'onMouseDown', { button: 0, clientX: 100 });
    const mousemove = vi.mocked(window.addEventListener).mock.calls.find(([name]) => name === 'mousemove')!;
    (mousemove[1] as (event: unknown) => void)({ clientX: 108, shiftKey: false });
    expect(onScrubStateChange).toHaveBeenLastCalledWith(true);
    cleanups.forEach((cleanup) => cleanup?.());
    expect(window.removeEventListener).toHaveBeenCalledWith('mousemove', mousemove[1]);
    expect(document.body.classList.remove).toHaveBeenCalledWith('cursor-ew-resize', 'select-none');
    expect(onScrubStateChange).toHaveBeenLastCalledWith(false);
  });

  it('invokes buttons and keyboard handlers on JSX element tree', () => {
    const onChange = vi.fn();
    const tree = NumberStepper({
      value: 40,
      onChange,
      min: 0,
      max: 100,
      step: 1,
      shiftMultiplier: 10,
      unit: 'px',
    });

    const all = elements(tree);
    const upBtn = all.find((el) => typeof el.props.className === 'string' && el.props.className.includes('ui-stepper__btn--up'));
    expect(upBtn).toBeDefined();

    // Trigger pointerDown on up button
    if (upBtn?.props.onPointerDown) {
      (upBtn.props.onPointerDown as (e: unknown) => void)({ shiftKey: false });
      expect(onChange).toHaveBeenCalledWith(41);

      (upBtn.props.onPointerDown as (e: unknown) => void)({ shiftKey: true });
      expect(onChange).toHaveBeenCalledWith(50);
    }

    // Trigger keyboard down arrow
    const input = all.find((el) => el.type === 'input');
    expect(input).toBeDefined();
    if (input?.props.onKeyDown) {
      (input.props.onKeyDown as (e: unknown) => void)({
        key: 'ArrowDown',
        shiftKey: false,
        preventDefault: vi.fn(),
      });
      expect(onChange).toHaveBeenCalledWith(39);
    }
  });
});
