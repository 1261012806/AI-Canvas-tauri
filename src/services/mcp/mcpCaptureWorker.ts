/** 仅对已过滤的截图位图缩放和编码，不读取窗口、DOM 或项目数据。 */
import {
  getMcpCaptureEncodingSteps,
  MCP_CAPTURE_MAX_BYTES,
  MCP_CAPTURE_MIME,
  McpCaptureLimitError,
  type McpCaptureWorkerRequest,
  type McpCaptureWorkerResponse,
} from './mcpCaptureEncoding';

interface CaptureWorkerScope {
  onmessage: ((event: MessageEvent<McpCaptureWorkerRequest>) => void) | null;
  postMessage: (message: McpCaptureWorkerResponse, transfer?: Transferable[]) => void;
}

const workerScope = self as unknown as CaptureWorkerScope;

async function encodeCapture({ bitmap, quality }: McpCaptureWorkerRequest): Promise<void> {
  let canvas: OffscreenCanvas | undefined;
  try {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('截图离屏画布不可用');
    for (const step of getMcpCaptureEncodingSteps(bitmap.width, bitmap.height, quality)) {
      canvas.width = step.width;
      canvas.height = step.height;
      context.drawImage(bitmap, 0, 0, step.width, step.height);
      const blob = await canvas.convertToBlob({ type: MCP_CAPTURE_MIME, quality: step.quality });
      if (blob.type !== MCP_CAPTURE_MIME) throw new Error('截图 JPEG 编码不可用');
      if (blob.size > MCP_CAPTURE_MAX_BYTES) continue;
      const buffer = await blob.arrayBuffer();
      workerScope.postMessage({ ok: true, buffer, width: step.width, height: step.height }, [buffer]);
      return;
    }
    throw new McpCaptureLimitError();
  } finally {
    bitmap.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

workerScope.onmessage = (event) => {
  void encodeCapture(event.data).catch((error) => {
    workerScope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : '截图编码失败',
      oversized: error instanceof McpCaptureLimitError,
    });
  });
};
