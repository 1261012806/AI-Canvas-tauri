/**
 * ai/modelProtocolHttp — 协议执行过程中的 HTTP 细节与结果解码。
 *
 * 错误响应按协议声明的 errorPath 抽取上游文案；结果下载强制同源，
 * Base64 / PCM 结果在前端转成 data URL，避免把二进制处理散落到各调用方。
 */
import type { ModelProtocolAuthConfig, ModelProtocolResultConfig, ProtocolJsonValue } from '../../types/aiTypes';
import { corsSafeFetch } from './httpTransport';
import { readModelProtocolFirstScalar } from './modelProtocolResponse';
import { MIME_TYPE_RE, isRecord, resolveAuthentication, validateHeaderName } from './modelProtocolShared';
import { applyQueryAuthentication } from './modelProtocolRequest';
import { PollTaskFailedError, PollTimeoutError } from '../pollTask';

export class ModelProtocolHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(
    status: number,
    message: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ModelProtocolHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 只移除本次连接的凭据，保留错误状态和上游的其他诊断信息。 */
export function redactModelProtocolErrorText(message: string, apiKey: string): string {
  if (!apiKey) return message;
  // 查询鉴权用表单规则编码，空格和部分标点与 encodeURIComponent 不同。
  const formEncoded = new URLSearchParams({ key: apiKey }).toString().slice('key='.length);
  const secrets = [...new Set([apiKey, encodeURIComponent(apiKey), formEncoded])]
    .sort((left, right) => right.length - left.length);
  return secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), message);
}

/** 验证器也可能回显 Key；重建异常，避免修改冻结对象或带出原始 cause 和堆栈。 */
export function redactModelProtocolError(error: unknown, apiKey: string): unknown {
  const exception = typeof DOMException !== 'undefined' && error instanceof DOMException ? error : undefined;
  const message = error instanceof Error ? error.message : exception?.message ?? (typeof error === 'string' ? error : undefined);
  if (message === undefined) return error;
  const safeMessage = redactModelProtocolErrorText(message, apiKey);
  if (safeMessage === message) return error;
  if (typeof error === 'string') return safeMessage;
  if (error instanceof ModelProtocolHttpError) return new ModelProtocolHttpError(error.status, safeMessage, error.retryAfterMs);
  if (error instanceof PollTaskFailedError) return new PollTaskFailedError(safeMessage);
  if (error instanceof PollTimeoutError) return new PollTimeoutError(safeMessage);
  if (exception) return new DOMException(safeMessage, redactModelProtocolErrorText(exception.name, apiKey));
  const safeError = error instanceof TypeError ? new TypeError(safeMessage) : new Error(safeMessage);
  if (error instanceof Error) safeError.name = redactModelProtocolErrorText(error.name, apiKey);
  return safeError;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

export async function readJsonResponse(
  response: Response,
  label: string,
  errorPath?: string,
  apiKey = '',
): Promise<ProtocolJsonValue> {
  if (!response.ok) {
    const rawText = await response.text().catch(() => '');
    let payload: unknown;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }
    const configuredMessage = errorPath && (isRecord(payload) || Array.isArray(payload))
      ? readModelProtocolFirstScalar(payload, errorPath)
      : undefined;
    const message = configuredMessage !== undefined && configuredMessage !== null
      ? String(configuredMessage)
      : isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
        ? payload.error.message
        : isRecord(payload) && typeof payload.message === 'string'
          ? payload.message
          : rawText.trim() || `${label} (${response.status})`;
    if (response.status === 429 && /no deployments available/i.test(message)) {
      throw new Error('所选模型暂无可用部署，请稍后手动重试（429）');
    }
    throw new ModelProtocolHttpError(
      response.status,
      `${label} (${response.status}): ${redactModelProtocolErrorText(message, apiKey)}`,
      parseRetryAfterMs(response.headers.get('Retry-After')),
    );
  }
  const payload = await response.json().catch(() => null) as unknown;
  if (!isRecord(payload) && !Array.isArray(payload)) {
    throw new Error(`${label}：响应必须是 JSON 对象或数组`);
  }
  return payload as ProtocolJsonValue;
}

