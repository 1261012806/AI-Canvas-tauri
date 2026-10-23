import type { AppearanceTheme, AppearanceMode, AppearanceButtonColors, AppearanceBackgroundImage, AppearanceCanvasPanels, AppearancePanelBackground } from '../../types';
import { isEmbeddedThemeImage, isThemeImageReference } from '../fs/themeAssets';

export const APPEARANCE_CANVAS_PANEL_IDS = ['projectBar', 'sidebar', 'drawingToolbar', 'viewportToolbar'] as const;

const CANVAS_IMAGE_DEFAULTS = {
  imageBlur: 0,
  imageBrightness: 1,
  imageContrast: 1,
  imageSaturation: 1,
  imageOverlayColor: '#000000',
  imageOverlayOpacity: 0,
} as const;

const BUTTON_UI = {
  radius: 7,
  borderWidth: 1,
  normal: { background: 'auto', hoverBackground: 'auto', text: 'auto', border: 'auto' },
  primary: { background: 'auto', hoverBackground: 'auto', text: 'auto', border: 'auto' },
} as const;

const DARK_UI = {
  background: '#0a0a0f',
  surface: '#14141c',
  card: '#1a1a26',
  hover: '#252535',
  border: '#2a2a3a',
  text: '#dddde4',
  textSecondary: '#8888a0',
  textMuted: '#7d7d91',
  accent: '#6366f1',
  accentStrong: '#818cf8',
  accentSoft: '#a5b4fc',
  focus: '#6366f1',
  success: '#22c55e',
  warning: '#f97316',
  danger: '#ef4444',
  info: '#3b82f6',
  radius: 8,
  shadowOpacity: 0.42,
  glassOpacity: 0.77,
  glassBlur: 16,
  scrollbar: '#3a3a50',
  scrollbarHover: '#555570',
  button: BUTTON_UI,
} as const;

const LIGHT_UI = {
  background: '#F4F6FB',
  surface: '#FFFFFF',
  card: '#F8FAFD',
  hover: '#EEF1F8',
  border: '#E4E8F2',
  text: '#33364D',
  textSecondary: '#6E7488',
  textMuted: '#767D92',
  accent: '#7280E4',
  accentStrong: '#5A69D4',
  accentSoft: '#4F5ECB',
  focus: '#7280E4',
  success: '#23937A',
  warning: '#C06E33',
  danger: '#CE4F62',
  info: '#3B7EC4',
  radius: 8,
  shadowOpacity: 0.18,
  glassOpacity: 0.7,
  glassBlur: 16,
  scrollbar: '#b3bdce',
  scrollbarHover: '#8996aa',
  button: BUTTON_UI,
} as const;

function completeTheme(
  id: string,
  name: string,
  mode: AppearanceMode,
  ui: typeof DARK_UI | typeof LIGHT_UI,
  canvas: AppearanceTheme['canvas'],
): AppearanceTheme {
  const now = 0;
  return {
    schemaVersion: 1,
    id,
    name,
    builtin: true,
    mode,
    ui: { ...ui, canvasPanels: { overrides: {} }, button: { ...ui.button, normal: { ...ui.button.normal }, primary: { ...ui.button.primary } } },
    canvas,
    // These values intentionally match the pre-appearance baseline node defaults.
    node: {
      background: ui.surface,
      backgroundOpacity: 0.94,
      border: ui.border,
      borderWidth: 0,
      radius: 12,
      shadow: `0 12px 32px color-mix(in srgb, #000 42%, transparent)`,
      headerBackground: ui.card,
      selectedBorder: ui.accent,
      selectedGlow: `color-mix(in srgb, ${ui.accent} 20%, transparent)`,
      text: ui.text,
      handleColor: ui.accent,
    },
    edge: {
      color: mode === 'light' ? '#B1B1B7' : '#33334a',
      width: 1.5,
      selectedColor: ui.accent,
      selectedWidth: 2.5,
      flowColor: mode === 'light' ? '#5A69D4' : '#818cf8',
      previewColor: ui.accent,
      animationEnabled: true,
    },
    handle: {
      kind: 'color',
      color: ui.accent,
      hoverColor: ui.accentStrong,
      size: 40,
      imageFit: 'contain',
      opacity: 1,
    },
    motion: { enabled: true, scale: 1 },
    createdAt: now,
    updatedAt: now,
  };
}

