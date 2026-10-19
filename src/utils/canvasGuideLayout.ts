type Rect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
type Size = { width: number; height: number };
type Side = 'bottom' | 'left';

/** 引导只测量当前入口与说明卡，不读取或扫描画布节点。 */
export function getCanvasGuideLayout(target: Rect | null, viewport: Size, cardSize: Size, side: Side) {
  const margin = 12;
  const gap = 16;
  const width = Math.min(cardSize.width, Math.max(0, viewport.width - margin * 2));
  const height = Math.min(cardSize.height, Math.max(0, viewport.height - margin * 2));
  const clamp = (value: number, max: number) => Math.max(margin, Math.min(Math.max(margin, max), value));
  const left = Math.max(0, (target?.left ?? 0) - 8);
  const top = Math.max(0, (target?.top ?? 0) - 8);
  const right = Math.min(viewport.width, (target?.left ?? 0) + (target?.width ?? 0) + 8);
  const bottom = Math.min(viewport.height, (target?.top ?? 0) + (target?.height ?? 0) + 8);
  const focus = target && right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
  let position = { left: (viewport.width - width) / 2, top: (viewport.height - height) / 2 };
  if (focus) {
    const below = { left: clamp(left + (focus.width - width) / 2, viewport.width - width - margin), top: bottom + gap };
    const above = { left: below.left, top: top - height - gap };
    const before = { left: left - width - gap, top: clamp(top + (focus.height - height) / 2, viewport.height - height - margin) };
    const after = { left: right + gap, top: before.top };
    const candidates = side === 'left' ? [before, after, below, above] : [below, above, before, after];
    // 沿入口一侧夹紧位置，优先保留入口与卡片之间的间隙。
    const fits = (candidate: typeof position) => (
      candidate.left >= margin && candidate.left + width <= viewport.width - margin
      && candidate.top >= margin && candidate.top + height <= viewport.height - margin
    );
    position = candidates.find(fits) ?? position;
  }
  const card = {
    left: clamp(position.left, viewport.width - width - margin),
    top: clamp(position.top, viewport.height - height - margin),
    width,
    maxHeight: Math.max(0, viewport.height - margin * 2),
  };
  return { focus, card };
}
