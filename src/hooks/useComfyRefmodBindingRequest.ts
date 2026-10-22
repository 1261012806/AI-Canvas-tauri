import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComfyRefmodBindingRequest, ComfyRefmodBindingResolver, ComfyRefmodSelection } from '../types/comfyRefmod';

/** 映射只活在调用方组件中；切项目、卸载或取消均拒绝未完成请求。 */
export function useComfyRefmodBindingRequest(projectId: string | null) {
  const [view, setView] = useState<{ request: ComfyRefmodBindingRequest; projectId: string | null; id: number }>();
  const request = view?.projectId === projectId ? view.request : undefined;
  const sequence = useRef(0);
  const mounted = useRef(true);
  const pending = useRef<{ request: ComfyRefmodBindingRequest; resolve: (items: ComfyRefmodSelection[]) => void; reject: (error: Error) => void } | undefined>(undefined);
  const requestMapping: ComfyRefmodBindingResolver = useCallback((next) => new Promise<ComfyRefmodSelection[]>((resolve, reject) => {
    if (!mounted.current) { reject(new Error('窗口已关闭，请重新添加角色参考包')); return; }
    pending.current?.reject(new Error('角色映射请求已被替换，请重新添加'));
    pending.current = { request: next, resolve, reject };
    setView({ request: next, projectId, id: ++sequence.current });
  }), [projectId]);
  const close = useCallback(() => {
    pending.current?.reject(new Error('已取消添加角色参考包'));
    pending.current = undefined; setView(undefined);
  }, []);
  const apply = useCallback((items: ComfyRefmodSelection[]) => {
    if (!request || pending.current?.request !== request) return;
    pending.current.resolve(items);
    pending.current = undefined; setView(undefined);
  }, [request]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.reject(new Error('项目或窗口已变化，请重新添加角色参考包'));
      pending.current = undefined;
      setView(undefined);
    };
  }, [projectId]);
  return { request, requestId: view?.id, requestMapping, close, apply };
}
