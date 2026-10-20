import { Channel, invoke } from '@tauri-apps/api/core';

type NativeProgressEvent =
  | { event: 'open' }
  | { event: 'message'; data: unknown }
  | { event: 'error'; status?: number };

interface NativeProgressOptions {
  baseUrl: string;
  clientId: string;
  /** 每次连接独立，重连仍使用相同 clientId。 */
  requestId: string;
  onOpen: () => void;
  onMessage: (data: unknown) => void;
  onError: (status?: number) => void;
  onClose: () => void;
}

/** 桌面端通过原生只读通道连接 ComfyUI，不经过 WebView 的跨域/混合内容检查。 */
export function connectNativeComfyProgress(options: NativeProgressOptions): () => void {
  let stopped = false;
  let settled = false;
  let errorReported = false;
  const channel = new Channel<NativeProgressEvent>();
  const cancel = () => {
    void invoke('cancel_comfyui_progress', { requestId: options.requestId }).catch(() => {});
  };
  const reportError = (status?: number) => {
    if (stopped || errorReported) return;
    errorReported = true;
    options.onError(status);
  };
  channel.onmessage = (event) => {
    if (stopped) {
      // close 可能早于原生命令登记；迟到的握手成功必须再取消，不能留下后台连接。
      if (!settled && event.event === 'open') cancel();
      return;
    }
    if (event.event === 'open') options.onOpen();
    else if (event.event === 'message') options.onMessage(event.data);
    else if (event.event === 'error') reportError(event.status);
  };
  const finish = () => {
    settled = true;
    channel.onmessage = () => {};
    if (stopped) return;
    stopped = true;
    options.onClose();
  };
  void invoke<void>('stream_comfyui_progress', {
    baseUrl: options.baseUrl,
    clientId: options.clientId,
    requestId: options.requestId,
    onEvent: channel,
  }).then(finish, () => {
    reportError();
    finish();
  });

  return () => {
    if (stopped) return;
    stopped = true;
    cancel();
  };
}
