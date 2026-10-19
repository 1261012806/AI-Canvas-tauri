import { memo, useContext, useEffect, useLayoutEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { useStoreApi } from '@xyflow/react';
import { useAppStore } from '../../../../store/useAppStore';
import { CanvasNodeLodContext } from '../../../../hooks/useCanvasNodeLod';
import { createCanvasDisplayScheduler } from '../../../../services/canvasDisplayScheduler';
import { createCanvasImageDisplay, type DisplayImageLease } from './canvasImageDisplay';

interface CanvasPreviewImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  nodeWidth: number;
  nodeHeight: number;
  nodeId?: string;
  projectId?: string | null;
}

/** 稳定的 img 承载全部清晰度档；资源就绪且显示队列允许时才更换 src。 */
function CanvasPreviewImage({ src, nodeWidth, nodeHeight, nodeId, projectId, onError, ...imageProps }: CanvasPreviewImageProps) {
  const runtime = useContext(CanvasNodeLodContext);
  const flow = useStoreApi();
  const controller = useRef<ReturnType<typeof createCanvasImageDisplay> | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const geometry = useRef({ width: nodeWidth, height: nodeHeight });
  const [preview, setPreview] = useState<{ source: string; projectId?: string | null; lease: DisplayImageLease }>();

  useLayoutEffect(() => {
    geometry.current = { width: nodeWidth, height: nodeHeight };
    controller.current?.viewport(flow.getState().transform[2], nodeWidth, nodeHeight, window.devicePixelRatio || 1, useAppStore.getState().config.performanceMode === true);
  }, [flow, nodeWidth, nodeHeight]);

  useEffect(() => {
    if (!src) return;
    const fallback = runtime ? null : createCanvasDisplayScheduler();
    const display = createCanvasImageDisplay({
      source: src, projectId,
      queue: {
        enqueue: (key, commit, delay) => runtime
          ? runtime.enqueueDisplay(key, commit, nodeId, delay) : fallback!.enqueue(key, commit, undefined, delay),
        prepare: (key, work, delay) => runtime
          ? runtime.prepareDisplay(key, work, nodeId, delay) : fallback!.prepare(key, work, undefined, delay),
      },
      publish: (lease) => setPreview({ source: src, projectId, lease }),
      onError: () => imageRef.current?.dispatchEvent(new Event('error')),
    });
    controller.current = display;
    let lastZoom: number | undefined;
    let lastRatio: number | undefined;
    let lastPerformanceMode: boolean | undefined;
    const refresh = () => {
      const zoom = flow.getState().transform[2];
      const ratio = window.devicePixelRatio || 1;
      const performanceMode = useAppStore.getState().config.performanceMode === true;
      if (lastZoom === zoom && lastRatio === ratio && lastPerformanceMode === performanceMode) return;
      lastZoom = zoom;
      lastRatio = ratio;
      lastPerformanceMode = performanceMode;
      display.viewport(zoom, geometry.current.width, geometry.current.height, ratio, performanceMode);
    };
    refresh();
    const unsubscribe = flow.subscribe(refresh);
    // 更新现有控制器，保留当前图片和租约，避免开关引发整批图片重新挂载。
    const unsubscribeConfig = useAppStore.subscribe((state, previous) => {
      if (state.config.performanceMode !== previous.config.performanceMode) refresh();
    });
    window.addEventListener('resize', refresh);
    return () => {
      unsubscribe();
      unsubscribeConfig();
      window.removeEventListener('resize', refresh);
      display.dispose();
      fallback?.deactivate();
      if (controller.current === display) controller.current = null;
    };
  }, [src, projectId, nodeId, flow, runtime]);

  useLayoutEffect(() => {
    if (preview) controller.current?.committed(preview.lease);
  }, [preview]);

  const resolved = preview && preview.source === src && preview.projectId === projectId ? preview.lease.src : undefined;
  return <img {...imageProps} ref={imageRef} src={resolved} decoding="async" onError={onError} />;
}

export default memo(CanvasPreviewImage);
