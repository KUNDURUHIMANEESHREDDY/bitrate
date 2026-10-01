import { useState, useRef } from 'react';
import { ArrowRight, X, SpinnerGap } from '@phosphor-icons/react';
import { Button, Field, Input } from './ui.jsx';

export default function UrlBar({ onSubmit, busy, error, onDismissError, inputRef: externalRef }) {
  const [url, setUrl] = useState('');
  const localRef = useRef(null);
  const inputRef = externalRef || localRef;

  const submit = (e) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    onSubmit(url.trim());
  };

  const clear = () => {
    setUrl('');
    onDismissError?.();
    inputRef.current?.focus();
  };

  const inputId = 'url-input';
  const errorId = 'url-error';

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <Field
        label="Video or audio link"
        htmlFor={inputId}
        error={error || undefined}
        hint={error ? undefined : 'Paste a page link from YouTube, X, TikTok, Instagram, Reddit, SoundCloud, and 1000 other sites.'}
      >
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              id={inputId}
              ref={inputRef}
              value={url}
              onChange={(e) => { setUrl(e.target.value); if (error) onDismissError?.(); }}
              placeholder="https://"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck="false"
              inputMode="url"
              type="url"
              disabled={busy}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              className="pl-9"
            />
            <span
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-subtle)] pointer-events-none"
              aria-hidden="true"
            >
              <ArrowRight size={15} weight="bold" className="rotate-180" />
            </span>
          </div>

          {url && !busy ? (
            <Button
              variant="ghost"
              onClick={clear}
              aria-label="Clear the link field"
              className="h-9 w-9 px-0 shrink-0"
            >
              <X size={16} weight="bold" />
            </Button>
          ) : null}

          <Button type="submit" variant="primary" size="md" disabled={busy || !url.trim()} className="shrink-0 min-w-[104px]">
            {busy ? (
              <>
                <SpinnerGap size={16} weight="bold" className="animate-spin" />
                Reading
              </>
            ) : (
              'Fetch'
            )}
          </Button>
        </div>
      </Field>
    </form>
  );
}
