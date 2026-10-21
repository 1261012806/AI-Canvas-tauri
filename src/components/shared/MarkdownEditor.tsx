import { useDeferredValue, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '@iconify/react';
import { renderMarkdown } from '../../utils/renderMarkdown';

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  markdown?: boolean;
  initialMode?: 'source' | 'preview' | 'split';
  label?: string;
  readOnly?: boolean;
  onSave?: () => void;
  onBlur?: () => void;
  status?: string;
  /** 仅替换预览面；源码、查找及编辑历史继续使用原始 value。 */
  renderPreview?: (value: string, markdown: boolean) => ReactNode;
}

const FORMAT_TOOLS = [
  { label: '标题', icon: 'lucide:heading-2' },
  { label: '粗体（Ctrl+B）', icon: 'lucide:bold' },
  { label: '斜体（Ctrl+I）', icon: 'lucide:italic' },
  { label: '删除线', icon: 'lucide:strikethrough' },
  { label: '引用', icon: 'lucide:quote' },
  { label: '列表', icon: 'lucide:list' },
  { label: '任务清单', icon: 'lucide:list-checks' },
  { label: '链接（Ctrl+K）', icon: 'lucide:link' },
  { label: '代码块', icon: 'lucide:code' },
  { label: '表格', icon: 'lucide:table' },
];

