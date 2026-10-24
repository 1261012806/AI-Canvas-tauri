/**
 * noteNodes/CanvasNoteText — 画布笔记的文本渲染与编辑层。
 * 支持双击进入行内编辑、字体族 / 字号 / 对齐样式的实时渲染，
 * 提交文本通过 onCommit 回写到笔记数据。
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { CanvasNoteData } from '../../types';

interface CanvasNoteTextProps {
  nodeId: string;
  note: CanvasNoteData;
  onCommit: (text: string) => void;
}

const FONT_FAMILIES = {
  hand: '"Segoe Print", "Bradley Hand", cursive',
  sans: '"Trebuchet MS", sans-serif',
  mono: '"Cascadia Code", "Consolas", monospace',
  serif: '"Georgia", serif',
} as const;

function CanvasNoteText({ nodeId, note, onCommit }: CanvasNoteTextProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const beginEditing = useCallback(() => {
    setDraft(note.text ?? '');
    setEditing(true);
  }, [note.text]);

  useEffect(() => {
    const handleEditRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId?: string }>).detail;
      if (detail?.nodeId === nodeId) beginEditing();
    };
    window.addEventListener('canvas-note-edit-text', handleEditRequest);
    return () => window.removeEventListener('canvas-note-edit-text', handleEditRequest);
  }, [beginEditing, nodeId]);
  useEffect(() => {
    if (!editing) return;
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [editing]);

  const finish = useCallback(() => {
    setEditing(false);
    if (draft !== (note.text ?? '')) onCommit(draft);
  }, [draft, note.text, onCommit]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(note.text ?? '');
      setEditing(false);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      finish();
    }
  }, [finish, note.text]);

  const style = {
    color: note.style.strokeColor,
    fontFamily: FONT_FAMILIES[note.style.fontFamily],
    fontSize: `${note.style.fontSize}px`,
    textAlign: note.style.textAlign,
  } satisfies CSSProperties;

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        className="canvas-note-textarea nodrag nopan nowheel"
        value={draft}
        style={style}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={finish}
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
        aria-label={t('编辑画布笔记文本')}
        spellCheck={false}
      />
    );
  }

  return (
    <div
      className="canvas-note-text"
      style={style}
      onDoubleClick={(event) => {
        event.stopPropagation();
        beginEditing();
      }}
      title={t('双击编辑文本')}
    >
      {note.text || t('双击输入文本')}
    </div>
  );
}

export default memo(CanvasNoteText);
