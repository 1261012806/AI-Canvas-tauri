/**
 * 轻量 i18n：以中文原文为 key，缺失翻译自动回落中文。
 * 不依赖 zustand，4 个独立窗口（主窗口 / chat / assets / video-editor）共用同一份运行时状态。
 */
import { useCallback, useSyncExternalStore } from 'react';
import enUS from './locales/en-US/index';
import jaJP from './locales/ja-JP';
import koKR from './locales/ko-KR';

export const LOCALES = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
};

// zh-CN 是源语言，无需字典
const DICTS: Record<Locale, Record<string, string>> = {
  'zh-CN': {},
  'en-US': enUS,
  'ja-JP': jaJP,
  'ko-KR': koKR,
};

/** 把任意 BCP-47 标签归一到受支持的语言；无法识别时回落中文。 */
export function normalizeLocale(tag?: string | null): Locale {
  if (!tag) return 'zh-CN';
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en-US';
  if (lower.startsWith('ja')) return 'ja-JP';
  if (lower.startsWith('ko')) return 'ko-KR';
  return 'zh-CN';
}

/** 未持久化语言时按系统语言判定。 */
export function detectLocale(): Locale {
  return normalizeLocale(typeof navigator === 'undefined' ? null : navigator.language);
}

let currentLocale: Locale = 'zh-CN';
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return currentLocale;
}

/** 应用语言；接受未归一的标签或 undefined（undefined 表示跟随系统）。 */
export function setLocale(tag?: string | null): void {
  const next = tag ? normalizeLocale(tag) : detectLocale();
  if (next === currentLocale) return;
  currentLocale = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  listeners.forEach((notify) => notify());
}

/**
 * 翻译。`text` 直接写中文原文。
 * 占位符用 `{name}`：t('已导入 {count} 个文件', { count: 3 })
 */
export function t(text: string, vars?: Record<string, string | number>): string {
  return translate(currentLocale, text, vars);
}

function translate(locale: Locale, text: string, vars?: Record<string, string | number>): string {
  const translated = DICTS[locale][text] ?? text;
  if (!vars) return translated;
  return translated.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** 组件内用：语言切换时触发重渲染。 */
export function useT(): typeof t {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return useCallback<typeof t>((text, vars) => translate(locale, text, vars), [locale]);
}
