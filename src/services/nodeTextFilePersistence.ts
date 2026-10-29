import type { AppState } from '../store/useAppStore';
import { buildNodeFileName, saveBinaryToProjectData } from './fileService';
import { isTauriEnv } from './fs/core';

const TEXT_DOCUMENT_TYPES = new Set(['ai-text', 'source-text', 'ai-markdown']);

/** 补齐历史或外部创建的纯正文节点；已有文件不覆盖，MCP 更新另走摘要校验。 */
export async function persistMissingNodeTextFiles(
  getState: () => Pick<AppState, 'currentProjectId' | 'nodes' | 'updateNodeDataTransient'>,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isTauriEnv()) return true;
  const initial = getState();
  const projectId = initial.currentProjectId;
  if (!projectId || !isCurrent()) return false;
  for (const source of initial.nodes) {
    const data = source.data;
    if (!TEXT_DOCUMENT_TYPES.has(data.type) || data.filePath || data.status === 'loading'
      || typeof data.output !== 'string' || !data.output.length) continue;
    const content = data.output;
    const fresh = () => {
      const state = getState();
      const node = state.nodes.find((candidate) => candidate.id === source.id);
      return isCurrent() && state.currentProjectId === projectId && node?.data.type === data.type
        && !node.data.filePath && node.data.output === content && node.data.status !== 'loading';
    };
    if (!fresh()) return false;
    const extension = data.type === 'ai-markdown' ? '.md' : '.txt';
    const fileName = buildNodeFileName(data.fileName || data.label, extension, `text-${source.id}`);
    const saved = await saveBinaryToProjectData(new TextEncoder().encode(content), projectId, fileName, { throwOnError: true });
    if (!saved) throw new Error('文本文件保存失败，节点正文已保留');
    if (!fresh()) return false;
    getState().updateNodeDataTransient(source.id, {
      filePath: saved.filePath,
      fileName: saved.filePath.split(/[/\\]/).pop() || fileName,
      assetId: undefined,
      relativePath: undefined,
    });
  }
  return isCurrent() && getState().currentProjectId === projectId;
}
