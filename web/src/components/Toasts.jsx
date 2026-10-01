import { WarningCircle, CheckCircle, Info, X } from '@phosphor-icons/react';

const ICONS = {
  error: WarningCircle,
  success: CheckCircle,
  info: Info,
};

const TONES = {
  error: 'text-[var(--danger)]',
  success: 'text-[var(--accent)]',
  info: 'text-[var(--text-muted)]',
};

export default function Toasts({ items, onDismiss }) {
  if (!items.length) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      role="region"
      aria-label="Notifications"
    >
      {items.map((t) => {
        const Icon = ICONS[t.tone] || ICONS.info;
        return (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-3 shadow-[0_8px_28px_-14px_rgba(0,0,0,0.35)]"
          >
            <Icon size={16} weight="bold" className={`mt-px shrink-0 ${TONES[t.tone]}`} />
            <p className="flex-1 text-[12.5px] leading-relaxed text-[var(--text)]">{t.message}</p>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss notification"
              className="shrink-0 rounded-sm p-0.5 text-[var(--text-subtle)] transition-colors duration-150 hover:text-[var(--text)]"
            >
              <X size={13} weight="bold" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
