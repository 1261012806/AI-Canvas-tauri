import { useRef, type InputHTMLAttributes } from 'react';
import { Icon } from '@iconify/react';
import { useT } from '../../i18n';

interface FileUploadButtonProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'children'> {
  label?: string;
  fileName?: string;
  placeholder?: string;
}

/** 按钮式文件选择；调用方处理文件并提供当前名称，不负责上传或持久化。 */
export default function FileUploadButton({ label: customLabel, fileName = '', placeholder: customPlaceholder, className = '', disabled, onChange, ...inputProps }: FileUploadButtonProps) {
  const t = useT();
  const label = customLabel ?? t('选择文件');
  const placeholder = customPlaceholder ?? t('未选择文件');
  const inputRef = useRef<HTMLInputElement | null>(null);
  return <div className={`ui-file-upload ${className}`}>
    <input {...inputProps} ref={inputRef} type="file" hidden disabled={disabled} onChange={(event) => {
      // 回调先取得 File，随后清空原生值，允许再次选择同一个文件。
      try { onChange?.(event); } finally { event.currentTarget.value = ''; }
    }} />
    <button type="button" className="ui-btn ui-file-upload__button" disabled={disabled}
      aria-label={inputProps['aria-label'] ?? label} onClick={() => inputRef.current?.click()}>
      <Icon icon="lucide:upload" aria-hidden="true" />{label}
    </button>
    <span className={`ui-file-upload__name${fileName ? ' is-selected' : ''}`} title={fileName || undefined} aria-live="polite">
      {fileName || placeholder}
    </span>
  </div>;
}
