import { describe, expect, it } from 'vitest';
import { withComfyQueryTimeout } from '../../src/services/comfyQuery';

describe('ComfyUI 短查询预算', () => {
  it('连接不返回时结束等待并取消底层请求', async () => {
    let requestSignal: AbortSignal | undefined;
    const operation = withComfyQueryTimeout((signal) => {
      requestSignal = signal;
      return new Promise<never>(() => {});
    }, undefined, 1);
    await expect(operation).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('响应头已返回但读取 body 卡住时仍受同一预算约束', async () => {
    let responseReceived = false;
    const operation = withComfyQueryTimeout(async (signal) => {
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }));
      responseReceived = true;
      return response.json();
    }, undefined, 1);
    await expect(operation).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(responseReceived).toBe(true);
  });

  it('外部取消立即结束查询，已取消的调用不启动请求', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const operation = withComfyQueryTimeout((signal) => {
      requestSignal = signal;
      return new Promise<never>(() => {});
    }, controller.signal);
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(true);
    let invoked = false;
    await expect(withComfyQueryTimeout(async () => { invoked = true; }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(invoked).toBe(false);
  });

  it('正常读完后清理监听，不让后续外部取消影响已完成请求', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    await expect(withComfyQueryTimeout(async (signal) => {
      requestSignal = signal;
      return { ok: true };
    }, controller.signal)).resolves.toEqual({ ok: true });
    controller.abort();
    expect(requestSignal?.aborted).toBe(false);
  });
});
