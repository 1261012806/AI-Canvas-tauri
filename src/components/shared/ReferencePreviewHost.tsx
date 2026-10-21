import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { ReferencePreviewContent, ReferencePreviewSource } from '../../types/referencePreview';
import { findReferencePreviewSource, REFERENCE_PREVIEW_EVENT, requestReferencePreview } from '../../utils/referencePreviewEvents';
import ModalOverlay from './ModalOverlay';

const ReferenceContentPreview = lazy(() => import('./ReferenceContentPreview'));

interface PreviewSession {
  key: number;
  source: ReferencePreviewSource;
  content: ReferencePreviewContent;
  loading: boolean;
  canGoBack: boolean;
}

type Navigation = 'root' | 'nested' | 'back';
const sourceKey = (source: ReferencePreviewSource) => JSON.stringify([
  source.kind, source.id, source.kind === 'workflow' ? source.ownerNodeId : undefined, source.value,
]);

/** 每个宿主窗口一个入口，覆盖编辑器和 Portal，不为每枚胶囊挂载播放器或订阅画布。 */
export default function ReferencePreviewHost({ detached = false }: { detached?: boolean }) {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const request = useRef<{ controller: AbortController; unsubscribe: () => void } | null>(null);
  const serial = useRef(0);
  // 仅保留最近 8 层引用身份；返回时重读，不缓存隐藏媒体或大段正文。
  const history = useRef<ReferencePreviewSource[]>([]);
  const currentSource = useRef<ReferencePreviewSource | null>(null);
  const openRef = useRef<((source: ReferencePreviewSource, navigation: Navigation) => void) | null>(null);
  const lastOpen = useRef<{ key: string; time: number } | null>(null);
  const swallowEscape = useRef(false);
  const close = useCallback(() => {
    serial.current++;
    request.current?.controller.abort();
    request.current?.unsubscribe();
    request.current = null;
    history.current = [];
    currentSource.current = null;
    lastOpen.current = null;
    setSession(null);
  }, []);
  const back = useCallback(() => {
    const previous = history.current.pop();
    if (previous) openRef.current?.(previous, 'back');
    else close();
  }, [close]);

  useEffect(() => {
    const open = (source: ReferencePreviewSource, navigation: Navigation) => {
      const identity = sourceKey(source);
      const now = Date.now();
      // 编辑器指针兼容入口与浏览器原生 dblclick 可能属于同一次手势。
      if (navigation !== 'back' && lastOpen.current?.key === identity && now - lastOpen.current.time < 250) return;
      if (navigation === 'nested' && currentSource.current && sourceKey(currentSource.current) === identity) return;
      if (navigation === 'root') history.current = [];
      else if (navigation === 'nested' && currentSource.current) history.current = [...history.current.slice(-7), currentSource.current];
      currentSource.current = source;
      const canGoBack = history.current.length > 0;
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
      setSession({ key, source, content: { kind: 'text', title: source.label || '引用内容' }, loading: true, canGoBack });
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
          && useAppStore.getState().currentProjectId === projectId) setSession({ key, source, content, loading: false, canGoBack });
      }, () => {
        if (!controller.signal.aborted && serial.current === key) setSession({ key, source, loading: false, canGoBack,
          content: { kind: 'text', title: source.label || '引用内容', unavailable: '内容读取失败，请检查引用是否仍可用后重试' } });
      });
    };
    openRef.current = open;
    const doubleClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey) return;
      const source = findReferencePreviewSource(event.target);
      if (!source) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestReferencePreview(source, event.target instanceof Element ? event.target : document);
    };
    const requested = (event: Event) => {
      const source = (event as CustomEvent<ReferencePreviewSource>).detail;
      if (source && ['node', 'drama', 'asset', 'workflow', 'skill', 'model', 'chat-image'].includes(source.kind)
        && typeof source.id === 'string' && typeof source.label === 'string'
        && (source.value === undefined || typeof source.value === 'string')
        && (source.ownerNodeId === undefined || typeof source.ownerNodeId === 'string')) {
        open(source, event.target instanceof Element && event.target.closest('.reference-content-preview') ? 'nested' : 'root');
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((request.current || swallowEscape.current) && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat || swallowEscape.current) return;
        swallowEscape.current = true;
        if (request.current) {
          // 先保留播放器的内部 Esc 层级，再关闭引用；不让按键穿到背景资产弹窗。
          const fullscreen = document.fullscreenElement;
          const playerMenu = document.querySelector<HTMLButtonElement>(
            '.reference-content-preview [data-video-speed-trigger][aria-expanded="true"], .reference-content-preview [data-video-time-trigger][aria-expanded="true"]',
          );
          if (fullscreen?.closest('.reference-content-preview')) void document.exitFullscreen?.().catch(() => undefined);
          else if (playerMenu) { playerMenu.click(); playerMenu.focus(); }
          else back();
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
      requestReferencePreview(source, element);
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
      openRef.current = null;
      history.current = [];
      currentSource.current = null;
      document.removeEventListener('dblclick', doubleClick, true);
      document.removeEventListener(REFERENCE_PREVIEW_EVENT, requested);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('blur', blur);
    };
  }, [back, close, detached]);

  if (!session) return null;
  return <Suspense fallback={<ModalOverlay isOpen onClose={close} ariaLabel="引用内容"
    className="asset-image-preview reference-content-preview" zIndex={400} motionPreset="quick" backdropBlur={false}>
    <div data-reference-preview-open className="p-3 text-sm text-canvas-text-secondary" role="status">正在打开引用内容…</div>
  </ModalOverlay>}>
    <ReferenceContentPreview key={session.key} source={session.source} content={session.content} loading={session.loading}
      onBack={session.canGoBack ? back : undefined} onClose={close} />
  </Suspense>;
}
