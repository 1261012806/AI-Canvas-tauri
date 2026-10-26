/** MCP 原文件分块读取合同；路径、文件句柄与取消控制器只保留在宿主运行时。 */
export type MediaDownloadInput =
  | { action: 'begin'; nodeId: string }
  | { action: 'read'; downloadId: string; offset: number }
  | { action: 'close'; downloadId: string };

export interface MediaDownloadContext {
  projectId: string;
  conversationId: string;
  signal: AbortSignal;
}

export interface MediaDownloadInfo {
  downloadId: string;
  nodeId: string;
  state: 'open';
  fileName: string;
  mimeType: string;
  totalBytes: number;
  chunkBytes: number;
  expiresAt: number;
}

export interface MediaDownloadChunk extends MediaDownloadInfo {
  offset: number;
  bytesRead: number;
  nextOffset: number;
  eof: boolean;
  encoding: 'base64';
  data: string;
  checksumAlgorithm: 'sha256';
  checksum: string;
}

export interface MediaDownloadClosed {
  downloadId: string;
  state: 'closed';
}

export type MediaDownloadResult = MediaDownloadInfo | MediaDownloadChunk | MediaDownloadClosed;
