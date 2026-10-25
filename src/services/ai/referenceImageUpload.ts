import { invoke, isTauri } from '@tauri-apps/api/core';
import { parseRasterImageDimensions } from '../rasterImageDimensions';

const MAX_LOSSLESS_IMAGE_PIXELS = 24_000_000;
const APIMART_MAX_IMAGE_BYTES = 20_000_000;
const MAX_LOSSLESS_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_LOSSLESS_IMAGE_EDGE = 16384;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
let compressionTail: Promise<unknown> = Promise.resolve();

function inspectLosslessPng(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 33 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || Math.max(width, height) > MAX_LOSSLESS_IMAGE_EDGE || width * height > MAX_LOSSLESS_IMAGE_PIXELS) return;
  let hasImageData = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    const end = offset + length + 12;
    if (end > bytes.length || type === 0x6163544c) return; // acTL：动画不能展平成静态图。
    if (type === 0x49444154) hasImageData = true; // IDAT
    if (type === 0x49454e44) return hasImageData && length === 0 && end === bytes.length ? { width, height } : undefined;
    offset = end;
  }
}

async function optimizeReferenceImage(blob: Blob, signal?: AbortSignal): Promise<Blob> {
  try {
    signal?.throwIfAborted();
    if (blob.size > MAX_LOSSLESS_IMAGE_BYTES || !isTauri()) return blob;
    const prefix = new Uint8Array(await blob.slice(0, PNG_SIGNATURE.length).arrayBuffer());
    signal?.throwIfAborted();
    const isPng = PNG_SIGNATURE.every((value, index) => prefix[index] === value);
    const isJpeg = prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
    if (!isPng && !isJpeg) return blob;
    const input = await blob.arrayBuffer();
    signal?.throwIfAborted();
    const inputBytes = new Uint8Array(input);
    const dimensions = isPng ? inspectLosslessPng(inputBytes) : parseRasterImageDimensions(inputBytes);
    if (!dimensions || Math.max(dimensions.width, dimensions.height) > MAX_LOSSLESS_IMAGE_EDGE
      || dimensions.width * dimensions.height > MAX_LOSSLESS_IMAGE_PIXELS) return blob;
    const output = await invoke<ArrayBuffer | Uint8Array>(isPng ? 'optimize_reference_png' : 'optimize_reference_jpeg', input);
    signal?.throwIfAborted();
    const bytes = output instanceof ArrayBuffer ? new Uint8Array(output) : output;
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length >= blob.size) return blob;
    const sameFormat = isPng ? PNG_SIGNATURE.every((value, index) => bytes[index] === value)
      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!sameFormat) return blob;
    const optimizedDimensions = isPng ? inspectLosslessPng(bytes) : parseRasterImageDimensions(bytes);
    if (!optimizedDimensions || optimizedDimensions.width !== dimensions.width || optimizedDimensions.height !== dimensions.height) return blob;
    return new Blob([new Uint8Array(bytes)], { type: isPng ? 'image/png' : 'image/jpeg' });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    return blob;
  }
}

/** 只对上传副本做原生无损减重；保留尺寸、格式与动画，不走 Web 有损回退。 */
export async function prepareReferenceImageUpload(blob: Blob, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const operation = compressionTail.then(() => optimizeReferenceImage(blob, signal));
  // 取消只停止调用方等待；原生仍在压缩时不能让下一张占用串行槽。
  compressionTail = operation.catch(() => undefined);
  const prepared = !signal ? await operation : await new Promise<Blob>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
  signal?.throwIfAborted();
  return prepared;
}

/** APIMart 在无损准备后按上传接口的十进制 20 MB 限制拦截。 */
export async function prepareApimartImageUpload(blob: Blob, signal?: AbortSignal): Promise<Blob> {
  const prepared = await prepareReferenceImageUpload(blob, signal);
  if (prepared.size > APIMART_MAX_IMAGE_BYTES) {
    throw new Error('APIMart 单张参考图不能超过 20 MB；原图或无损处理结果仍超限。仅静态 PNG/JPEG 尝试无损压缩，其他格式和动画保留原样，请手动准备符合限制的图片');
  }
  return prepared;
}

/** 最多同时准备两张，按原下标存放；失败停止领取新图，禁止过滤后发送错位的引用。 */
export async function mapReferenceImagesInOrder<T, R>(
  inputs: readonly T[],
  prepare: (input: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  signal?.throwIfAborted();
  const results = new Array<R>(inputs.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && nextIndex < inputs.length) {
      const index = nextIndex++;
      try {
        signal?.throwIfAborted();
        results[index] = await prepare(inputs[index], index);
        signal?.throwIfAborted();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, inputs.length) }, worker));
  if (failed) throw failure;
  return results;
}
