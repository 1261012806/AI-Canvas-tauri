import { describe, expect, it } from 'vitest';
import { getCanvasGuideLayout } from '../../src/utils/canvasGuideLayout';

describe('canvas entry guide placement', () => {
  it('places the project card below the actual top hint', () => {
    const { focus, card } = getCanvasGuideLayout({ left: 480, top: 16, width: 32, height: 2 },
      { width: 1024, height: 768 }, { width: 360, height: 220 }, 'bottom');
    expect(focus).toEqual({ left: 472, top: 8, width: 48, height: 18 });
    expect(card.top).toBeGreaterThan(focus!.top + focus!.height);
  });

  it('keeps the right-edge history card beside its hint while clamping vertically', () => {
    const { focus, card } = getCanvasGuideLayout({ left: 990, top: 64, width: 3, height: 32 },
      { width: 1024, height: 768 }, { width: 360, height: 220 }, 'left');
    expect(card.left + card.width).toBeLessThan(focus!.left);
    expect(card.top).toBe(12);
  });

  it('uses the space above a lower target when there is no room below', () => {
    const { focus, card } = getCanvasGuideLayout({ left: 200, top: 410, width: 200, height: 12 },
      { width: 600, height: 450 }, { width: 360, height: 220 }, 'bottom');
    expect(card.top + 220).toBeLessThan(focus!.top);
  });

  it.each([null, { left: -200, top: 20, width: 10, height: 10 }])('centers explanatory content when the target is unavailable', (target) => {
    const { focus, card } = getCanvasGuideLayout(target,
      { width: 1024, height: 768 }, { width: 360, height: 220 }, 'bottom');
    expect(focus).toBeNull();
    expect(card.left).toBe(332);
    expect(card.top).toBe(274);
  });

  it('clips the highlight and keeps a tall card inside a small viewport', () => {
    const { focus, card } = getCanvasGuideLayout({ left: 310, top: 180, width: 3, height: 32 },
      { width: 320, height: 200 }, { width: 360, height: 260 }, 'left');
    expect(focus!.top + focus!.height).toBe(200);
    expect(card.left).toBe(12);
    expect(card.width).toBe(296);
    expect(card.top + card.maxHeight).toBeLessThanOrEqual(188);
  });
});
