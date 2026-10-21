/**
 * MentionEditor 的 Portal 浮层识别
 *
 * MentionEditor 把资源库弹窗、芯片名浮层和可选引用选择面板 Portal 到 body，它们视觉上属于宿主浮层，
 * DOM 上却是 body 的直接子节点。任何自带"点外面就关"逻辑的浮层内嵌 MentionEditor 时，
 * 都必须放行这些元素，否则点开资源库的瞬间宿主浮层就把自己关了。
 */

/** Portal 到 body 的浮层根类名 */
export const MENTION_PORTAL_CLASSES = ['asset-picker-backdrop', 'chip-name-tip', 'mention-dropdown'] as const;

const MENTION_PORTAL_SELECTOR = MENTION_PORTAL_CLASSES.map((name) => `.${name}`).join(', ');

/** 该元素是否落在 MentionEditor 的某个 Portal 浮层里 */
export function isInsideMentionPortal(target: Element | null | undefined): boolean {
  return !!target?.closest(MENTION_PORTAL_SELECTOR);
}
