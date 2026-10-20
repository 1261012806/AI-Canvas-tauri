/** ComfyUI 单次生成的实时展示状态，仅保存在运行期 UI Store。 */
export type ComfyNodeProgressStage = 'connecting' | 'queued' | 'running' | 'finalizing';

export interface ComfyNodeProgress {
  projectId: string;
  nodeId: string;
  requestId: string;
  clientId: string;
  promptId?: string;
  stage: ComfyNodeProgressStage;
  /** 当前执行节点的真实步数，不代表整个工作流百分比。 */
  value?: number;
  max?: number;
  percent?: number;
  executingNodeId?: string;
  executingNodeLabel?: string;
  executingNodeType?: string;
  /** 首次收到当前实际节点执行事件的本机时间。 */
  nodeStartedAt?: number;
  cachedNodeCount?: number;
  /** 依执行优先序排列的等待队列位置，从 1 开始，不含正在执行的任务。 */
  queuePosition?: number;
  transport?: 'websocket' | 'polling' | 'reconnecting';
  /** 原生握手确认的 HTTP 拒绝，区别于浏览器来源限制。 */
  connectionIssue?: 'forbidden' | 'unauthorized';
  updatedAt: number;
}
