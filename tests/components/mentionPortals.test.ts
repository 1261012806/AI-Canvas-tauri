import { describe, expect, it } from 'vitest';
import {
  MENTION_PORTAL_CLASSES,
  isInsideMentionPortal,
} from '../../src/components/nodes/shared/mentionPortals';

/** 只实现 closest 的最小元素替身；测试环境是 node，没有真 DOM */
function elementWith(ancestorClasses: string[]): Element {
  return {
    closest: (selector: string) => {
      const wanted = selector.split(',').map((part) => part.trim().replace(/^\./, ''));
      return ancestorClasses.some((name) => wanted.includes(name)) ? ({} as Element) : null;
    },
  } as unknown as Element;
}

describe('MentionEditor 的 Portal 浮层识别', () => {
  it('资源库弹窗里的点击算在浮层内', () => {
    expect(isInsideMentionPortal(elementWith(['asset-picker-backdrop']))).toBe(true);
  });

  it('芯片名浮层里的点击算在浮层内', () => {
    expect(isInsideMentionPortal(elementWith(['chip-name-tip']))).toBe(true);
  });

  it('挂到 body 的引用选择面板仍属于宿主浮层', () => {
    expect(isInsideMentionPortal(elementWith(['mention-dropdown']))).toBe(true);
  });

  it('画布上的普通元素不算', () => {
    expect(isInsideMentionPortal(elementWith(['react-flow__node']))).toBe(false);
  });

  it('没有目标时不算，调用方不必自己判空', () => {
    expect(isInsideMentionPortal(null)).toBe(false);
    expect(isInsideMentionPortal(undefined)).toBe(false);
  });

  it('所有 Portal 类名都在清单里，漏一个就会漏放行', () => {
    expect([...MENTION_PORTAL_CLASSES]).toEqual(['asset-picker-backdrop', 'chip-name-tip', 'mention-dropdown']);
  });
});
