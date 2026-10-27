import { acquireComfyMediaSource, isNativeComfyMediaSource, shouldLoadNativeComfyMedia } from '../services/comfyMediaSource';
import { useComfySourceLease } from './useComfyImageSource';

/** 只在消费者实际挂载来源时申请窗口私有的原生媒体租约。 */
export function useComfyMediaSource(source?: string, onError?: () => void): string | undefined {
  return useComfySourceLease(source, onError, acquireComfyMediaSource, shouldLoadNativeComfyMedia, isNativeComfyMediaSource);
}
