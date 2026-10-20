/** 只序列化固定宿主传入的归档条目；不读取文件、网络或运行条目正文。 */
import type {
  ProjectArchiveJsonEntry,
  ProjectArchiveSerializationResponse,
} from './projectArchiveSerialization';

interface ArchiveSerializationWorkerScope {
  onmessage: ((event: MessageEvent<ProjectArchiveJsonEntry[]>) => void) | null;
  postMessage: (result: ProjectArchiveSerializationResponse) => void;
}

const workerScope = self as unknown as ArchiveSerializationWorkerScope;
workerScope.onmessage = (event) => {
  try {
    const entries = event.data.map(({ path, value }) => {
      const content = JSON.stringify(value);
      if (typeof content !== 'string') throw new Error('Unsupported archive entry');
      return { path, content };
    });
    workerScope.postMessage({ ok: true, entries });
  } catch {
    // 不把项目正文或原始异常传回日志和界面。
    workerScope.postMessage({ ok: false });
  }
};
