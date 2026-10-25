/**
 * 项目缩略图合成 Worker：根据节点、连线和媒体位图绘制离屏画布并返回压缩结果。
 */
import {
  projectSnapshotGeometry,
  type ProjectSnapshotGeometry,
  type ProjectSnapshotViewport,
} from './projectSnapshotGeometry';

export interface ProjectSnapshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProjectSnapshotNode extends ProjectSnapshotRect {
  kind: string;
  label: string;
  noteKind?: string;
  preview?: ProjectSnapshotPreview;
}

export type ProjectSnapshotPreview = {
  kind: 'text';
  text: string;
} | {
  kind: 'shotlist';
  columns: Array<{ label: string; weight: number }>;
  rows: string[][];
};

export interface ProjectSnapshotPalette {
  card: string;
  border: string;
  text: string;
  textSecondary: string;
  muted: string;
  hover: string;
}

export interface ProjectSnapshotEdge {
  points: Array<{ x: number; y: number }>;
}

export interface ProjectSnapshotMedia extends ProjectSnapshotRect {
  fit: 'contain' | 'cover' | 'fill';
  pixelWidth: number;
  pixelHeight: number;
  pixels: ArrayBuffer;
}

export interface ProjectSnapshotWorkerRequest {
  id: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  backgroundColor: string;
  palette: ProjectSnapshotPalette;
  geometry: ProjectSnapshotGeometry;
  viewport: ProjectSnapshotViewport;
  media: ProjectSnapshotMedia[];
}

export type ProjectSnapshotWorkerResponse = {
  id: number;
  ok: true;
  buffer: ArrayBuffer;
  mimeType: 'image/webp' | 'image/png' | 'image/jpeg';
} | {
  id: number;
  ok: false;
  error: string;
};

interface SnapshotWorkerScope {
  onmessage: ((event: MessageEvent<ProjectSnapshotWorkerRequest>) => void) | null;
  postMessage: (message: ProjectSnapshotWorkerResponse, transfer?: Transferable[]) => void;
}

const workerScope = self as unknown as SnapshotWorkerScope;
const MAX_BLOB_SIZE = 260_000;
const MAX_MEDIA_EDGE = 480;
const SNAPSHOT_QUALITIES = [0.72, 0.55, 0.4, 0.28] as const;

function roundedRect(
  context: OffscreenCanvasRenderingContext2D,
  rect: ProjectSnapshotRect,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
}

function getMediaDrawRect(media: ProjectSnapshotMedia): ProjectSnapshotRect {
  if (media.fit === 'fill') return media;

  const sourceRatio = media.pixelWidth / media.pixelHeight;
  const targetRatio = media.width / media.height;
  const useWidth = media.fit === 'cover' ? sourceRatio < targetRatio : sourceRatio > targetRatio;
  const width = useWidth ? media.width : media.height * sourceRatio;
  const height = useWidth ? media.width / sourceRatio : media.height;
  return {
    x: media.x + (media.width - width) / 2,
    y: media.y + (media.height - height) / 2,
    width,
    height,
  };
}

