/**
 * Shared primitives. Every interactive element in the app is built from these
 * so focus rings, radii, and disabled treatment stay identical.
 */

export function Button({
  children,
  variant = 'default',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}) {
  const sizes = {
    sm: 'h-8 px-3 text-[13px] gap-1.5',
    md: 'h-9 px-3.5 text-sm gap-2',
    lg: 'h-11 px-5 text-[15px] gap-2',
  };
  const variants = {
    // Primary uses the solid accent, which is dark enough in light mode and
    // light enough in dark mode to clear 4.5:1 against its label either way.
    primary:
      'bg-[var(--accent-solid)] text-[var(--accent-contrast)] hover:brightness-[1.08] active:brightness-95',
    default:
      'bg-[var(--surface-raised)] text-[var(--text)] border border-[var(--border-strong)] hover:bg-[var(--surface-sunken)]',
    ghost:
      'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-sunken)]',
    danger:
      'text-[var(--danger)] border border-[var(--border-strong)] hover:bg-[var(--surface-sunken)]',
  };

  return (
    <button
      type={type}
      className={[
        'inline-flex items-center justify-center rounded-md font-medium',
        'transition-[background-color,color,filter,transform] duration-150 ease-out',
        'active:translate-y-px select-none',
        'disabled:opacity-45 disabled:pointer-events-none',
        sizes[size],
        variants[variant],
        className,
      ].join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, error, htmlFor, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      {/* Label sits above the control. Placeholder text is never the label. */}
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-[var(--text)]">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12px] text-[var(--danger)]" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-[12px] text-[var(--text-subtle)]">{hint}</p>
      ) : null}
    </div>
  );
}

const controlBase =
  'w-full h-9 rounded-md border border-[var(--border-strong)] bg-[var(--surface-raised)] ' +
  'px-3 text-sm text-[var(--text)] transition-colors duration-150 ' +
  'placeholder:text-[var(--text-subtle)] hover:border-[var(--text-subtle)]';

export function Input({ className = '', ...rest }) {
  return <input className={`${controlBase} ${className}`} {...rest} />;
}

export function Select({ className = '', children, ...rest }) {
  return (
    <select className={`${controlBase} appearance-none pr-8 cursor-pointer ${className}`} {...rest}>
      {children}
    </select>
  );
}

/** Checkbox with the box drawn by the control itself, so the label is the hit area. */
export function Checkbox({ id, checked, onChange, label, hint }) {
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded-sm accent-[var(--accent-solid)]"
      />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-[13px] font-medium text-[var(--text)] cursor-pointer">
          {label}
        </label>
        {hint ? <p className="text-[12px] text-[var(--text-subtle)]">{hint}</p> : null}
      </div>
    </div>
  );
}

export function Segmented({ options, value, onChange, label }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex p-0.5 rounded-md bg-[var(--surface-sunken)] border border-[var(--border)]"
    >
      {options.map((opt) => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            role="radio"
            aria-checked={on}
            type="button"
            onClick={() => onChange(opt.value)}
            className={[
              'h-7 px-3 rounded-sm text-[13px] font-medium',
              'transition-colors duration-150 ease-out cursor-pointer',
              on
                ? 'bg-[var(--surface-raised)] text-[var(--text)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]',
            ].join(' ')}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function Card({ className = '', children, ...rest }) {
  return (
    <div
      className={`rounded-lg border border-[var(--border)] bg-[var(--surface)] ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Skeleton({ className = '' }) {
  return <div className={`skeleton rounded-md ${className}`} />;
}

/** Small uppercase label. Used for status and metadata only, never as decoration. */
export function Tag({ tone = 'neutral', children }) {
  const tones = {
    neutral: 'text-[var(--text-muted)] bg-[var(--surface-sunken)] border-[var(--border)]',
    accent: 'text-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)] border-transparent',
    danger: 'text-[var(--danger)] bg-[color-mix(in_oklch,var(--danger)_10%,transparent)] border-transparent',
    warning: 'text-[var(--warning)] bg-[color-mix(in_oklch,var(--warning)_12%,transparent)] border-transparent',
  };
  return (
    <span
      className={`inline-flex items-center h-5 px-1.5 rounded-sm border text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
