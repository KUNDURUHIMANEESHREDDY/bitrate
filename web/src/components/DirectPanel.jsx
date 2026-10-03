import { useState } from 'react';
import { Lightning, SpinnerGap } from '@phosphor-icons/react';
import { Button, Tag } from './ui.jsx';

/**
 * Direct-link fallback.
 *
 * Shown when yt-dlp has no extractor for the page but the page itself carries
 * fresh media URLs. Each link is scraped at request time because the tokens
 * expire, and the download runs IDM-style: parallel Range segments, no
 * re-encode, straight to disk.
 */
export default function DirectPanel({ pageUrl, result, onStart, onReset, starting }) {
  const [picked, setPicked] = useState(0);

  const submit = () =>
    onStart({
      fileUrl: result.links[picked].url,
      referer: pageUrl,
      title: result.title,
      res: result.links[picked].res,
    });

  return (
    <section
      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3"
      aria-label="Direct download options"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-semibold leading-snug text-[var(--text)] break-words">
            {result.title || 'Untitled video'}
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
            This site is not supported by the extractor, but its page carries direct file links.
            They download as-is with parallel connections. The link is fetched again the moment
            you start, so it cannot expire while you are deciding.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onReset}>
          Clear
        </Button>
      </div>

      <hr className="border-[var(--border)]" />

      <div
        role="radiogroup"
        aria-label="Available file"
        className="flex flex-wrap gap-2"
      >
        {result.links.map((link, i) => (
          <button
            key={link.url}
            type="button"
            role="radio"
            aria-checked={i === picked}
            onClick={() => setPicked(i)}
            className={[
              'h-8 px-3 rounded-md border text-[13px] font-medium font-mono',
              'transition-colors duration-150 ease-out cursor-pointer',
              i === picked
                ? 'border-[var(--accent-solid)] text-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)]'
                : 'border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text)]',
            ].join(' ')}
          >
            {link.res}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={submit} disabled={starting} className="min-w-[150px]">
          {starting ? (
            <>
              <SpinnerGap size={16} weight="bold" className="animate-spin" />
              Starting
            </>
          ) : (
            <>
              <Lightning size={16} weight="bold" />
              Direct download
            </>
          )}
        </Button>
        <Tag>multi-connection</Tag>
      </div>
    </section>
  );
}