function drawCanvasNote(
  context: OffscreenCanvasRenderingContext2D,
  node: ProjectSnapshotNode,
  palette: ProjectSnapshotPalette,
  zoom: number,
): void {
  const inset = 2;
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  context.save();
  context.globalAlpha = 0.9;
  context.strokeStyle = '#818cf8';
  context.fillStyle = 'rgba(129, 140, 248, 0.08)';
  context.lineWidth = 2;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  switch (node.noteKind) {
    case 'rectangle':
      context.roundRect(
        node.x + inset,
        node.y + inset,
        Math.max(1, node.width - inset * 2),
        Math.max(1, node.height - inset * 2),
        8,
      );
      context.fill();
      context.stroke();
      break;
    case 'diamond':
      context.moveTo(centerX, node.y + inset);
      context.lineTo(node.x + node.width - inset, centerY);
      context.lineTo(centerX, node.y + node.height - inset);
      context.lineTo(node.x + inset, centerY);
      context.closePath();
      context.fill();
      context.stroke();
      break;
    case 'ellipse':
      context.ellipse(centerX, centerY, Math.max(1, node.width / 2 - inset), Math.max(1, node.height / 2 - inset), 0, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      break;
    case 'arrow':
    case 'line':
      context.moveTo(node.x + inset, node.y + inset);
      context.lineTo(node.x + node.width - inset, node.y + node.height - inset);
      context.stroke();
      if (node.noteKind === 'arrow') {
        context.beginPath();
        context.moveTo(node.x + node.width - 12, node.y + node.height - 3);
        context.lineTo(node.x + node.width - inset, node.y + node.height - inset);
        context.lineTo(node.x + node.width - 3, node.y + node.height - 12);
        context.stroke();
      }
      break;
    case 'freehand':
      context.moveTo(node.x + inset, centerY);
      context.bezierCurveTo(
        node.x + node.width * 0.25,
        node.y + inset,
        node.x + node.width * 0.75,
        node.y + node.height - inset,
        node.x + node.width - inset,
        centerY,
      );
      context.stroke();
      break;
    case 'text':
      context.fillStyle = palette.text;
      context.font = `500 ${13 * zoom}px sans-serif`;
      context.textBaseline = 'top';
      context.fillText(node.label || '文本', node.x + 4 * zoom, node.y + 4 * zoom, Math.max(0, node.width - 8 * zoom));
      break;
    case 'image':
      roundedRect(context, node, 6);
      context.stroke();
      break;
    default:
      break;
  }
  context.restore();
}

function drawWrappedText(
  context: OffscreenCanvasRenderingContext2D,
  text: string,
  rect: ProjectSnapshotRect,
  lineHeight: number,
  maxLines: number,
): void {
  const lines = Math.min(maxLines, Math.floor(rect.height / lineHeight));
  if (rect.width <= 0 || lines < 1 || !text) return;
  context.save();
  context.beginPath();
  context.rect(rect.x, rect.y, rect.width, rect.height);
  context.clip();
  let line = '';
  let index = 0;
  for (const character of text) {
    if (character === '\n' || line && context.measureText(line + character).width > rect.width) {
      context.fillText(line, rect.x, rect.y + index * lineHeight);
      if (++index >= lines) { context.restore(); return; }
      line = '';
    }
    if (character !== '\n') line += character;
  }
  if (line) context.fillText(line, rect.x, rect.y + index * lineHeight);
  context.restore();
}

/** 小图只画有界正文和简表，字体跟画布缩放走，不在 Worker 里还原整份 UI。 */
function drawNodePreview(
  context: OffscreenCanvasRenderingContext2D,
  node: ProjectSnapshotNode,
  palette: ProjectSnapshotPalette,
  zoom: number,
): void {
  const preview = node.preview;
  const padding = 8 * zoom;
  const body = { x: node.x + padding, y: node.y + padding,
    width: node.width - padding * 2, height: node.height - padding * 2 };
  if (!preview || body.width <= 0 || body.height <= 0) return;
  context.save();
  roundedRect(context, node, 8);
  context.clip();
  context.textBaseline = 'top';
  if (preview.kind === 'text') {
    context.fillStyle = palette.text;
    context.font = `${12 * zoom}px sans-serif`;
    drawWrappedText(context, preview.text, body, 18 * zoom, 16);
  } else if (preview.columns.length) {
    const headerHeight = 24 * zoom;
    const top = body.y + 24 * zoom;
    const availableHeight = body.height - 24 * zoom - headerHeight;
    const rows = preview.rows.slice(0, Math.max(0, Math.floor(availableHeight / (28 * zoom))));
    const rowHeight = Math.min(36 * zoom, availableHeight / Math.max(1, rows.length));
    if (rowHeight > 0) {
      const totalWeight = preview.columns.reduce((sum, column) => sum + column.weight, 0);
      context.fillStyle = palette.hover;
      context.fillRect(body.x, top, body.width, headerHeight);
      context.strokeStyle = palette.border;
      context.lineWidth = zoom;
      let left = body.x;
      for (let column = 0; column < preview.columns.length; column++) {
        const width = body.width * preview.columns[column].weight / totalWeight;
        context.fillStyle = palette.muted;
        context.font = `500 ${10 * zoom}px sans-serif`;
        drawWrappedText(context, preview.columns[column].label,
          { x: left + 3 * zoom, y: top + 5 * zoom, width: width - 6 * zoom, height: headerHeight }, 14 * zoom, 1);
        context.strokeRect(left, top, width, headerHeight);
        for (let row = 0; row < rows.length; row++) {
          const y = top + headerHeight + row * rowHeight;
          context.strokeRect(left, y, width, rowHeight);
          context.fillStyle = palette.textSecondary;
          context.font = `${11 * zoom}px sans-serif`;
          drawWrappedText(context, rows[row][column] ?? '',
            { x: left + 3 * zoom, y: y + 3 * zoom, width: width - 6 * zoom, height: rowHeight - 6 * zoom }, 14 * zoom, 2);
        }
        left += width;
      }
    }
  }
  context.restore();
}

type EncodedSnapshot = { buffer: ArrayBuffer; mimeType: 'image/webp' | 'image/png' | 'image/jpeg' };

async function encodeSnapshot(canvas: OffscreenCanvas): Promise<EncodedSnapshot> {
  for (const type of ['image/webp', 'image/jpeg'] as const) {
    for (const quality of SNAPSHOT_QUALITIES) {
      const blob = await canvas.convertToBlob({ type, quality });
      if (blob.type !== 'image/webp' && blob.type !== 'image/png' && blob.type !== 'image/jpeg') throw new Error('Unsupported snapshot image type');
      if (blob.size <= MAX_BLOB_SIZE) return { buffer: await blob.arrayBuffer(), mimeType: blob.type };
      // WebKit 回退的 PNG 不受质量参数影响，超限就直接试下一种编码。
      if (blob.type !== type) break;
    }
  }
  throw new Error('Snapshot image exceeds size budget');
}

async function renderSnapshot(request: ProjectSnapshotWorkerRequest): Promise<EncodedSnapshot> {
  const canvas = new OffscreenCanvas(request.width, request.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('OffscreenCanvas 2D context unavailable');

  const scaleX = request.width / request.sourceWidth;
  const scaleY = request.height / request.sourceHeight;
  const projected = projectSnapshotGeometry(request.geometry, request.viewport, request.sourceWidth, request.sourceHeight);
  context.fillStyle = request.backgroundColor || '#0a0a0f';
  context.fillRect(0, 0, request.width, request.height);
  context.save();
  context.scale(scaleX, scaleY);

  context.strokeStyle = request.palette.muted;
  context.globalAlpha = 0.42;
  context.lineWidth = Math.max(1 / Math.min(scaleX, scaleY), 1);
  for (const edge of projected.edges) {
    if (edge.points.length < 2) continue;
    context.beginPath();
    context.moveTo(edge.points[0].x, edge.points[0].y);
    for (const point of edge.points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  }
  context.globalAlpha = 1;

  for (const node of projected.nodes) {
    if (node.noteKind) {
      drawCanvasNote(context, node, request.palette, request.viewport.zoom);
      continue;
    }
    roundedRect(context, node, 8);
    context.fillStyle = request.palette.card;
    context.fill();
    context.strokeStyle = request.palette.border;
    context.lineWidth = 1;
    context.stroke();
    drawNodePreview(context, node, request.palette, request.viewport.zoom);
  }

  for (const media of request.media) {
    if (!Number.isInteger(media.pixelWidth) || !Number.isInteger(media.pixelHeight)
      || media.pixelWidth <= 0 || media.pixelHeight <= 0
      || media.pixelWidth > MAX_MEDIA_EDGE || media.pixelHeight > MAX_MEDIA_EDGE
      || !(media.pixels instanceof ArrayBuffer)
      || media.pixels.byteLength !== media.pixelWidth * media.pixelHeight * 4) {
      throw new Error('Invalid snapshot media pixels');
    }
    const drawRect = getMediaDrawRect(media);
    const surface = new OffscreenCanvas(media.pixelWidth, media.pixelHeight);
    try {
      const mediaContext = surface.getContext('2d');
      if (!mediaContext) throw new Error('Snapshot media context unavailable');
      mediaContext.putImageData(new ImageData(new Uint8ClampedArray(media.pixels), media.pixelWidth, media.pixelHeight), 0, 0);
      context.save();
      try {
        roundedRect(context, media, 6);
        context.clip();
        context.drawImage(surface, drawRect.x, drawRect.y, drawRect.width, drawRect.height);
      } finally {
        context.restore();
      }
    } finally {
      surface.width = 0;
      surface.height = 0;
    }
  }

  context.font = `600 ${11 * request.viewport.zoom}px sans-serif`;
  context.textBaseline = 'bottom';
  for (const node of projected.nodes) {
    if (!node.label || node.noteKind) continue;
    context.fillStyle = request.palette.text;
    const maxWidth = Math.max(0, node.width - 8 * request.viewport.zoom);
    context.fillText(node.label, node.x + 4 * request.viewport.zoom, node.y - 3 * request.viewport.zoom, maxWidth);
  }

  context.restore();
  return encodeSnapshot(canvas);
}

workerScope.onmessage = (event) => {
  const request = event.data;
  void renderSnapshot(request)
    .then(({ buffer, mimeType }) => {
      workerScope.postMessage({
        id: request.id,
        ok: true,
        buffer,
        mimeType,
      }, [buffer]);
    })
    .catch((error) => {
      workerScope.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
};