export async function ensureSuccessfulRawResponse(
  response: Response,
  label: string,
  errorPath?: string,
  apiKey = '',
): Promise<Response> {
  if (response.ok) return response;
  await readJsonResponse(response, label, errorPath, apiKey);
  return response;
}

export function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64Bytes(value: string): Uint8Array {
  const encoded = /^data:[^;,]+;base64,/i.test(value)
    ? value.slice(value.indexOf(',') + 1)
    : value;
  const normalized = encoded.replace(/\s/g, '');
  try {
    const binary = atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error('模型响应中的 Base64 结果无效');
  }
}

export function pcmS16LeToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  if (pcm.byteLength % blockAlign !== 0) {
    throw new Error('模型响应中的 PCM 数据长度与声道配置不匹配');
  }
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      wav[offset + index] = value.charCodeAt(index);
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

export function normalizeBase64Result(
  value: string,
  mimeType: string,
  transform?: ModelProtocolResultConfig['base64Transform'],
): string {
  if (transform?.type === 'pcm-s16le-to-wav') {
    const wav = pcmS16LeToWav(
      decodeBase64Bytes(value),
      transform.sampleRate,
      transform.channels ?? 1,
    );
    return `data:audio/wav;base64,${encodeBytesBase64(wav)}`;
  }
  if (/^data:[^;,]+;base64,/i.test(value)) return value;
  return `data:${mimeType};base64,${encodeBytesBase64(decodeBase64Bytes(value))}`;
}

function buildResultAuthenticationHeaders(
  auth: ModelProtocolAuthConfig | undefined,
  apiKey: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  if (extraHeaders !== undefined && !isRecord(extraHeaders)) throw new Error('结果下载请求头必须是 JSON 对象');
  const headers: Record<string, string> = {};
  const errors: string[] = [];
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    validateHeaderName(name, '结果下载请求 ', errors);
    if (typeof value !== 'string') errors.push('结果下载请求头的值必须是字符串');
    headers[name] = value;
  }
  if (errors.length > 0) throw new Error(errors[0]);
  if (!apiKey) return headers;
  const resolvedAuth = resolveAuthentication(auth);
  if (resolvedAuth.type === 'bearer') {
    headers.Authorization = `${resolvedAuth.prefix ?? 'Bearer '}${apiKey}`;
  }
  if (resolvedAuth.type === 'header') {
    headers[resolvedAuth.name!] = `${resolvedAuth.prefix ?? ''}${apiKey}`;
  }
  return headers;
}

export async function fetchSameOriginResultUrls(
  urls: readonly string[],
  baseUrl: string,
  auth: ModelProtocolAuthConfig | undefined,
  apiKey: string,
  fallbackMimeType?: string,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<string[]> {
  signal?.throwIfAborted();
  const headers = buildResultAuthenticationHeaders(auth, apiKey, extraHeaders);
  const allowedOrigin = new URL(baseUrl).origin;
  return Promise.all(urls.map(async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.origin !== allowedOrigin) {
      throw new Error('模型结果下载地址与厂商连接地址不同源');
    }
    const response = await corsSafeFetch(
      applyQueryAuthentication(url.toString(), auth, apiKey),
      { method: 'GET', headers, signal },
    );
    await ensureSuccessfulRawResponse(response, '模型结果下载失败', undefined, apiKey);
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.byteLength === 0) throw new Error('模型结果下载内容为空');
    const responseMimeType = response.headers.get('Content-Type')?.split(';')[0]?.trim();
    const mimeType = responseMimeType && MIME_TYPE_RE.test(responseMimeType)
      ? responseMimeType
      : fallbackMimeType ?? 'application/octet-stream';
    return `data:${mimeType};base64,${encodeBytesBase64(bytes)}`;
  }));
}
