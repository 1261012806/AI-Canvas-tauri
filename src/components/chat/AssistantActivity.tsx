interface AssistantActivityMarkProps {
  active?: boolean;
  className?: string;
}

/** A visual signal of actual work; the caller owns the status and label. */
export function AssistantActivityMark({ active = true, className = '' }: AssistantActivityMarkProps) {
  return (
    <span
      className={`assistant-activity-mark ${active ? 'is-active' : ''} ${className}`}
      aria-hidden="true"
      data-performance-motion="essential"
    >
      <span className={`assistant-activity-orbit ${active ? 'animate-spin motion-reduce:animate-none' : ''}`}>
        <span className="assistant-activity-dot" />
      </span>
      <span className={`assistant-activity-core ${active ? 'animate-pulse motion-reduce:animate-none' : ''}`} />
    </span>
  );
}

export default function AssistantActivity({
  label,
  active = true,
  className = '',
}: AssistantActivityMarkProps & { label: string }) {
  return (
    <div className={`assistant-activity flex min-h-8 items-center gap-2 py-1.5 text-xs text-canvas-text-secondary ${className}`} role="status" aria-live="polite">
      <AssistantActivityMark active={active} />
      <span>{label}</span>
    </div>
  );
}
