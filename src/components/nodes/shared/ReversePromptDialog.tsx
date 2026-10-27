/**
 * 反推提示词弹窗 — 选模型、补充要求、跑反推、结果确认后再落成文本节点。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@iconify/react';
import type { ModelOption, ReversePromptRequest } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import {
  addReversePromptTextNode,
  resolveVisionTextModel,
  reversePrompt,
  REVERSE_PROMPT_SOURCE_LABELS,
} from '../../../services/ai/reversePrompt';
import { copyText } from '../../../services/clipboardService';
import ModelSelector from './ModelSelector';
import PopupCloseButton from '../../shared/PopupCloseButton';
import ViewportImage from '../../shared/ViewportImage';
import { useT } from '../../../i18n';

const panelVariants = {
  hidden: { opacity: 0, scale: 0.97, y: 12 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 380, damping: 32 },
  },
  exit: { opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.14 } },
};

function ReversePromptContent({
  request,
  onClose,
}: {
  request: ReversePromptRequest;
  onClose: () => void;
}) {
  const t = useT();
  const sourceLabel = t(REVERSE_PROMPT_SOURCE_LABELS[request.kind]);
  const initialModel = useMemo(() => resolveVisionTextModel(), []);
  const [model, setModel] = useState(initialModel?.model ?? '');
  const [provider, setProvider] = useState(initialModel?.provider ?? '');
  const [extraPrompt, setExtraPrompt] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleModelSelect = useCallback((option: ModelOption) => {
    setModel(option.value);
    setProvider(option.provider);
  }, []);

  const handleRun = useCallback(async () => {
    if (!model || !provider) {
      setError(t('请先选择一个能读图的文本模型'));
      return;
    }
    setRunning(true);
    setError('');
    try {
      setResult(await reversePrompt({
        kind: request.kind,
        imageUrls: request.imageUrls,
        model,
        provider,
        extraPrompt,
      }));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : t('提示词反推失败'));
    } finally {
      setRunning(false);
    }
  }, [extraPrompt, model, provider, request.imageUrls, request.kind, t]);

  const handleCopy = useCallback(async () => {
    setCopied(await copyText(result));
  }, [result]);

  const handleAddNode = useCallback(() => {
    if (!result.trim()) return;
    addReversePromptTextNode(request.sourceNodeId, request.kind, result.trim());
    onClose();
  }, [onClose, request.kind, request.sourceNodeId, result]);

  return (
    <>
      <motion.div
        data-tauri-drag-region
        className="preset-modal-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <div className="preset-modal-wrapper">
        <motion.div
          className="preset-modal reverse-prompt-modal"
          variants={panelVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reverse-prompt-title"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="preset-runner-header">
            <div className="preset-runner-heading">
              <span className="preset-runner-heading-icon">
                <Icon icon="mdi:text-search" width={20} height={20} />
              </span>
              <div>
                <h2 id="reverse-prompt-title">{t('反推提示词')}</h2>
                <p>
                  {request.kind === 'video'
                    ? t('已抽取 {count} 帧关键帧，连画面带运动一起反推', { count: request.imageUrls.length })
                    : t('读取这张图，反推出能重新生成它的提示词')}
                </p>
              </div>
            </div>
            <PopupCloseButton onClick={onClose} />
          </header>

          <div className="preset-runner-body">
            <div className="reverse-prompt-thumbs" aria-label={t('参与反推的{source}', { source: sourceLabel })}>
              {request.imageUrls.map((url, index) => (
                <ViewportImage key={`${url.slice(0, 32)}-${index}`} src={url} alt={`${sourceLabel}${index + 1}`} />
              ))}
            </div>

            <label className="preset-manager-field">
              <span className="preset-manager-label">{t('反推模型')}</span>
              <div className="reverse-prompt-model">
                <ModelSelector
                  nodeType="ai-text"
                  selectedModel={model}
                  selectedProvider={provider}
                  onSelect={handleModelSelect}
                />
                <span className="reverse-prompt-hint">{t('需要能读图的模型')}</span>
              </div>
            </label>

            <label className="preset-manager-field">
              <span className="preset-manager-label">{t('补充要求（可选）')}</span>
              <textarea
                className="preset-manager-input preset-runner-textarea"
                value={extraPrompt}
                placeholder={t('例如：输出英文提示词 / 只描述角色不描述背景 / 按 Midjourney 风格组织')}
                onChange={(event) => setExtraPrompt(event.target.value)}
              />
            </label>

            <div className="preset-manager-field">
              <span className="preset-manager-label">{t('反推结果')}</span>
              {running ? (
                <div className="reverse-prompt-loading">
                  <span className="spinner" />
                  <span>{t('正在读{source}并反推提示词...', { source: sourceLabel })}</span>
                </div>
              ) : error ? (
                <div className="reverse-prompt-error" role="alert">
                  <Icon icon="lucide:triangle-alert" width={15} height={15} />
                  <span>{error}</span>
                </div>
              ) : (
                <textarea
                  className="preset-manager-input reverse-prompt-result"
                  value={result}
                  placeholder={t('点下面的「开始反推」生成提示词，生成后可直接在这里修改')}
                  onChange={(event) => { setResult(event.target.value); setCopied(false); }}
                />
              )}
            </div>
          </div>

          <footer className="preset-modal-actions reverse-prompt-actions">
            <button
              type="button"
              className="preset-modal-btn-secondary"
              disabled={running || !result.trim()}
              onClick={handleCopy}
            >
              <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} width={15} height={15} />
              <span>{copied ? t('已复制') : t('复制')}</span>
            </button>
            <div>
              <button
                type="button"
                className="preset-modal-btn-secondary"
                disabled={running}
                onClick={handleRun}
              >
                <Icon icon={running ? 'mdi:loading' : 'mdi:refresh'} width={15} height={15} />
                <span>{running ? t('反推中...') : result || error ? t('重新反推') : t('开始反推')}</span>
              </button>
              <button
                type="button"
                className="preset-modal-btn-primary ml-1"
                disabled={running || !result.trim()}
                onClick={handleAddNode}
              >
                <Icon icon="mdi:file-document-plus-outline" width={15} height={15} />
                <span>{t('添加为文本节点')}</span>
              </button>
            </div>
          </footer>
        </motion.div>
      </div>
    </>
  );
}

export default function ReversePromptDialog() {
  const request = useAppStore((state) => state.reversePromptRequest);
  const setRequest = useAppStore((state) => state.setReversePromptRequest);
  const close = useCallback(() => setRequest(null), [setRequest]);

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close, request]);

  return createPortal(
    <AnimatePresence>
      {request ? (
        <ReversePromptContent
          key={`${request.sourceNodeId}:${request.imageUrls.length}`}
          request={request}
          onClose={close}
        />
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
