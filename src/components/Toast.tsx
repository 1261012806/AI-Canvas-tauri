/**
 * Toast 全局消息提示 — 顶部居中弹出式通知，支持成功、信息和错误状态，自动消失
 */
import { useCallback, useState } from 'react';
import { Icon } from '@iconify/react';
import { AnimatePresence, motion } from 'framer-motion';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import { copyText } from '../services/clipboardService';
import PopupCloseButton from './shared/PopupCloseButton';
import { springSmooth, fadeFast } from '../utils/motion';
import { useT } from '../i18n';

export default function Toast() {
  const t = useT();
  const { toast, dismissToast } = useAppStore(
    useShallow((s) => ({ toast: s.toast, dismissToast: s.dismissToast })),
  );
  // 记住被复制的是哪条消息，换消息后对勾自然失效，不用额外重置
  const [copiedMessage, setCopiedMessage] = useState('');
  const message = t(toast.message);
  const copied = copiedMessage !== '' && copiedMessage === message;

  const handleCopy = useCallback(async () => {
    if (await copyText(message)) setCopiedMessage(message);
  }, [message]);

  return createPortal(
    <AnimatePresence>
      {toast.visible && (
        <motion.div
          className="fixed top-16 left-1/2 z-[300]"
          style={{ x: '-50%' }}
          initial={{ opacity: 0, y: -10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98, transition: fadeFast }}
          transition={springSmooth}
        >
          <div
            role={toast.type === 'error' ? 'alert' : 'status'}
            aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
            aria-atomic="true"
            className={`app-toast is-${toast.type} flex w-max max-w-[calc(100vw-2rem)] items-center gap-2
                        rounded-lg border py-1.5 pl-2 pr-1.5`}
          >
            <motion.span
              className="app-toast-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
              initial={{ scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ ...springSmooth, delay: 0.03 }}
              aria-hidden="true"
            >
              <Icon
                icon={toast.type === 'success'
                  ? 'lucide:check'
                  : toast.type === 'info'
                    ? 'lucide:info'
                    : 'lucide:triangle-alert'}
                width={15}
                height={15}
              />
            </motion.span>
            <span className="min-w-0 break-words text-[13px] font-medium leading-5 text-canvas-text">
              {message}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              aria-label={copied ? t('已复制消息') : t('复制消息')}
              data-tooltip={copied ? t('已复制') : t('复制消息')}
              className="chat-panel-close-btn ml-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg
                         text-canvas-text-muted transition-[color,background-color,box-shadow,transform] duration-150
                         hover:bg-canvas-hover hover:text-canvas-text active:scale-95
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50
                         motion-reduce:transform-none"
            >
              <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} width={15} height={15} aria-hidden="true" />
            </button>
            <PopupCloseButton
              onClick={dismissToast}
              ariaLabel={t('关闭通知')}
              className="ml-0.5"
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
