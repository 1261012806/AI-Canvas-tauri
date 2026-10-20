import { useT } from '../../i18n';
import { Icon } from '@iconify/react';

/** Display only provider-returned, sanitized content; never manufacture reasoning. */
export default function ReasoningPanel({ content, truncated, active = false }: { content: string; truncated?: boolean; active?: boolean }) {
  const t = useT();
  if (!content) return null;
  return (
    <details className="chat-reasoning ui-card mb-2 min-w-0 p-2 text-xs text-canvas-text-secondary">
      <summary className="cursor-pointer rounded py-1 font-medium text-canvas-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
        <span className="ml-1 inline-flex items-center gap-2 align-middle">
          <Icon icon={active ? 'lucide:loader-circle' : 'lucide:lightbulb'} width="14" aria-hidden="true"
            className={active ? 'animate-spin motion-reduce:animate-none' : undefined} />
          {t(active ? '模型正在思考' : '模型思考')}
          <span className="text-[11px] font-normal text-canvas-text-secondary">{t('查看内容')}</span>
        </span>
      </summary>
      <p className="my-2 text-[11px] text-canvas-text-secondary">{t('由模型接口返回，仅供参考；工具权限和执行依据由应用独立判定。')}</p>
      <div tabIndex={0} className="max-h-60 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{content}</div>
      {truncated && <p className="mt-2 text-warning-light">{t('推理内容过长，展示已截断。')}</p>}
    </details>
  );
}
