/** 状态类短查询的完整读取预算；生成提交、上传和长流不使用此入口。 */
export const COMFY_QUERY_TIMEOUT_MS = 15_000;

export function withComfyQueryTimeout<T>(
  query: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = COMFY_QUERY_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (deliver: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      deliver();
    };
    const cancel = (reason: unknown) => {
      controller.abort(reason);
      finish(() => reject(reason));
    };
    const onAbort = () => cancel(signal?.reason ?? new DOMException('查询已取消', 'AbortError'));
    const timer = globalThis.setTimeout(() => cancel(new DOMException(
      'ComfyUI 状态查询超时，请检查连接后继续查询', 'TimeoutError',
    )), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try {
      void query(controller.signal).then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
