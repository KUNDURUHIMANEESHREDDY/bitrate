import { useState } from 'react';
import { ArrowDown, CheckCircle, XCircle, Info } from '@phosphor-icons/react';

/**
 * Status header.
 *
 * The dot here carries real state (is the server reachable), which is the one
 * case where a status dot is warranted rather than decorative.
 */
export default function Header({ health, connected, downloadDir }) {
  const [open, setOpen] = useState(false);

  const engineOk = health?.ytdlp?.available;
  const frag = health?.tuning?.concurrentFragments;
  const conc = health?.tuning?.maxConcurrent;

  return (
    <header className="border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6">
        <div className="flex h-14 items-center gap-3">
          <span
            className="grid h-7 w-7 place-items-center rounded-md bg-[var(--accent-solid)] text-[var(--accent-contrast)]"
            aria-hidden="true"
          >
            <ArrowDown size={15} weight="bold" />
          </span>

          <h1 className="text-[15px] font-semibold tracking-tight text-[var(--text)]">
            Bitrate
          </h1>

          <div className="ml-auto flex items-center gap-2">
            {health ? (
              <span className="hidden items-center gap-1.5 font-mono text-[11.5px] text-[var(--text-subtle)] sm:inline-flex">
                <span className="text-[var(--text-muted)]">
                  {frag ? `${frag}x` : ''}
                </span>
                <span className="text-[var(--text-subtle)]">/</span>
                <span className="text-[var(--text-muted)]">
                  {conc ? `${conc} at a time` : ''}
                </span>
              </span>
            ) : null}

            <div className="relative">
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-haspopup="dialog"
                className="inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-[12.5px] font-medium text-[var(--text-muted)] transition-colors duration-150 ease-out hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    connected ? 'bg-[var(--accent)]' : 'bg-[var(--danger)]'
                  }`}
                  aria-hidden="true"
                />
                {connected ? 'Connected' : 'Reconnecting'}
              </button>

              {open ? (
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-10 cursor-default"
                    aria-label="Close status panel"
                    onClick={() => setOpen(false)}
                  />
                  <div
                    role="dialog"
                    aria-label="Engine status"
                    className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-3 shadow-[0_8px_28px_-12px_rgba(0,0,0,0.28)]"
                  >
                    <StatusRow
                      ok={engineOk}
                      label="yt-dlp"
                      value={health?.ytdlp?.version || 'not installed'}
                    />
                    <StatusRow
                      ok={health?.ffmpeg}
                      label="ffmpeg"
                      value={health?.ffmpeg ? 'merging and mp3' : 'not found'}
                    />
                    <StatusRow
                      ok={health?.aria2c}
                      label="aria2c"
                      value={health?.aria2c ? 'multi-connection' : 'optional, not installed'}
                      neutralWhenOff
                    />
                    <p className="mt-3 border-t border-[var(--border)] pt-2.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                      <span className="font-medium text-[var(--text)]">Downloads to</span>
                      <br />
                      <span className="font-mono break-all">{downloadDir}</span>
                    </p>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function StatusRow({ ok, label, value, neutralWhenOff = false }) {
  const good = ok || (neutralWhenOff && !ok ? null : false);
  return (
    <div className="flex items-center gap-2 py-1">
      {good === null ? (
        <Info size={13} weight="bold" className="shrink-0 text-[var(--text-subtle)]" />
      ) : good ? (
        <CheckCircle size={13} weight="fill" className="shrink-0 text-[var(--accent)]" />
      ) : (
        <XCircle size={13} weight="fill" className="shrink-0 text-[var(--danger)]" />
      )}
      <span className="font-mono text-[11.5px] text-[var(--text)]">{label}</span>
      <span className="ml-auto truncate font-mono text-[11.5px] text-[var(--text-subtle)]">
        {value}
      </span>
    </div>
  );
}
