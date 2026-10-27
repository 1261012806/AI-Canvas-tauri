import { Children, isValidElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gesture = vi.hoisted(() => ({ scale: 1, zoomTo: vi.fn(), reset: vi.fn() }));
const comfyImageSource = vi.hoisted(() => vi.fn((source?: string, _onError?: () => void) => source));

vi.mock('../../src/hooks/useComfyImageSource', () => ({ useComfyImageSource: comfyImageSource }));

vi.mock('../../src/i18n', async (original) => {
  const actual = await original<typeof import('../../src/i18n')>();
  return { ...actual, useT: () => actual.t };
});
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useCallback: <T,>(callback: T) => callback,
  useEffect: vi.fn(),
}));
vi.mock('../../src/hooks/useImageViewportGesture', () => ({
  useImageViewportGesture: () => ({
    ...gesture,
    containerRef: vi.fn(),
    containerEl: { current: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) } },
    tx: 0, ty: 0, dragging: false, gesturing: false, cursor: 'default',
    onPointerDown: vi.fn(),
  }),
}));

import ZoomableImage from '../../src/components/shared/ZoomableImage';

type Element = ReactElement<{
  children?: React.ReactNode;
  className?: string;
  src?: string;
  'aria-label'?: string;
  'data-tauri-drag-region'?: string;
  style?: { transform?: string; transition?: string; willChange?: string };
  onClick?: (event: Event) => void;
  onDoubleClick?: (event: Event) => void;
  onMouseDown?: (event: Event) => void;
  onMouseUp?: (event: Event) => void;
}>;

function children(element: Element): Element[] {
  return Children.toArray(element.props.children).filter(isValidElement) as Element[];
}

// 按按钮、控制栏、预览容器的顺序冒泡，复现缩放尚未重新渲染时的同一次点击。
function dispatch(path: Element[], handler: 'onClick' | 'onDoubleClick' | 'onMouseDown' | 'onMouseUp' = 'onClick') {
  const type = { onClick: 'click', onDoubleClick: 'dblclick', onMouseDown: 'mousedown', onMouseUp: 'mouseup' }[handler];
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: path[0] });
  Object.assign(event, { clientX: 400, clientY: 300 });
  for (const element of path) {
    Object.defineProperty(event, 'currentTarget', { value: element, configurable: true });
    element.props[handler]?.(event);
    if (event.cancelBubble) break;
  }
  return event;
}

beforeEach(() => {
  gesture.scale = 1;
  vi.clearAllMocks();
  comfyImageSource.mockImplementation((source) => source);
});

describe('fullscreen image zoom controls', () => {
  it('uses the native display source without changing the original reference', () => {
    const source = 'http://127.0.0.1:8188/view?filename=output.png&type=output';
    const onError = vi.fn();
    comfyImageSource.mockReturnValue('blob:comfy-original');
    const image = children(children(ZoomableImage({ src: source, onError }))[0])[0];
    expect(comfyImageSource).toHaveBeenCalledWith(source, onError);
    expect(image.props.src).toBe('blob:comfy-original');
  });

  it('静止图片不保持变换图层，也不对大图追加过渡或 will-change', () => {
    const image = children(children(ZoomableImage({ src: 'asset://preview.png' }))[0])[0];
    expect(image.props.style?.transform).toBe('none');
    expect(image.props.style).not.toHaveProperty('transition');
    expect(image.props.style).not.toHaveProperty('willChange');
  });

  it.each([
    ['放大', 1, 1.4],
    ['缩小', 1.4, 1],
    ['复位缩放', 1, null],
  ] as const)('%s does not close the preview', (label, scale, expectedScale) => {
    gesture.scale = scale;
    const onClose = vi.fn();
    const root = ZoomableImage({ src: 'asset://preview.png', onClose });
    const controls = children(root).find((element) => element.props.className === 'zoom-controls')!;
    const button = children(controls).find((element) => element.props['aria-label'] === label)!;

    dispatch([button, controls, root]);

    expect(onClose).not.toHaveBeenCalled();
    if (expectedScale === null) expect(gesture.reset).toHaveBeenCalledOnce();
    else expect(gesture.zoomTo).toHaveBeenCalledWith(expectedScale, 0, 0);
  });

  it.each([1, 1.4, 8])('keeps image clicks inside the preview at scale %s', (scale) => {
    gesture.scale = scale;
    const onClose = vi.fn();
    const parent = { props: { onClick: vi.fn() } } as unknown as Element;
    const root = ZoomableImage({ src: 'asset://preview.png', onClose });
    const stage = children(root)[0];
    const image = children(stage)[0];
    dispatch([image, stage, root, parent]);
    expect(onClose).not.toHaveBeenCalled();
    expect(parent.props.onClick).not.toHaveBeenCalled();
  });

  it('keeps the two clicks before a double click open and then zooms around the cursor', () => {
    const onClose = vi.fn();
    const root = ZoomableImage({ src: 'asset://preview.png', onClose });
    const stage = children(root)[0];
    const image = children(stage)[0];
    dispatch([image, stage, root]);
    dispatch([image, stage, root]);
    dispatch([image, stage, root], 'onDoubleClick');
    expect(onClose).not.toHaveBeenCalled();
    expect(gesture.zoomTo).toHaveBeenCalledExactlyOnceWith(2, 0, 0);
  });

  it('still closes when directly clicking the blank background at the default scale', () => {
    const onClose = vi.fn();
    const root = ZoomableImage({ src: 'asset://preview.png', onClose });
    dispatch([root]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(['onMouseDown', 'onMouseUp'] as const)('keeps image and control %s inside the viewer at every scale', (handler) => {
    for (const scale of [1, 1.4, 8]) {
      gesture.scale = scale;
      const root = ZoomableImage({ src: 'asset://preview.png' });
      const parent = { props: { [handler]: vi.fn() } } as unknown as Element;
      const image = children(children(root)[0])[0];
      const controls = children(root).find((element) => element.props.className === 'zoom-controls')!;
      dispatch([image, root, parent], handler);
      dispatch([children(controls)[0], controls, root, parent], handler);
      expect(parent.props[handler]).not.toHaveBeenCalled();
    }
  });

  it.each(['onMouseDown', 'onMouseUp'] as const)('allows backdrop %s to reach Tauri only at the default scale', (handler) => {
    for (const scale of [1, 1.4, 8]) {
      gesture.scale = scale;
      const root = ZoomableImage({ src: 'asset://preview.png' });
      const parent = { props: { [handler]: vi.fn() } } as unknown as Element;
      dispatch([root, parent], handler);
      expect(root.props['data-tauri-drag-region']).toBe(scale === 1 ? 'true' : 'false');
      expect(parent.props[handler]).toHaveBeenCalledTimes(scale === 1 ? 1 : 0);
    }
  });
});
