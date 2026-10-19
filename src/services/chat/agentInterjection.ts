/**
 * 保存 Agent 执行期间用户追加的临时指令，并在下一轮模型调用前一次性取出。
 */
export interface AgentInterjection {
  id: string;
  text: string;
  createdAt: number;
}

export const MAX_INTERJECTION_CHARS = 8_000;
const activeBuffers = new Map<string, AgentInterjection[]>();

export function openAgentInterjectionBuffer(taskId: string): void {
  activeBuffers.set(taskId, []);
}

export function closeAgentInterjectionBuffer(taskId: string): void {
  activeBuffers.delete(taskId);
}

export function enqueueAgentInterjection(taskId: string, text: string): AgentInterjection | null {
  const buffer = activeBuffers.get(taskId);
  const content = text.trim().slice(0, MAX_INTERJECTION_CHARS);
  if (!buffer || !content) return null;
  const item: AgentInterjection = {
    id: `interjection-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text: content,
    createdAt: Date.now(),
  };
  buffer.push(item);
  return item;
}

export function drainAgentInterjections(taskId: string): AgentInterjection[] {
  const buffer = activeBuffers.get(taskId);
  if (!buffer || buffer.length === 0) return [];
  return buffer.splice(0, buffer.length);
}

export function resetAgentInterjectionsForTests(): void {
  activeBuffers.clear();
}
