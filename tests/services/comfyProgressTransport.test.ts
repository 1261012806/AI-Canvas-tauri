import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectNativeComfyProgress } from '../../src/services/comfyProgressTransport';

const { invokeMock, channels } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  channels: [] as Array<{ onmessage: (event: unknown) => void }>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class {
    onmessage: (event: unknown) => void = () => {};

    constructor() {
      channels.push(this);
    }
  },
}));

let resolveStream: () => void = () => {};
let rejectStream: (error: Error) => void = () => {};

function connectionOptions() {
  return {
    baseUrl: 'https://comfy.example.test/prefix',
    clientId: 'canvas-client',
    requestId: 'request-1.1',
    onOpen: vi.fn(),
    onMessage: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
}

beforeEach(() => {
  channels.length = 0;
  invokeMock.mockReset().mockImplementation((command: string) => {
    if (command === 'stream_comfyui_progress') {
      return new Promise<void>((resolve, reject) => {
        resolveStream = resolve;
        rejectStream = reject;
      });
    }
    return Promise.resolve();
  });
});

describe('connectNativeComfyProgress', () => {
  it('通过绑定的原生 Channel 透传文本和结构化事件，并只通知一次结束', async () => {
    const options = connectionOptions();
    const close = connectNativeComfyProgress(options);
    expect(invokeMock).toHaveBeenCalledWith('stream_comfyui_progress', {
      baseUrl: options.baseUrl, clientId: options.clientId, requestId: options.requestId,
      onEvent: channels[0],
    });
    const first = JSON.stringify({ type: 'progress', data: { prompt_id: 'p1', value: 2, max: 8 } });
    const second = { type: 'executing', data: { prompt_id: 'p1', node: '8' } };
    channels[0].onmessage({ event: 'open' });
    channels[0].onmessage({ event: 'message', data: first });
    channels[0].onmessage({ event: 'message', data: second });
    expect(options.onOpen).toHaveBeenCalledTimes(1);
    expect(options.onMessage).toHaveBeenNthCalledWith(1, first);
    expect(options.onMessage).toHaveBeenNthCalledWith(2, second);

    resolveStream();
    await Promise.resolve();
    channels[0].onmessage({ event: 'message', data: first });
    channels[0].onmessage({ event: 'error', status: 403 });
    close();
    expect(options.onMessage).toHaveBeenCalledTimes(2);
    expect(options.onError).not.toHaveBeenCalled();
    expect(options.onClose).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('关闭早于原生登记时，迟到 open 会再次取消，停止后不再通知订阅者', async () => {
    const options = connectionOptions();
    const close = connectNativeComfyProgress(options);
    close();
    close();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith('cancel_comfyui_progress', { requestId: options.requestId });

    channels[0].onmessage({ event: 'open' });
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock).toHaveBeenLastCalledWith('cancel_comfyui_progress', { requestId: options.requestId });
    channels[0].onmessage({ event: 'message', data: 'late-message' });
    channels[0].onmessage({ event: 'error', status: 403 });
    resolveStream();
    await Promise.resolve();
    channels[0].onmessage({ event: 'open' });

    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(options.onOpen).not.toHaveBeenCalled();
    expect(options.onMessage).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
    expect(options.onClose).not.toHaveBeenCalled();
  });

  it.each([401, 403])('原生鉴权错误 %s 和后续命令拒绝合并为一次错误与一次结束', async (status) => {
    const options = connectionOptions();
    const close = connectNativeComfyProgress(options);
    channels[0].onmessage({ event: 'error', status });
    channels[0].onmessage({ event: 'error', status });
    rejectStream(new Error('stream ended after handshake rejection'));
    await Promise.resolve();
    channels[0].onmessage({ event: 'error', status });
    close();
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(status);
    expect(options.onClose).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('命令在握手前拒绝时报告一次连接错误，并清掉 Channel 回调', async () => {
    const options = connectionOptions();
    const close = connectNativeComfyProgress(options);
    rejectStream(new Error('connection failed'));
    await Promise.resolve();
    channels[0].onmessage({ event: 'open' });
    channels[0].onmessage({ event: 'message', data: 'late-message' });
    close();
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(options.onClose).toHaveBeenCalledTimes(1);
    expect(options.onOpen).not.toHaveBeenCalled();
    expect(options.onMessage).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('用户关闭后迟到的命令拒绝不会转成连接错误或结束通知', async () => {
    const options = connectionOptions();
    const close = connectNativeComfyProgress(options);
    close();
    rejectStream(new Error('cancelled during registration'));
    await Promise.resolve();
    expect(options.onError).not.toHaveBeenCalled();
    expect(options.onClose).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
