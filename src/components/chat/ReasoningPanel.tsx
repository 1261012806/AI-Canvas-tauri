import { useT } from '../../i18n';
import { Icon } from '@iconify/react';
import { AssistantActivityMark } from './AssistantActivity';

/** Display only provider-returned, sanitized content; never manufacture reasoning. */
export default function ReasoningPanel({ content, truncated, active = false }: { content: string; truncated?: boolean; active?: boolean }) {
  const t = useT();
  if (!content) return null;
  return (
    <details className="chat-reasoning mb-2 min-w-0 text-xs text-canvas-text-secondary">
      <summary className="chat-reasoning-summary w-fit max-w-full cursor-pointer rounded-md py-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
        <span className="inline-flex items-center gap-2 align-middle">
          {active ? <AssistantActivityMark /> : <Icon icon="lucide:lightbulb" width="14" aria-hidden="true" className="shrink-0" />}
          <span>{t(active ? '模型正在思考' : '模型思考')}</span>
          <Icon icon="lucide:chevron-right" width="13" aria-hidden="true" className="chat-reasoning-chevron shrink-0 text-canvas-text-muted" />
        </span>
      </summary>
      <div className="chat-reasoning-body mt-1 space-y-2 pl-3">
        <p className="text-[11px] text-canvas-text-secondary">{t('由模型接口返回，仅供参考；工具权限和执行依据由应用独立判定。')}</p>
        <div tabIndex={0} className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand [overflow-wrap:anywhere]">{content}</div>
        {truncated && <p className="text-warning-light">{t('推理内容过长，展示已截断。')}</p>}
      </div>
    </details>
  );
}