export function createBuiltinAppearanceThemes(): AppearanceTheme[] {
  return [
    completeTheme('standard-dark', '深色', 'dark', DARK_UI, {
      ...CANVAS_IMAGE_DEFAULTS,
      kind: 'color', color: '#0a0a0f', imageFit: 'cover', imagePosition: 'center',
      imageOpacity: 1, gridVisible: true, gridColor: '#585868', gridSize: 8,
    }),
    completeTheme('standard-light', '浅色', 'light', LIGHT_UI, {
      ...CANVAS_IMAGE_DEFAULTS,
      kind: 'color', color: '#F4F6FB', imageFit: 'cover', imagePosition: 'center',
      imageOpacity: 1, gridVisible: true, gridColor: '#B1B1B7', gridSize: 8,
    }),
    completeTheme('solar-system', '太阳系', 'dark', DARK_UI, {
      ...CANVAS_IMAGE_DEFAULTS,
      kind: 'solar-system', color: '#000000', imageFit: 'cover', imagePosition: 'center',
      imageOpacity: 1, gridVisible: true, gridColor: '#3a3a50', gridSize: 8,
    }),
    completeTheme('frosted-warm-light', '磨砂暖光', 'light', LIGHT_UI, {
      ...CANVAS_IMAGE_DEFAULTS,
      kind: 'frosted-glass', color: '#d9dad9', imageFit: 'cover', imagePosition: 'center',
      imageOpacity: 1, gridVisible: true, gridColor: '#a9aaa8', gridSize: 8,
    }),
  ];
}

