/** Readable placeholder capsules backed by the existing plain-text template format. */
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useT } from '../../../i18n';
import {
  MentionEditorHistory,
  captureMentionEditorSelection,
  captureMentionEditorSnapshot,
  restoreMentionEditorSnapshot,
} from './mentionEditorHistory';
import {
  createPresetTemplateFragment,
  deleteAdjacentPresetTemplateChip,
  getPresetTemplateRange,
  normalizePresetTemplateChips,
  refreshPresetTemplateLabels,
  selectPresetTemplateRange,
  serializePresetTemplateDom,
  type PresetTemplateVariable,
} from './presetTemplateEditorDom';

export interface PresetTemplateEditorHandle {
  insertVariable: (key: string) => void;
}

interface PresetTemplateEditorProps {
  value: string;
  variables: PresetTemplateVariable[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
}

const PresetTemplateEditor = forwardRef<PresetTemplateEditorHandle, PresetTemplateEditorProps>(function PresetTemplateEditor({
  value,
  variables,
  onChange,
  ariaLabel,
  placeholder,
  disabled = false,
}, ref) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<Range | null>(null);
  const composingRef = useRef(false);
  const historyRef = useRef(new MentionEditorHistory());
  const [compositionRevision, setCompositionRevision] = useState(0);
  const unknownLabel = t('未定义内容');

  const rememberSelection = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const selection = root.ownerDocument.getSelection();
    if (selection?.rangeCount && root.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      rangeRef.current = selection.getRangeAt(0).cloneRange();
      historyRef.current.updateSelection(captureMentionEditorSelection(root));
    }
  }, []);

  const emit = useCallback((group: string | null = null) => {
    const root = rootRef.current;
    if (!root || composingRef.current) return;
    normalizePresetTemplateChips(root, variables, unknownLabel);
    const prompt = serializePresetTemplateDom(root);
    historyRef.current.record(captureMentionEditorSnapshot(root, prompt), group);
    rememberSelection();
    onChange(prompt);
  }, [onChange, rememberSelection, variables, unknownLabel]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || composingRef.current) return;
    if (serializePresetTemplateDom(root) !== value) {
      root.replaceChildren(createPresetTemplateFragment(root.ownerDocument, value, variables, unknownLabel));
      rangeRef.current = null;
      // External key changes must not undo back into a now-invalid placeholder.
      historyRef.current.reset(captureMentionEditorSnapshot(root, value));
    } else {
      const labelsChanged = refreshPresetTemplateLabels(root, variables, unknownLabel);
      if (!historyRef.current.current || historyRef.current.current.prompt !== value) {
        historyRef.current.reset(captureMentionEditorSnapshot(root, value));
      } else if (labelsChanged) {
        historyRef.current.refresh(captureMentionEditorSnapshot(root, value));
      }
    }
  }, [value, variables, unknownLabel, compositionRevision]);

  const insertText = useCallback((text: string) => {
    const root = rootRef.current;
    if (!root || disabled || composingRef.current || !text) return;
    historyRef.current.updateSelection(captureMentionEditorSelection(root));
    historyRef.current.endGroup();
    if (!serializePresetTemplateDom(root)) {
      root.replaceChildren();
      rangeRef.current = null;
    }
    const range = getPresetTemplateRange(root, rangeRef.current);
    range.deleteContents();
    const fragment = createPresetTemplateFragment(root.ownerDocument, text, variables, unknownLabel);
    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) range.setStartAfter(last);
    range.collapse(true);
    root.focus({ preventScroll: true });
    selectPresetTemplateRange(root, range);
    emit();
  }, [disabled, variables, unknownLabel, emit]);

  useImperativeHandle(ref, () => ({
    insertVariable(key) {
      if (variables.some((variable) => variable.key === key)) insertText('{{' + key + '}}');
    },
  }), [variables, insertText]);

  const restoreHistory = useCallback((redo: boolean) => {
    const root = rootRef.current;
    if (!root || disabled || composingRef.current) return;
    const snapshot = redo ? historyRef.current.redo() : historyRef.current.undo();
    if (!snapshot) return;
    restoreMentionEditorSnapshot(root, snapshot);
    refreshPresetTemplateLabels(root, variables, unknownLabel);
    historyRef.current.refresh(captureMentionEditorSnapshot(root, snapshot.prompt));
    rememberSelection();
    onChange(snapshot.prompt);
  }, [disabled, variables, unknownLabel, rememberSelection, onChange]);

  const handleInput = (event: FormEvent<HTMLDivElement>) => {
    const input = event.nativeEvent as InputEvent;
    if (composingRef.current || input.isComposing) return;
    emit(['insertText', 'deleteContentBackward', 'deleteContentForward'].includes(input.inputType) ? input.inputType : null);
  };

  const copy = (event: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const root = rootRef.current;
    if (!root || (cut && disabled) || composingRef.current) return;
    const range = getPresetTemplateRange(root);
    if (range.collapsed) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', serializePresetTemplateDom(range.cloneContents()));
    if (cut) {
      historyRef.current.updateSelection(captureMentionEditorSelection(root));
      range.deleteContents();
      range.collapse(true);
      selectPresetTemplateRange(root, range);
      emit();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || composingRef.current || event.nativeEvent.isComposing) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && !event.altKey && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
      event.preventDefault();
      event.stopPropagation();
      restoreHistory(event.key.toLowerCase() === 'y' || event.shiftKey);
      return;
    }
    if (event.key === 'Enter' && !command && !event.altKey) {
      event.preventDefault();
      insertText('\n');
      return;
    }
    const root = rootRef.current;
    if (root && !command && !event.altKey && (event.key === 'Backspace' || event.key === 'Delete')) {
      historyRef.current.updateSelection(captureMentionEditorSelection(root));
      const range = getPresetTemplateRange(root);
      if (!range.collapsed) {
        event.preventDefault();
        range.deleteContents();
        range.collapse(true);
        selectPresetTemplateRange(root, range);
        emit();
      } else if (deleteAdjacentPresetTemplateChip(root, event.key === 'Backspace')) {
        event.preventDefault();
        emit();
      }
    }
  };

  return (
    <div className="relative min-w-0">
      <div
        ref={rootRef}
        className="preset-manager-input preset-advanced-step-template whitespace-pre-wrap break-words overflow-y-auto"
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        aria-disabled={disabled || undefined}
        spellCheck={false}
        onInput={handleInput}
        onBeforeInput={(event) => {
          const input = event.nativeEvent as InputEvent;
          if (input.inputType !== 'historyUndo' && input.inputType !== 'historyRedo') return;
          event.preventDefault();
          restoreHistory(input.inputType === 'historyRedo');
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={rememberSelection}
        onMouseUp={rememberSelection}
        onFocus={rememberSelection}
        onBlur={() => {
          const wasComposing = composingRef.current;
          composingRef.current = false;
          emit();
          historyRef.current.endGroup();
          if (wasComposing) setCompositionRevision((revision) => revision + 1);
        }}
        onCompositionStart={() => {
          rememberSelection();
          historyRef.current.endGroup();
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          emit();
          setCompositionRevision((revision) => revision + 1);
        }}
        onCopy={(event) => copy(event, false)}
        onCut={(event) => copy(event, true)}
        onPaste={(event) => {
          event.preventDefault();
          insertText(event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
        }}
        onDragStart={(event) => event.preventDefault()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          insertText(event.dataTransfer.getData('text/plain').replace(/\r\n?/g, '\n'));
        }}
      />
      {!value && placeholder ? (
        <div className="pointer-events-none absolute inset-x-3 top-2 text-canvas-text-muted text-[13px]" aria-hidden="true">{placeholder}</div>
      ) : null}
    </div>
  );
});

export default PresetTemplateEditor;