/** UI Kit 受控编辑器：不读取文件、不访问 Store，保存策略由宿主决定。 */
export default function MarkdownEditor({ value, onChange, markdown = true, initialMode = 'split', label = '文档内容', readOnly = false, onSave, onBlur, status, renderPreview }: MarkdownEditorProps) {
  const [mode, setMode] = useState(initialMode);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState({ values: [value], index: 0 });
  const textarea = useRef<HTMLTextAreaElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const deferred = useDeferredValue(value);
  const html = useMemo(() => markdown && !renderPreview ? renderMarkdown(deferred) : '', [deferred, markdown, renderPreview]);
  // 宿主切换文档或重新载入时，不把旧文档撤销栈带到新内容。
  if (history.values[history.index] !== value) setHistory({ values: [value], index: 0 });

  const change = (next: string) => {
    if (readOnly || next === value) return;
    const values = history.values.slice(0, history.index + 1);
    values.push(next);
    let total = values.reduce((sum, entry) => sum + entry.length, 0);
    while (values.length > 1 && (values.length > 100 || total > 4_000_000)) total -= values.shift()!.length;
    setHistory({ values, index: values.length - 1 });
    onChange(next);
  };
  const undo = (direction: number) => {
    if (readOnly) return;
    const index = history.index + direction;
    if (index < 0 || index >= history.values.length) return;
    setHistory({ ...history, index }); onChange(history.values[index]);
  };
  const select = (start: number, end: number) => {
    setMode((current) => current === 'preview' ? 'source' : current);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(start, end); });
  };
  const insert = (before: string, after = '', fallback = '') => {
    const start = textarea.current?.selectionStart ?? value.length;
    const end = textarea.current?.selectionEnd ?? start;
    const selected = value.slice(start, end) || fallback;
    change(value.slice(0, start) + before + selected + after + value.slice(end));
    select(start + before.length, start + before.length + selected.length);
  };
  const prefixLines = (prefix: string) => {
    const start = value.lastIndexOf('\n', (textarea.current?.selectionStart ?? value.length) - 1) + 1;
    const cursorEnd = textarea.current?.selectionEnd ?? value.length;
    const nextBreak = value.indexOf('\n', cursorEnd);
    const end = nextBreak < 0 ? value.length : nextBreak;
    const block = value.slice(start, end).split('\n').map((line) => prefix + line).join('\n');
    change(value.slice(0, start) + block + value.slice(end)); select(start, start + block.length);
  };
  const find = () => {
    if (!query) return;
    const from = textarea.current?.selectionEnd ?? 0;
    let index = value.indexOf(query, from);
    if (index < 0) index = value.indexOf(query);
    setNotice(index < 0 ? '未找到匹配内容' : '已定位匹配内容');
    if (index >= 0) select(index, index + query.length);
  };
  const replace = (all: boolean) => {
    if (!query) return;
    if (all) {
      const parts = value.split(query);
      change(parts.join(replacement)); setNotice(`已替换 ${parts.length - 1} 处`);
    } else {
      const start = textarea.current?.selectionStart ?? 0;
      const end = textarea.current?.selectionEnd ?? 0;
      if (value.slice(start, end) !== query) { find(); return; }
      change(value.slice(0, start) + replacement + value.slice(end)); select(start, start + replacement.length);
    }
  };
  const openFind = () => { setFindOpen(true); requestAnimationFrame(() => findInput.current?.focus()); };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const key = event.key.toLowerCase();
    if (event.ctrlKey || event.metaKey) {
      if (key === 's' && onSave) { event.preventDefault(); event.stopPropagation(); onSave(); }
      else if (key === 'f') { event.preventDefault(); event.stopPropagation(); openFind(); }
      else if (event.target === textarea.current && (key === 'z' || key === 'y')) {
        event.preventDefault(); event.stopPropagation(); undo(key === 'y' || event.shiftKey ? 1 : -1);
      } else if (markdown && !readOnly && event.target === textarea.current && ['b', 'i', 'k'].includes(key)) {
        event.preventDefault(); event.stopPropagation();
        if (key === 'b') insert('**', '**', '粗体');
        if (key === 'i') insert('*', '*', '斜体');
        if (key === 'k') insert('[', '](https://)', '链接文字');
      }
    } else if (event.key === 'Tab' && !event.shiftKey && event.target === textarea.current && !readOnly) {
      event.preventDefault(); insert('  ');
    }
  };
  const format = (icon: string) => {
    if (icon === 'lucide:heading-2') prefixLines('## ');
    if (icon === 'lucide:bold') insert('**', '**', '粗体');
    if (icon === 'lucide:italic') insert('*', '*', '斜体');
    if (icon === 'lucide:strikethrough') insert('~~', '~~', '文字');
    if (icon === 'lucide:quote') prefixLines('> ');
    if (icon === 'lucide:list') prefixLines('- ');
    if (icon === 'lucide:list-checks') prefixLines('- [ ] ');
    if (icon === 'lucide:link') insert('[', '](https://)', '链接文字');
    if (icon === 'lucide:code') insert('\n```\n', '\n```\n', '代码');
    if (icon === 'lucide:table') insert('\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | 内容 |\n');
  };
  return <div className="ui-markdown-editor nodrag nowheel" onKeyDown={keyDown}>
    <div className="ui-markdown-editor__toolbar" role="toolbar" aria-label="文档编辑工具">
      <div className="flex items-center gap-1" role="group" aria-label="显示方式">
        {(['source', 'preview', ...(markdown ? ['split'] as const : [])] as const).map((item) => <button key={item} type="button"
          className={`ui-btn ui-btn--sm ui-btn--ghost${mode === item ? ' is-active' : ''}`} aria-pressed={mode === item} onClick={() => setMode(item)}>
          {{ source: '编辑', preview: '预览', split: '分栏' }[item]}</button>)}
      </div>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-label="撤销" title="撤销（Ctrl+Z）" disabled={readOnly || history.index === 0} onClick={() => undo(-1)}><Icon icon="lucide:undo-2" /></button>
      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-label="重做" title="重做（Ctrl+Shift+Z）" disabled={readOnly || history.index === history.values.length - 1} onClick={() => undo(1)}><Icon icon="lucide:redo-2" /></button>
      {markdown && FORMAT_TOOLS.map((tool) => <button key={tool.icon} type="button" className="ui-btn ui-btn--sm ui-btn--ghost" disabled={readOnly}
        aria-label={tool.label} title={tool.label} onMouseDown={(event) => event.preventDefault()} onClick={() => format(tool.icon)}><Icon icon={tool.icon} /></button>)}
      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-expanded={findOpen} onClick={() => findOpen ? setFindOpen(false) : openFind()}><Icon icon="lucide:search" />查找替换</button>
      {onSave && <button type="button" className="ui-btn ui-btn--sm ui-btn--primary ml-auto" disabled={readOnly} onClick={onSave}><Icon icon="lucide:save" />保存</button>}
    </div>
    {findOpen && <div className="ui-markdown-editor__toolbar" role="search" aria-label="查找替换">
      <input ref={findInput} className="ui-input ui-input--sm min-w-0 flex-1" aria-label="查找内容" placeholder="查找内容" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); find(); } }} />
      <button type="button" className="ui-btn ui-btn--sm" disabled={!query} onClick={find}>下一个</button>
      {!readOnly && <><input className="ui-input ui-input--sm min-w-0 flex-1" aria-label="替换为" placeholder="替换为" value={replacement} onChange={(event) => setReplacement(event.target.value)} />
        <button type="button" className="ui-btn ui-btn--sm" disabled={!query} onClick={() => replace(false)}>替换</button>
        <button type="button" className="ui-btn ui-btn--sm" disabled={!query} onClick={() => replace(true)}>全部替换</button></>}
      <button type="button" className="ui-btn ui-btn--sm ui-btn--ghost" aria-label="关闭查找" onClick={() => setFindOpen(false)}><Icon icon="lucide:x" /></button>
      {notice && <span role="status" className="text-xs text-canvas-text-secondary">{notice}</span>}
    </div>}
    <div className={`ui-markdown-editor__body${mode === 'split' && markdown ? ' is-split' : ''}`}>
      {mode !== 'preview' && <textarea ref={textarea} className="ui-markdown-editor__source text-selection-source" aria-label={label} value={value} readOnly={readOnly}
        onChange={(event) => change(event.target.value)} onBlur={onBlur} spellCheck={false} placeholder={markdown ? '# 开始写作' : '输入文本…'} />}
      {mode !== 'source' && (renderPreview ? <div className={`ui-markdown-editor__preview${markdown ? ' markdown-rendered' : ''}`} aria-label={markdown ? 'Markdown 预览' : '正文预览'} tabIndex={0}>{renderPreview(deferred, markdown)}</div>
        : markdown ? <div className="ui-markdown-editor__preview markdown-rendered" aria-label="Markdown 预览" tabIndex={0} dangerouslySetInnerHTML={{ __html: html || '<p>暂无内容</p>' }} />
        : <pre className="ui-markdown-editor__preview" tabIndex={0}>{value || '暂无内容'}</pre>)}
    </div>
    <footer className="ui-markdown-editor__status"><span>{value.length.toLocaleString()} 字符 · {value.split('\n').length.toLocaleString()} 行</span><span role="status">{status}</span></footer>
  </div>;
}
