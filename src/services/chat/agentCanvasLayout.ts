/** 助手与 MCP 创建普通画布节点时共用；不改变手工布局或专属制作流程。 */
export const AGENT_NODE_LAYOUT = {
  columnGap: 48,
  rowGap: 40,
  anchorGap: 48,
  collisionGap: 24,
} as const;

export const AGENT_NODE_LAYOUT_GUIDANCE = [
  '布局按数据流从左向右：上游素材放左、下游生成或汇总节点放右，连线右出左入。',
  `默认紧凑排布，普通节点边缘水平间距通常为 ${AGENT_NODE_LAYOUT.columnGap}–64 画布单位，纵向约 ${AGENT_NODE_LAYOUT.rowGap}；间距按节点边缘计算，不是中心坐标差。`,
  '常规新建省略 x/y，由宿主按节点实际尺寸和上游引用就近避让；同一批节点一起创建，不要为每个节点预留数百单位空白。',
  '只有用户明确指定位置或需要特定构图时才填写坐标；不要仅为套用统一网格而扩大间距，也不要移动无关的已有节点。',
].join('');
