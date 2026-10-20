/** 主线程降级与 Worker 共用的截图尺寸、编码预算；不接触 DOM。 */
export const MCP_CAPTURE_MIME = 'image/jpeg' as const;
export const MCP_CAPTURE_DATA_PREFIX = `data:${MCP_CAPTURE_MIME};base64,`;
export const MCP_CAPTURE_MAX_BASE64_CHARS = 2_600_000;
export const MCP_CAPTURE_MAX_BYTES = Math.floor(
  (MCP_CAPTURE_MAX_BASE64_CHARS - MCP_CAPTURE_DATA_PREFIX.length) / 4,
) * 3;

export class McpCaptureLimitError extends Error {
  constructor() { super('截图压缩后仍超过 MCP 图像上限'); }
}

export function getMcpCaptureEncodingSteps(width: number, height: number, quality: number) {
  return Array.from({ length: 4 }, (_, attempt) => ({
    width: Math.max(1, Math.round(width * 0.75 ** attempt)),
    height: Math.max(1, Math.round(height * 0.75 ** attempt)),
    quality: Math.max(0.4, quality - 0.12 * attempt),
  }));
}

export interface McpCaptureWorkerRequest {
  bitmap: ImageBitmap;
  quality: number;
}

export type McpCaptureWorkerResponse = {
  ok: true;
  buffer: ArrayBuffer;
  width: number;
  height: number;
} | {
  ok: false;
  error: string;
  oversized: boolean;
};