export function cloneAppearanceTheme(theme: AppearanceTheme, id: string, name: string): AppearanceTheme {
  const now = Date.now();
  return {
    ...structuredClone(theme),
    id,
    name,
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeAppearanceBackgroundImage(input: unknown): AppearanceBackgroundImage | undefined {
  if (!isRecord(input)) return undefined;
  // 仅接受固定主题目录的相对引用或旧内嵌图片；不接受绝对路径、外部 URL 或 CSS 片段。
  const imageDataUrl = isThemeImageReference(input.imageDataUrl) || isEmbeddedThemeImage(input.imageDataUrl)
    ? input.imageDataUrl : undefined;
  return {
    kind: input.kind === 'image' ? 'image' : 'color',
    imageDataUrl,
    imageFit: input.imageFit === 'contain' || input.imageFit === 'fill' ? input.imageFit : 'cover',
  };
}

function normalizeButtonColors(input: unknown): AppearanceButtonColors {
  const source = isRecord(input) ? input : {};
  const color = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : 'auto';
  return {
    background: color(source.background),
    hoverBackground: color(source.hoverBackground),
    backgroundImage: normalizeAppearanceBackgroundImage(source.backgroundImage),
    hoverBackgroundImage: normalizeAppearanceBackgroundImage(source.hoverBackgroundImage),
    text: color(source.text),
    border: color(source.border),
  };
}

function normalizeCanvasPanels(input: unknown, fallback: string): AppearanceCanvasPanels {
  const source = isRecord(input) ? input : {};
  const normalizeBackground = (value: unknown): AppearancePanelBackground | undefined => {
    if (!isRecord(value)) return undefined;
    const color = typeof value.background === 'string' ? value.background.trim() : '';
    return {
      // 保留输入中的十六进制片段，让共用颜色输入框可以逐字编辑；不接受 URL 或 CSS 片段。
      background: /^(?:#|#?[\da-f]{1,8}|transparent|(?:rgb|hsl)a?\([\d\s.,%/+-]+\))$/i.test(color) ? color : fallback,
      backgroundImage: normalizeAppearanceBackgroundImage(value.backgroundImage),
      opacity: typeof value.opacity === 'number' && Number.isFinite(value.opacity)
        ? Math.max(0, Math.min(1, value.opacity)) : undefined,
      blur: typeof value.blur === 'number' && Number.isFinite(value.blur)
        ? Math.max(0, Math.min(48, value.blur)) : undefined,
    };
  };
  const overrides: AppearanceCanvasPanels['overrides'] = {};
  const rawOverrides = isRecord(source.overrides) ? source.overrides : {};
  for (const id of APPEARANCE_CANVAS_PANEL_IDS) {
    const background = normalizeBackground(rawOverrides[id]);
    if (background) overrides[id] = background;
  }
  return { shared: normalizeBackground(source.shared), overrides };
}

/**
 * 补齐旧版或外部导入的半成品快照。持久化数据是不可信输入，运行时不能只依赖 TS 类型。
 */
export function normalizeAppearanceTheme(input: unknown): AppearanceTheme {
  const source = isRecord(input) ? input : {};
  const mode = source.mode === 'light' || source.mode === 'system' ? source.mode : 'dark';
  const requestedId = typeof source.id === 'string' ? source.id : '';
  const base = getBuiltinAppearanceTheme(requestedId, mode === 'light' ? 'light' : 'dark');
  const ui = isRecord(source.ui) ? source.ui : {};
  const button = isRecord(ui.button) ? ui.button : {};
  const canvas = isRecord(source.canvas) ? source.canvas : {};
  const node = isRecord(source.node) ? source.node : {};
  const edge = isRecord(source.edge) ? source.edge : {};
  const handle = isRecord(source.handle) ? source.handle : {};
  const motion = isRecord(source.motion) ? source.motion : {};
  const canvasImage = Object.hasOwn(canvas, 'imageDataUrl') ? canvas.imageDataUrl : base.canvas.imageDataUrl;
  const handleImage = Object.hasOwn(handle, 'imageDataUrl') ? handle.imageDataUrl : base.handle.imageDataUrl;
  const canvasNumber = (key: 'imageOpacity' | 'imageBlur' | 'imageBrightness' | 'imageContrast' | 'imageSaturation' | 'imageOverlayOpacity', max: number) => {
    const value = canvas[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.min(max, value)) : base.canvas[key];
  };
  const overlayColor = typeof canvas.imageOverlayColor === 'string' ? canvas.imageOverlayColor.trim() : '';
  return {
    ...base,
    ...source,
    schemaVersion: 1,
    id: requestedId || base.id,
    name: typeof source.name === 'string' && source.name.trim() ? source.name : base.name,
    builtin: typeof source.builtin === 'boolean' ? source.builtin : base.builtin,
    mode,
    ui: {
      ...base.ui,
      ...ui,
      surfaceImage: normalizeAppearanceBackgroundImage(ui.surfaceImage),
      glassOpacity: typeof ui.glassOpacity === 'number' && Number.isFinite(ui.glassOpacity)
        ? Math.max(0, Math.min(1, ui.glassOpacity)) : base.ui.glassOpacity,
      glassBlur: typeof ui.glassBlur === 'number' && Number.isFinite(ui.glassBlur)
        ? Math.max(0, Math.min(48, ui.glassBlur)) : base.ui.glassBlur,
      canvasPanels: normalizeCanvasPanels(ui.canvasPanels, base.ui.surface),
      button: {
        radius: typeof button.radius === 'number' && Number.isFinite(button.radius)
          ? Math.max(0, Math.min(24, button.radius)) : BUTTON_UI.radius,
        borderWidth: typeof button.borderWidth === 'number' && Number.isFinite(button.borderWidth)
          ? Math.max(0, Math.min(3, button.borderWidth)) : BUTTON_UI.borderWidth,
        normal: normalizeButtonColors(button.normal),
        primary: normalizeButtonColors(button.primary),
      },
    },
    canvas: {
      ...base.canvas,
      ...canvas,
      imageDataUrl: isEmbeddedThemeImage(canvasImage) || isThemeImageReference(canvasImage) ? canvasImage : undefined,
      imageOpacity: canvasNumber('imageOpacity', 1),
      imageBlur: canvasNumber('imageBlur', 40),
      imageBrightness: canvasNumber('imageBrightness', 2),
      imageContrast: canvasNumber('imageContrast', 2),
      imageSaturation: canvasNumber('imageSaturation', 2),
      // 与共用颜色输入框一致，允许逐字编辑；拒绝 URL 和其他 CSS 片段。
      imageOverlayColor: /^(?:#|#?[\da-f]{1,8}|transparent|(?:rgb|hsl)a?\([\d\s.,%/+-]+\))$/i.test(overlayColor)
        ? overlayColor : base.canvas.imageOverlayColor,
      imageOverlayOpacity: canvasNumber('imageOverlayOpacity', 1),
    },
    node: { ...base.node, ...node, backgroundImage: normalizeAppearanceBackgroundImage(node.backgroundImage) },
    edge: { ...base.edge, ...edge },
    handle: {
      ...base.handle,
      ...handle,
      imageDataUrl: isEmbeddedThemeImage(handleImage) || isThemeImageReference(handleImage) ? handleImage : undefined,
      kind: handle.kind === 'image' || handle.kind === 'color'
        ? handle.kind
        : typeof handle.imageDataUrl === 'string' && handle.imageDataUrl.length > 0 ? 'image' : base.handle.kind,
    },
    motion: { ...base.motion, ...motion },
    createdAt: typeof source.createdAt === 'number' ? source.createdAt : base.createdAt,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : base.updatedAt,
  } as AppearanceTheme;
}

export function getBuiltinAppearanceTheme(id: string, mode: 'dark' | 'light' = 'dark'): AppearanceTheme {
  return createBuiltinAppearanceThemes().find((theme) => theme.id === id)
    ?? createBuiltinAppearanceThemes().find((theme) => theme.id === `standard-${mode}`)!;
}
