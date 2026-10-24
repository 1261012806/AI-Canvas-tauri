import { useCallback, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../../i18n';
import type { UserPreset } from '../../../types';
import { JsonFileTransferError, readJsonTextFile } from '../../../services/fileService';
import { parsePresetShare } from '../../../services/presetShareService';
import ModalOverlay from '../../shared/ModalOverlay';
import PopupCloseButton from '../../shared/PopupCloseButton';

export default function PresetImportDialog({ onClose, onImport }: {
  onClose: () => void;
  onImport: (preset: UserPreset) => Promise<void>;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => { if (!busyRef.current) onClose(); }, [onClose]);

  const readFile = async (file: File) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      setText(await readJsonTextFile(file));
    } catch (readError) {
      setError(readError instanceof JsonFileTransferError
        ? t(readError.code === 'too-large' ? 'JSON 文件不能超过 8 MiB' : '文件必须使用 UTF-8 编码')
        : t('读取 JSON 文件失败'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!text.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await onImport(parsePresetShare(text));
      onClose();
    } catch (importError) {
      setError(importError instanceof Error ? t(importError.message) : t('导入快捷指令失败'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <ModalOverlay isOpen onClose={close} closeOnBackdrop={!busy} ariaLabel={t('导入快捷指令 JSON')}
      className="ui-dialog-surface w-[min(560px,calc(100vw-32px))] max-h-[calc(100vh-32px)]">
      <header className="ui-card__header shrink-0">
        <div className="min-w-0 flex-1">
          <h3 className="ui-card__title">{t('导入快捷指令 JSON')}</h3>
          <p className="ui-card__desc">{t('粘贴分享内容或选择 JSON 文件，导入后创建新副本。')}</p>
        </div>
        <PopupCloseButton onClick={close} disabled={busy} />
      </header>
      <div className="ui-card__body ui-scroll min-h-0">
        <form id="preset-import-form" className="ui-stack" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="ui-field">
            <span className="ui-label">{t('快捷指令 JSON')}</span>
            <textarea className={'ui-textarea min-h-[180px] font-mono text-xs' + (error ? ' is-invalid' : '')}
              autoFocus rows={9} value={text} disabled={busy} spellCheck={false}
              aria-invalid={!!error} aria-describedby={error ? 'preset-import-error' : undefined}
              placeholder={t('在这里粘贴快捷指令 JSON')}
              onChange={(event) => { setText(event.target.value); setError(''); }} />
          </label>
          <div>
            <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void readFile(file);
              }} />
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy} onClick={() => fileInputRef.current?.click()}>
              <Icon icon="mdi:file-upload-outline" width={16} /> {t('选择 JSON 文件')}
            </button>
          </div>
          <p className="ui-hint">{t('支持 UTF-8 JSON，最大 8 MiB。不会覆盖已有指令，也不会自动执行。')}</p>
          <p className="ui-hint">{t('模型和工作流需要在接收方配置。')}</p>
          {error && <p id="preset-import-error" className="ui-alert ui-alert--danger" role="alert">{error}</p>}
        </form>
      </div>
      <footer className="ui-card__footer shrink-0 justify-end">
        <button type="button" className="ui-btn ui-btn--secondary" disabled={busy} onClick={close}>{t('取消')}</button>
        <button type="submit" form="preset-import-form" className="ui-btn ui-btn--primary" disabled={busy || !text.trim()}>
          {t(busy ? '导入中…' : '导入为新副本')}
        </button>
      </footer>
    </ModalOverlay>
  );
}
