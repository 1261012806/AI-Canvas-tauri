/**
 * 弹窗和浮层共用的图标关闭按钮，统一尺寸、标签和按钮属性透传。
 * 基于 UI Kit .ui-close-btn 设计规范（触感缩放 + 危险色悬浮）。
 */
import type { ButtonHTMLAttributes, CSSProperties } from 'react';
import { useT } from '../../i18n';

interface PopupCloseButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  ariaLabel?: string;
  /** 悬浮时放大比例，默认 1.04 */
  scale?: number;
  /** 按下时缩小比例，默认 0.96 */
  tapScale?: number;
}

export default function PopupCloseButton({
  ariaLabel,
  className = '',
  type = 'button',
  scale = 1.04,
  tapScale = 0.96,
  style,
  ...props
}: PopupCloseButtonProps) {
  const t = useT();
  return (
    <button
      {...props}
      type={type}
      aria-label={ariaLabel ?? t('关闭')}
      className={`ui-close-btn anim-btn chat-panel-close-btn ${className}`.trim()}
      style={{
        '--anim-hover-scale': scale,
        '--anim-tap-scale': tapScale,
        ...style,
      } as CSSProperties}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        width="18"
        height="18"
        aria-hidden="true"
      >
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  );
}
