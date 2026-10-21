import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderMarkdownWithInlineSlots, renderTextWithInlineSlots } from '../../src/utils/renderMarkdown';

describe('renderMarkdown URL sanitization', () => {
  it.each([
    'javascript:alert(1)',
    'java\u0000script:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
  ])('does not create a link for unsafe URL %s', (url) => {
    const html = renderMarkdown(`[打开](${url})`);

    expect(html).toContain('打开');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
  });

  it.each([
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj4=',
    'file:///etc/passwd',
  ])('does not create an image for unsafe URL %s', (url) => {
    const html = renderMarkdown(`![预览](${url})`);

    expect(html).toContain('预览');
    expect(html).not.toContain('<img ');
    expect(html).not.toContain('src=');
  });

  it.each([
    'https://example.com/docs',
    'http://example.com/docs',
    'mailto:user@example.com',
    './docs/guide.md',
    '#section',
  ])('keeps safe link URL %s', (url) => {
    expect(renderMarkdown(`[文档](${url})`)).toContain('<a href=');
  });

  it.each([
    'https://example.com/image.png',
    './images/preview.webp',
    'data:image/png;base64,iVBORw0KGgo=',
  ])('keeps safe image URL %s', (url) => {
    expect(renderMarkdown(`![预览](${url})`)).toContain('<img src=');
  });
});

describe('Markdown inline slots', () => {
  const findRanges = (value: string) => [...value.matchAll(/@\{[^}]+\}/g)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));

  it('protects reference punctuation without flattening headings, emphasis, or table structure', () => {
    const token = '@{hero:角**色**|定稿(参考)}';
    const result = renderMarkdownWithInlineSlots(`# 标题\n\n**正文** ${token}\n\n| 参考 | 内容 |\n| --- | --- |\n| ${token} | 保持原样 |`, findRanges);
    expect(result.tokens).toEqual([token, token]);
    expect(result.html).toContain('<h1>标题</h1>');
    expect(result.html).toContain('<strong>正文</strong>');
    expect(result.html).toContain('<table>');
    expect(result.html.match(/<td /g)).toHaveLength(2);
    expect(result.html).toContain('<span data-markdown-inline-slot="0"></span>');
    expect(result.html).toContain('<span data-markdown-inline-slot="1"></span>');
    expect(result.html).not.toContain('<strong>色</strong>');
  });

  it('leaves code, links, URLs, and original tag attributes literal but still finds body after a fence', () => {
    const source = '```text\n@{code:代码块}\n```\n\n@{body:正文}\n`@{inline:行内代码}`\n'
      + '[@{link:链接文字}](https://example.test/@{url:链接地址})\n'
      + '![图片](https://example.test/@{image:图片地址})\nhttps://example.test/@{plainurl:裸地址}\n'
      + '<span title="@{attribute:属性}">原始标签</span>';
    const result = renderMarkdownWithInlineSlots(source, findRanges);
    expect(result.tokens).toEqual(['@{body:正文}']);
    expect(result.html).toContain('<code>@{inline:行内代码}</code>');
    expect(result.html).toContain('<pre><code class="language-text">@{code:代码块}</code></pre>');
    expect(result.html).toContain('href="https://example.test/@{url:链接地址}"');
    expect(result.html).toContain('&lt;span title=&quot;@{attribute:属性}&quot;&gt;');
  });

  it('cannot forge executable HTML or inline anchors with raw input and NUL markers', () => {
    const source = '\u0000INLINE_SLOT0\u0000<img src=x onerror=alert(1)> @{node:<script>alert(1)</script>}';
    const result = renderMarkdownWithInlineSlots(source, findRanges);
    expect(result.tokens).toEqual(['@{node:<script>alert(1)</script>}']);
    expect(result.html).not.toContain('<img');
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('\u0000');
    expect(result.html.match(/<span data-markdown-inline-slot=/g)).toHaveLength(1);
  });

  it('keeps default Markdown unchanged and plain-text preview preserves its literal format', () => {
    const source = '# 标题\n\n**原文**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
    expect(renderMarkdownWithInlineSlots(source, () => []).html).toBe(renderMarkdown(source));
    const text = renderTextWithInlineSlots('# 原样\n**强调** @{node:参考|图}\n`@{code:示例}`', findRanges);
    expect(text.tokens).toEqual(['@{node:参考|图}']);
    expect(text.html).toContain('# 原样\n**强调**');
    expect(text.html).not.toContain('<h1>');
    expect(text.html).toContain('`@{code:示例}`');
  });

  it.each(['c++', 'language-name'])('does not activate references in %s fences or double-backtick code', (language) => {
    const source = `\`\`\`${language}\n@{code:围栏正文}\n\`\`\`\n@{body:真实正文}\n\`\`保留 \` @{inline:示例}\`\``;
    const result = renderMarkdownWithInlineSlots(source, findRanges);
    expect(result.tokens).toEqual(['@{body:真实正文}']);
    // 本扩展只排除代码内部的胶囊，不改变默认 Markdown 支持的围栏语言范围。
    expect(renderMarkdownWithInlineSlots(source, () => []).html).toBe(renderMarkdown(source));
  });
});

describe('renderMarkdown HTML escaping', () => {
  it('escapes raw HTML even when the input carries NUL bytes', () => {
    const html = renderMarkdown('\u0000 <img src=x onerror=alert(1)>');

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('\u0000');
  });

  it('escapes raw HTML after a forged code-block placeholder', () => {
    const html = renderMarkdown('\u0000CODEBLOCK0\u0000<script>alert(1)</script>');

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('still renders code blocks and inline code', () => {
    const html = renderMarkdown('```ts\nconst a = 1 < 2;\n```\n\n`a && b`');

    expect(html).toContain('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
    expect(html).toContain('<code>a &amp;&amp; b</code>');
  });
});
