/** 新会话欢迎页与建议入口；示例只预填，发送仍由用户决定。 */
import { Icon } from '@iconify/react';
import MascotAvatar from './MascotAvatar';
import { useT } from '../../i18n';

interface EmptyChatStateProps {
  onNew: () => void;
  onList: () => void;
  onOpenAgents?: () => void;
  onExample?: (text: string) => void;
  hasCanvas?: boolean;
  compact?: boolean;
}

const SUGGESTIONS = [
  { icon: 'lucide:lightbulb', title: '分析与解答', description: '把复杂问题拆开，找到清晰的思路',
    prompt: '帮我分析一个问题，梳理关键因素并给出可行建议：' },
  { icon: 'lucide:pen-line', title: '写作与润色', description: '起草、改写、翻译或整理表达',
    prompt: '帮我润色下面这段文字，保留原意，让表达更清晰自然：' },
  { icon: 'lucide:files', title: '资料与总结', description: '结合上传文件或链接提炼重点',
    prompt: '请总结我提供的资料，列出关键结论、依据和待确认的问题：' },
];
const CANVAS_SUGGESTION = {
  icon: 'lucide:workflow', title: '画布与任务', description: '查看当前进度，安排下一步工作',
  prompt: '请查看当前画布，概括已有内容和未完成的任务，给出下一步建议。',
};

export default function EmptyChatState({
  onNew, onList, onOpenAgents, onExample, hasCanvas = false, compact = false,
}: EmptyChatStateProps) {
  const t = useT();
  const suggestions = hasCanvas ? [...SUGGESTIONS, CANVAS_SUGGESTION] : SUGGESTIONS;
  return (
    <section className="chat-welcome mx-auto flex min-h-full w-full max-w-xl flex-col items-center justify-center gap-4 p-3 text-center"
      aria-label={t('开始对话')}>
      <MascotAvatar size={compact ? 36 : 48} />
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-canvas-text">{t('有什么可以帮你？')}</h3>
        <p className="max-w-sm text-xs leading-relaxed text-canvas-text-secondary">
          {t(hasCanvas
            ? '可以直接聊天、写作和分析资料，也可以协助处理当前画布。'
            : '问答、写作、翻译和资料分析，直接开始就好。对话会自动保存。')}
        </p>
      </div>
      {onExample && (
        <div className="chat-welcome-suggestions w-full">
          {suggestions.map((suggestion) => (
            <button key={suggestion.title} type="button" onClick={() => onExample(t(suggestion.prompt))}
              className="ui-card flex min-w-0 items-start gap-2 p-3 text-left transition-colors hover:bg-canvas-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
              <Icon icon={suggestion.icon} width="16" height="16" aria-hidden="true" className="mt-0.5 shrink-0 text-canvas-text-secondary" />
              <span className="min-w-0 space-y-1">
                <span className="block text-xs font-medium text-canvas-text">{t(suggestion.title)}</span>
                <span className="block text-[11px] leading-relaxed text-canvas-text-secondary">{t(suggestion.description)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {!compact && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onNew}>
          <Icon icon="lucide:plus" width="14" aria-hidden="true" />{t('新建对话')}
        </button>}
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onList}>
          <Icon icon="lucide:history" width="14" aria-hidden="true" />{t('历史记录')}
        </button>
        {onOpenAgents && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onOpenAgents}>
          <Icon icon="lucide:bot" width="14" aria-hidden="true" />{t('智能体中心')}
        </button>}
      </div>
    </section>
  );
}
