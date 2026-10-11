import type { FitViewOptions } from '@xyflow/react';
import type { AppConfig, CanvasViewportMode } from '../types';

export const MIN_CANVAS_ZOOM = 0.1;
export const MAX_CANVAS_ZOOM = 5;
export const CANVAS_ZOOM_PRESETS = [10, 25, 35, 50, 75, 100, 150, 200, 300, 500];

export function normalizeCanvasViewportMode(mode: unknown): CanvasViewportMode {
  return mode === 'manual' || mode === 'locked' ? mode : 'auto';
}

export function normalizeCanvasZoom(zoom: unknown): number {
  return typeof zoom === 'number' && Number.isFinite(zoom)
    ? Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, zoom))
    : 1;
}

export function getCanvasLockedZoom(config: Pick<AppConfig, 'canvasViewportMode' | 'canvasViewportZoom'>): number | null {
  return normalizeCanvasViewportMode(config.canvasViewportMode) === 'locked'
    ? normalizeCanvasZoom(config.canvasViewportZoom) : null;
}

/** 所有定位入口都尊重锁定；项目首次显示还要恢复手动比例。 */
export function getCanvasFitViewOptions(
  config: Pick<AppConfig, 'canvasViewportMode' | 'canvasViewportZoom'>,
  options: FitViewOptions = {},
  restorePreference = false,
): FitViewOptions {
  const mode = normalizeCanvasViewportMode(config.canvasViewportMode);
  if (mode === 'locked' || (restorePreference && mode === 'manual')) {
    const zoom = normalizeCanvasZoom(config.canvasViewportZoom);
    // smooth 镜头平移会在途中缩放，即使首尾比例一致；锁定时必须线性插值。
    return { ...options, minZoom: zoom, maxZoom: zoom, interpolate: 'linear' };
  }
  return { minZoom: MIN_CANVAS_ZOOM, maxZoom: 1, ...options };
}
