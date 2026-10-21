import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { ReferencePreviewContent, ReferencePreviewSource } from '../../types/referencePreview';
import { findReferencePreviewSource, REFERENCE_PREVIEW_EVENT, requestReferencePreview } from '../../utils/referencePreviewEvents';
import ModalOverlay from './ModalOverlay';

const ReferenceContentPreview = lazy(() => import('./ReferenceContentPreview'));

interface PreviewSession {
  key: number;
  content: ReferencePreviewContent;
  loading: boolean;
}

/** 每个宿主窗口一个入口，覆盖编辑器和 Portal，不为每枚胶囊挂载播放器或订阅画布。 */
export default function ReferencePreviewHost({ detached = false }: { detached?: boolean }) {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const request = useRef<{ controller: AbortController; unsubscribe: () => void } | null>(null);
  const serial = useRef(0);
  const lastOpen = useRef<{ key: string; time: number } | null>(null);
  const swallowEscape = useRef(false);
  const close = useCallback(() => {
    serial.current++;
    request.current?.controller.abort();
    request.current?.unsubscribe();
    request.current = null;
    setSession(null);
  }, []);

  useEffect(() => {
    const open = (source: ReferencePreviewSource) => {
      const identity = JSON.stringify([source.kind, source.id, source.ownerNodeId, source.value]);
      const now = Date.now();
      // 编辑器指针兼容入口与浏览器原生 dblclick 可能属于同一次手势。
      if (lastOpen.current?.key === identity && now - lastOpen.current.time < 250) return;
      lastOpen.current = { key: identity, time: now };
      request.current?.controller.abort();
      request.current?.unsubscribe();
      const key = ++serial.current;
      const projectId = useAppStore.getState().currentProjectId;
      const controller = new AbortController();
      const unsubscribe = useAppStore.subscribe((state) => {
        if (state.currentProjectId !== projectId) close();
      });
      request.current = { controller, unsubscribe };
      setSession({ key, content: { kind: 'text', title: source.label || '引用内容' }, loading: true });
      const resolve = async () => {
        if (detached) {
          const { requestDetachedReferencePreview } = await import('../../services/chat/chatReferencePreviewService');
          return controller.signal.aborted ? null : requestDetachedReferencePreview(source, projectId, controller.signal);
        }
        const { resolveReferencePreview } = await import('../../services/referencePreviewService');
        return controller.signal.aborted ? null : resolveReferencePreview(source, { signal: controller.signal });
      };
      void resolve().then((content) => {
        if (content && !controller.signal.aborted && serial.current === key
          && useAppStore.getState().currentProjectId === projectId) setSession({ key, content, loading: false });
      }, () => {
        if (!controller.signal.aborted && serial.current === key) setSession({ key, loading: false,
          content: { kind: 'text', title: source.label || '引用内容', unavailable: '内容读取失败，请检查引用是否仍可用后重试' } });
      });
    };
    const doubleClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey) return;
      const source = findReferencePreviewSource(event.target);
      if (!source) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestReferencePreview(source);
    };
    const requested = (event: Event) => {
      const source = (event as CustomEvent<ReferencePreviewSource>).detail;
      if (source && ['node', 'drama', 'asset', 'workflow', 'skill', 'model', 'chat-image'].includes(source.kind)
        && typeof source.id === 'string' && typeof source.label === 'string'
        && (source.value === undefined || typeof source.value === 'string')
        && (source.ownerNodeId === undefined || typeof source.ownerNodeId === 'string')) open(source);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((request.current || swallowEscape.current) && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        swallowEscape.current = true;
        if (request.current) {
          // 先保留播放器的内部 Esc 层级，再关闭引用；不让按键穿到背景资产弹窗。
          const fullscreen = document.fullscreenElement;
          const playerMenu = document.querySelector<HTMLButtonElement>(
            '.reference-content-preview [data-video-speed-trigger][aria-expanded="true"], .reference-content-preview [data-video-time-trigger][aria-expanded="true"]',
          );
          if (fullscreen?.closest('.reference-content-preview')) void document.exitFullscreen?.().catch(() => undefined);
          else if (playerMenu) { playerMenu.click(); playerMenu.focus(); }
          else close();
        }
        return;
      }
      // 可聚焦引用用 Enter 预览，输入正文和工作流值区继续使用自己的键盘语义。
      if (event.key !== 'Enter' || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const element = event.target instanceof HTMLElement ? event.target : null;
      if (!element || element.isContentEditable || element.matches('input, textarea, select')) return;
      const source = findReferencePreviewSource(element);
      if (!source) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestReferencePreview(source);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !swallowEscape.current) return;
      swallowEscape.current = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const blur = () => { swallowEscape.current = false; };
    document.addEventListener('dblclick', doubleClick, true);
    document.addEventListener(REFERENCE_PREVIEW_EVENT, requested);
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    window.addEventListener('blur', blur);
    return () => {
      request.current?.controller.abort();
      request.current?.unsubscribe();
      request.current = null;
      document.removeEventListener('dblclick', doubleClick, true);
      document.removeEventListener(REFERENCE_PREVIEW_EVENT, requested);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('blur', blur);
    };
  }, [close, detached]);

  if (!session) return null;
  return <Suspense fallback={<ModalOverlay isOpen onClose={close} ariaLabel="引用内容"
    className="asset-image-preview reference-content-preview" zIndex={400} motionPreset="quick" backdropBlur={false}>
    <div data-reference-preview-open className="p-3 text-sm text-canvas-text-secondary" role="status">正在打开引用内容…</div>
  </ModalOverlay>}>
    <ReferenceContentPreview key={session.key} content={session.content} loading={session.loading} onClose={close} />
  </Suspense>;
}
