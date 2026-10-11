import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { useReactFlow, type FitViewOptions } from '@xyflow/react';
import { useAppStore } from '../store/useAppStore';
import type { CanvasViewportMode } from '../types';
import {
  CANVAS_ZOOM_PRESETS,
  getCanvasFitViewOptions,
  MAX_CANVAS_ZOOM,
  MIN_CANVAS_ZOOM,
  normalizeCanvasViewportMode,
  normalizeCanvasZoom,
} from '../utils/canvasViewportPreferences';

/** 只管理视口与显示偏好，不修改节点、项目或画布历史。 */
export function useCanvasViewportPreferences(
  rootRef: RefObject<HTMLDivElement | null>,
  cancelWheelRef: RefObject<(() => void) | null>,
) {
  const flow = useReactFlow();
  const projectId = useAppStore((state) => state.currentProjectId);
  const hydrated = useAppStore((state) => state.configHydrated);
  const mode = useAppStore((state) => normalizeCanvasViewportMode(state.config.canvasViewportMode));
  const preferredZoom = useAppStore((state) => normalizeCanvasZoom(state.config.canvasViewportZoom));
  const userMovingRef = useRef(false);
  const isCurrent = useCallback(() => useAppStore.getState().currentProjectId === projectId, [projectId]);

  const savePreference = useCallback((nextMode: CanvasViewportMode, zoom: number) => {
    const state = useAppStore.getState();
    if (!state.configHydrated || !isCurrent()) return;
    state.updateConfig({ canvasViewportMode: nextMode, canvasViewportZoom: normalizeCanvasZoom(zoom) });
    // 保存失败由既有配置状态展示，保留待保存修改。
    void state.saveConfig({ silent: true }).catch(() => {});
  }, [isCurrent]);

  const fitView = useCallback((options: FitViewOptions = {}, restorePreference = false) => {
    if (!isCurrent() || !flow.viewportInitialized) return Promise.resolve(false);
    cancelWheelRef.current?.();
    if (!flow.getNodes().some((node) => !node.hidden)) return Promise.resolve(false);
    return flow.fitView(getCanvasFitViewOptions(useAppStore.getState().config, options, restorePreference));
  }, [cancelWheelRef, flow, isCurrent]);

  const setZoom = useCallback((zoom: number) => {
    const state = useAppStore.getState();
    if (!state.configHydrated || !isCurrent()
      || normalizeCanvasViewportMode(state.config.canvasViewportMode) === 'locked') return;
    cancelWheelRef.current?.();
    savePreference('manual', zoom);
    // 节点定位可能临时改过比例；重复选择已保存的同一预设也必须立即生效。
    void flow.zoomTo(normalizeCanvasZoom(zoom));
  }, [cancelWheelRef, flow, isCurrent, savePreference]);

  const stepZoom = useCallback((direction: number) => {
    const percent = flow.getZoom() * 100;
    const presets = direction > 0 ? CANVAS_ZOOM_PRESETS : [...CANVAS_ZOOM_PRESETS].reverse();
    const next = presets.find((value) => direction > 0 ? value > percent + 0.1 : value < percent - 0.1);
    if (next !== undefined) setZoom(next / 100);
  }, [flow, setZoom]);

  const toggleLock = useCallback(() => {
    cancelWheelRef.current?.();
    const locked = normalizeCanvasViewportMode(useAppStore.getState().config.canvasViewportMode) === 'locked';
    savePreference(locked ? 'manual' : 'locked', flow.getZoom());
  }, [cancelWheelRef, flow, savePreference]);

  const autoFit = useCallback(() => {
    cancelWheelRef.current?.();
    if (normalizeCanvasViewportMode(useAppStore.getState().config.canvasViewportMode) === 'locked') {
      // 锁定时 F 只重新居中，不能改变用户选定的比例。
      void fitView({ padding: 0.2 });
    } else {
      savePreference('auto', flow.getZoom());
      void fitView({ padding: 0.2 });
    }
  }, [cancelWheelRef, fitView, flow, savePreference]);

  const beginUserMove = useCallback(() => {
    const state = useAppStore.getState();
    if (!state.configHydrated || !isCurrent()
      || normalizeCanvasViewportMode(state.config.canvasViewportMode) === 'locked') return;
    userMovingRef.current = true;
    // 不在每帧保存；用户平移或缩放后由手动模式接管，避免 resize 拉回视图。
    if (normalizeCanvasViewportMode(state.config.canvasViewportMode) === 'auto') {
      state.updateConfig({ canvasViewportMode: 'manual', canvasViewportZoom: flow.getZoom() });
    }
  }, [flow, isCurrent]);

  const endUserMove = useCallback(() => {
    if (!userMovingRef.current) return;
    userMovingRef.current = false;
    if (normalizeCanvasViewportMode(useAppStore.getState().config.canvasViewportMode) !== 'locked') {
      savePreference('manual', flow.getZoom());
    }
  }, [flow, savePreference]);

  useEffect(() => {
    if (!hydrated || !flow.viewportInitialized || !isCurrent() || userMovingRef.current) return;
    cancelWheelRef.current?.();
    if (mode === 'auto') {
      void fitView({ padding: 0.2 });
    } else {
      void flow.zoomTo(preferredZoom);
    }
  }, [cancelWheelRef, fitView, flow, hydrated, isCurrent, mode, preferredZoom]);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || !hydrated || !flow.viewportInitialized) return;
    let size = { width: element.clientWidth, height: element.clientHeight };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!isCurrent()) return;
        const next = { width: element.clientWidth, height: element.clientHeight };
        if (next.width <= 0 || next.height <= 0) return;
        if (next.width === size.width && next.height === size.height) return;
        const previous = size;
        size = next;
        cancelWheelRef.current?.();
        if (normalizeCanvasViewportMode(useAppStore.getState().config.canvasViewportMode) === 'auto') {
          void fitView({ padding: 0.2 });
        } else if (previous.width > 0 && previous.height > 0) {
          const viewport = flow.getViewport();
          // 改变窗口或助手面板宽度时保持画布中心与缩放比例。
          void flow.setViewport({
            x: viewport.x + (next.width - previous.width) / 2,
            y: viewport.y + (next.height - previous.height) / 2,
            zoom: viewport.zoom,
          });
        }
      }, 160);
    });
    observer.observe(element);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [cancelWheelRef, fitView, flow, hydrated, isCurrent, rootRef]);

  useEffect(() => {
    const onStep = (event: Event) => {
      const direction = (event as CustomEvent<{ direction?: number }>).detail?.direction;
      if (direction === 1 || direction === -1) stepZoom(direction);
    };
    window.addEventListener('canvas-zoom-step', onStep);
    window.addEventListener('canvas-toggle-zoom-lock', toggleLock);
    return () => {
      window.removeEventListener('canvas-zoom-step', onStep);
      window.removeEventListener('canvas-toggle-zoom-lock', toggleLock);
    };
  }, [stepZoom, toggleLock]);

  const locked = mode === 'locked';
  const initialFitOptions = useMemo(() => getCanvasFitViewOptions({
    canvasViewportMode: mode, canvasViewportZoom: preferredZoom,
  }, { padding: 0.2 }, true), [mode, preferredZoom]);

  return {
    mode, locked, hydrated, preferredZoom, initialFitOptions,
    minZoom: locked ? preferredZoom : MIN_CANVAS_ZOOM,
    maxZoom: locked ? preferredZoom : MAX_CANVAS_ZOOM,
    fitView, setZoom, stepZoom, toggleLock, autoFit, beginUserMove, endUserMove,
  };
}
