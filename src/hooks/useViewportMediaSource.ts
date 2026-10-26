import { useEffect, useState, type RefObject } from 'react';
import { getPerformanceModeBudget, getPerformanceModeEnabled, subscribePerformanceMode } from '../services/performanceModeRuntime';

interface ObserverPool {
  observer: IntersectionObserver;
  listeners: Map<Element, (isIntersecting: boolean) => void>;
}

const observerPools = new Map<Element | null, Map<string, ObserverPool>>();

function observerUnavailable(): boolean {
  return typeof IntersectionObserver === 'undefined';
}

function findScrollRoot(element: Element): Element | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    // 文档滚动仍以窗口为根，避免把整页高度当成预加载范围。
    if (parent === element.ownerDocument?.scrollingElement
      || parent === element.ownerDocument?.documentElement
      || parent === element.ownerDocument?.body) return null;
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (/(auto|scroll|overlay)/.test(`${overflowX} ${overflowY}`)) return parent;
  }
  return null;
}

function observeNearViewport(
  element: Element,
  rootMargin: string,
  listener: (isIntersecting: boolean) => void,
): () => void {
  // 窗口的 rootMargin 不会扩展内层滚动容器的裁剪区域；按实际滚动容器提前读图。
  const root = findScrollRoot(element);
  let rootPools = observerPools.get(root);
  if (!rootPools) {
    rootPools = new Map();
    observerPools.set(root, rootPools);
  }
  let pool = rootPools.get(rootMargin);
  if (!pool) {
    const listeners = new Map<Element, (isIntersecting: boolean) => void>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
    }, { root, rootMargin });
    pool = { observer, listeners };
    rootPools.set(rootMargin, pool);
  }

  pool.listeners.set(element, listener);
  pool.observer.observe(element);
  return () => {
    pool?.observer.unobserve(element);
    pool?.listeners.delete(element);
    if (pool?.listeners.size === 0) {
      pool.observer.disconnect();
      rootPools?.delete(rootMargin);
      if (rootPools?.size === 0) observerPools.delete(root);
    }
  };
}

export interface ViewportMediaSourceOptions {
  eager?: boolean;
  rootMargin?: string;
  unloadDelayMs?: number;
}

/**
 * 只在元素接近视口时返回真实媒体源，离开后延迟卸载。
 * 图片和视频共用按滚动容器及 rootMargin 分组的观察器，避免长列表逐项创建 observer。
 */
export function useViewportMediaSource<T extends Element>(
  source: string | undefined,
  elementRef: RefObject<T | null>,
  {
    eager = false,
    rootMargin,
    unloadDelayMs,
  }: ViewportMediaSourceOptions = {},
): string | undefined {
  const [observedSource, setObservedSource] = useState<string>();
  const [performanceMode, setPerformanceMode] = useState(getPerformanceModeEnabled);
  const budget = getPerformanceModeBudget(performanceMode);
  const effectiveRootMargin = rootMargin ?? budget.mediaRootMargin;
  const effectiveUnloadDelay = unloadDelayMs ?? budget.mediaUnloadDelayMs;
  const nearViewport = eager || observerUnavailable() || observedSource === source;

  useEffect(() => {
    if (eager || !source || observerUnavailable()) return undefined;

    const element = elementRef.current;
    if (!element) return undefined;

    let unloadTimer: ReturnType<typeof setTimeout> | undefined;
    const stopObserving = observeNearViewport(element, effectiveRootMargin, (isIntersecting) => {
      if (isIntersecting) {
        if (unloadTimer !== undefined) clearTimeout(unloadTimer);
        unloadTimer = undefined;
        setObservedSource(source);
        return;
      }
      if (unloadTimer !== undefined) clearTimeout(unloadTimer);
      unloadTimer = setTimeout(() => {
        setObservedSource(undefined);
        unloadTimer = undefined;
      }, effectiveUnloadDelay);
    });

    return () => {
      stopObserving();
      if (unloadTimer !== undefined) clearTimeout(unloadTimer);
    };
  }, [eager, elementRef, effectiveRootMargin, source, effectiveUnloadDelay]);

  useEffect(() => {
    const refresh = () => setPerformanceMode(getPerformanceModeEnabled());
    const unsubscribe = subscribePerformanceMode(refresh);
    refresh();
    return unsubscribe;
  }, []);

  return nearViewport ? source : undefined;
}
