/** 右键菜单与 F2 复用双击标题的编辑入口。 */
export function startNodeRename(nodeId: string): boolean {
  const nodeElement = Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node'))
    .find((element) => element.dataset.id === nodeId);
  const labelElement = nodeElement?.querySelector<HTMLElement>('.node-label-text');
  if (!labelElement) return false;

  labelElement.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
  return true;
}
