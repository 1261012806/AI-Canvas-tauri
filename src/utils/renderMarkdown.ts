/**
 * 轻量级 Markdown → HTML 渲染器（无外部依赖）
 */
import { COMFY_IMAGE_SOURCE_ATTRIBUTE, isComfyViewUrl } from './comfyMediaUrl';
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type MarkdownUrlKind = 'link' | 'image';

const SAFE_DATA_IMAGE_URL = /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,[a-z0-9+/=]+$/i;

function isSafeMarkdownUrl(url: string, kind: MarkdownUrlKind): boolean {
  // URL parsers ignore ASCII control characters around schemes. Remove them before
  // checking so inputs such as `java\u0000script:` cannot bypass the allowlist.
  const normalized = Array.from(url, (char) => {
    const code = char.charCodeAt(0);
    return code <= 0x20 || code === 0x7f ? '' : char;
  }).join('');
  if (!normalized) return false;

  if (kind === 'image' && SAFE_DATA_IMAGE_URL.test(normalized)) return true;

  const scheme = normalized.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  if (!scheme) return true;

  return kind === 'link'
    ? scheme === 'http' || scheme === 'https' || scheme === 'mailto'
    : scheme === 'http' || scheme === 'https';
}

export interface MarkdownInlineRange { start: number; end: number }

/** 只生成数字槽位，不允许调用方注入 HTML；代码、链接与原始标签内部保留原文。 */
function protectInlineSlots(source: string, findRanges: (value: string) => readonly MarkdownInlineRange[]) {
  const excluded: MarkdownInlineRange[] = [];
  let remaining = source;
  for (const pattern of [
    /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\1|$)/g,
    /(`+)[\s\S]*?\1/g,
    /!?\[[^\]\n]*\]\([^\n]*?\)/g,
    /\b(?:https?:\/\/|mailto:)[^\s<>"']+/gi,
    /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi,
  ]) {
    excluded.push(...[...remaining.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length })));
    // 先屏蔽整段上下文，避免代码围栏的剩余反引号跨正文误匹配成行内代码。
    remaining = remaining.replace(pattern, (match) => ' '.repeat(match.length));
  }
  const tokens: string[] = [];
  let protectedSource = '';
  let cursor = 0;
  for (const range of findRanges(source)) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < cursor || range.end <= range.start || range.end > source.length
      || excluded.some((area) => range.start >= area.start && range.start < area.end)) continue;
    protectedSource += source.slice(cursor, range.start) + `\x00INLINE_SLOT${tokens.length}\x00`;
    tokens.push(source.slice(range.start, range.end));
    cursor = range.end;
  }
  return { source: protectedSource + source.slice(cursor), tokens };
}

function restoreInlineSlots(html: string, tokens: readonly string[]): string {
  tokens.forEach((_, index) => {
    html = html.replace(`\x00INLINE_SLOT${index}\x00`, `<span data-markdown-inline-slot="${index}"></span>`);
  });
  return html;
}

function renderMarkdownContent(md: string, findRanges?: (value: string) => readonly MarkdownInlineRange[]): { html: string; tokens: string[] } {
  if (!md) return { html: '', tokens: [] };

  // ── 0. 剥离输入自带的 NUL ──
  // 下面的占位符用 \x00 作分隔符，第 3 步的转义靠「按 \x00 切分，只转义偶数段」实现。
  // 输入里混进一个 \x00 就会翻转奇偶性，让后面的原始 HTML 整段绕过转义（XSS）。
  // NUL 在 Markdown 里没有任何呈现意义，直接丢掉即可。
  const normalized = md.split('\x00').join('').replace(/\r\n/g, '\n');
  const slots = findRanges ? protectInlineSlots(normalized, findRanges) : { source: normalized, tokens: [] };
  const source = slots.source;

  // ── 1. 提取代码块，用占位符保护 ──
  const codeBlocks: string[] = [];
  let processed = source.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(code.trimEnd())}</code></pre>`
    );
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // ── 2. 提取行内代码 ──
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`]+)`/g, (_: string, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00ICODE${idx}\x00`;
  });

  // ── 3. HTML 转义（保护占位符） ──
  processed = processed
    .split('\x00')
    .map((part, i) => (i % 2 === 0 ? escapeHtml(part) : part))
    .join('\x00');

  // ── 4. 图片 ![alt](url) ──
  processed = processed.replace(
    /!\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g,
    (_: string, alt: string, url: string) => {
      const cleanUrl = url.replace(/\s+"[^"]*"$/, '');
      if (!isSafeMarkdownUrl(cleanUrl, 'image')) return alt;
      const titleMatch = url.match(/\s+"([^"]*)"$/);
      const title = titleMatch ? ` title="${escapeHtml(titleMatch[1])}"` : '';
      const sourceAttribute = isComfyViewUrl(cleanUrl) ? COMFY_IMAGE_SOURCE_ATTRIBUTE : 'src';
      return `<img ${sourceAttribute}="${escapeHtml(cleanUrl)}" alt="${escapeHtml(alt)}"${title} />`;
    }
  );

  // ── 5. 链接 [text](url) ──
  processed = processed.replace(
    /\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g,
    (_: string, text: string, url: string) => {
      const cleanUrl = url.replace(/\s+"[^"]*"$/, '');
      if (!isSafeMarkdownUrl(cleanUrl, 'link')) return text;
      const titleMatch = url.match(/\s+"([^"]*)"$/);
      const title = titleMatch ? ` title="${escapeHtml(titleMatch[1])}"` : '';
      return `<a href="${escapeHtml(cleanUrl)}"${title} rel="noopener">${text}</a>`;
    }
  );

  // ── 6. 粗体 **text** ──
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // ── 7. 斜体 *text*（不匹配 ** 已处理的） ──
  processed = processed.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');

  // ── 8. 删除线 ~~text~~ ──
  processed = processed.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // ── 按行处理块级元素 ──
  const lines = processed.split('\n');
  const result: string[] = [];
  let inList: 'ul' | 'ol' | null = null;
  const tableCells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '')
    .replace(/\\\|/g, '&#124;').split('|').map((cell) => cell.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 代码块保持块级结构，不放进段落中。
    const codeBlock = line.trim();
    if (codeBlock.startsWith('\x00CODEBLOCK') && codeBlock.endsWith('\x00') && /^\d+$/.test(codeBlock.slice(10, -1))) {
      if (inList) { result.push(`</${inList}>`); inList = null; }
      result.push(line);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length) {
      const headers = tableCells(line);
      const separators = tableCells(lines[i + 1]);
      if (headers.length === separators.length && separators.every((cell) => /^:?-{3,}:?$/.test(cell))) {
        if (inList) { result.push(`</${inList}>`); inList = null; }
        const classes = separators.map((cell) => cell.endsWith(':') ? cell.startsWith(':') ? 'md-align-center' : 'md-align-right' : 'md-align-left');
        result.push(`<table><thead><tr>${headers.map((cell, col) => `<th class="${classes[col]}">${cell}</th>`).join('')}</tr></thead><tbody>`);
        i++;
        while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) {
          const cells = tableCells(lines[++i]);
          result.push(`<tr>${headers.map((_, col) => `<td class="${classes[col]}">${cells[col] ?? ''}</td>`).join('')}</tr>`);
        }
        result.push('</tbody></table>');
        continue;
      }
    }

    // ── 9. 标题 #-###### ──
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (inList) { result.push(`</${inList}>`); inList = null; }
      const level = headingMatch[1].length;
      result.push(`<h${level}>${headingMatch[2]}</h${level}>`);
      continue;
    }

    // ── 10. 水平线 --- / *** ──
    if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim())) {
      if (inList) { result.push(`</${inList}>`); inList = null; }
      result.push('<hr />');
      continue;
    }

    // ── 11. 无序列表 - item ──
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (inList !== 'ul') {
        if (inList) result.push(`</${inList}>`);
        result.push('<ul>');
        inList = 'ul';
      }
      const task = ulMatch[2].match(/^\[([ xX])\]\s+(.*)$/);
      result.push(task ? `<li class="md-task"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''} aria-label="任务状态" /> ${task[2]}</li>` : `<li>${ulMatch[2]}</li>`);
      continue;
    }

    // ── 12. 有序列表 1. item ──
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      if (inList !== 'ol') {
        if (inList) result.push(`</${inList}>`);
        result.push('<ol>');
        inList = 'ol';
      }
      result.push(`<li>${olMatch[2]}</li>`);
      continue;
    }

    // 非列表项：关闭列表
    if (inList) { result.push(`</${inList}>`); inList = null; }

    // ── 13. 引用 > text ──
    const bqMatch = line.match(/^&gt;\s?(.*)$/);
    if (bqMatch) {
      result.push(`<blockquote>${bqMatch[1] || '&nbsp;'}</blockquote>`);
      continue;
    }

    // ── 14. 空行 → 段落分隔 ──
    if (line.trim() === '') {
      result.push('');
      continue;
    }

    // ── 15. 普通段落 ──
    result.push(`<p>${line}</p>`);
  }

  if (inList) { result.push(`</${inList}>`); }

  // ── 恢复占位符 ──
  let html = result.join('\n');
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
  }
  for (let i = 0; i < inlineCodes.length; i++) {
    html = html.replace(`\x00ICODE${i}\x00`, inlineCodes[i]);
  }

  return { html: restoreInlineSlots(html, slots.tokens), tokens: slots.tokens };
}

export function renderMarkdown(md: string): string {
  return renderMarkdownContent(md).html;
}

/** 预览宿主把数字槽位挂载为真实控件；默认 Markdown 渲染不受影响。 */
export function renderMarkdownWithInlineSlots(md: string, findRanges: (value: string) => readonly MarkdownInlineRange[]) {
  return renderMarkdownContent(md, findRanges);
}

/** 纯文本保持原始标点与换行，代码、URL 和标签属性沿用相同的槽位排除规则。 */
export function renderTextWithInlineSlots(text: string, findRanges: (value: string) => readonly MarkdownInlineRange[]) {
  const slots = protectInlineSlots(text.split('\x00').join('').replace(/\r\n/g, '\n'), findRanges);
  return { html: restoreInlineSlots(escapeHtml(slots.source), slots.tokens), tokens: slots.tokens };
}
