import { X, FilmStrip, MusicNotes, WarningCircle, CheckCircle, StopCircle } from '@phosphor-icons/react';
import { Button, Tag } from './ui.jsx';
import { bytes, speed, eta, pct } from '../lib/format.js';

const STATUS = {
  queued: { label: 'Queued', tone: 'neutral' },
  downloading: { label: 'Downloading', tone: 'accent' },
  processing: { label: 'Finishing', tone: 'accent' },
  done: { label: 'Done', tone: 'neutral' },
  error: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'warning' },
};

function ProgressBar({ value, indeterminate }) {
  return (
    <div
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]"
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {indeterminate ? (
        <div
          className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-[var(--accent)]"
          style={{ animation: 'slide 1.1s ease-in-out infinite' }}
        />
      ) : (
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ease-out"
          style={{ width: `${pct(value)}%` }}
        />
      )}
      <style>{'@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}'}</style>
    </div>
  );
}

export default function JobRow({ job, onCancel }) {
  const status = STATUS[job.status] || STATUS.queued;
  const running = job.status === 'running';
  const isAudio = job.kind === 'audio';
  const indeterminate = job.status === 'queued' || (running && !job.total);

  const meta = [];
  if (running && job.speed) meta.push(speed(job.speed));
  if (running && job.eta) meta.push(eta(job.eta));
  if (job.total) meta.push(`${bytes(job.downloaded || 0)} of ${bytes(job.total)}`);
  else if (job.status === 'done' && job.file?.size) meta.push(bytes(job.file.size));

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 shrink-0 text-[var(--text-subtle)]"
          aria-hidden="true"
        >
          {isAudio ? <MusicNotes size={16} weight="bold" /> : <FilmStrip size={16} weight="bold" />}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[13px] font-medium text-[var(--text)] truncate min-w-0 max-w-full">
              {job.title}
            </p>
            <Tag tone={status.tone}>{status.label}</Tag>
          </div>

          {job.error ? (
            <p className="mt-1 flex items-start gap-1.5 text-[12px] text-[var(--danger)]">
              <WarningCircle size={13} weight="bold" className="mt-px shrink-0" />
              <span>{job.error}</span>
            </p>
          ) : meta.length ? (
            <p className="mt-1 font-mono text-[11.5px] text-[var(--text-muted)]">
              {meta.join('  ')}
            </p>
          ) : null}

          {running || job.status === 'queued' ? (
            <p className="mt-1 font-mono text-[11.5px] text-[var(--text-subtle)]">
              {job.status === 'queued'
                ? 'Waiting for a free slot'
                : job.phase === 'processing'
                  ? 'Merging streams'
                  : job.percent !== null
                    ? `${job.percent.toFixed(1)}%`
                    : 'Contacting server'}
            </p>
          ) : null}
        </div>

        {job.status === 'done' ? (
          <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-[var(--accent)]" aria-label="Completed" />
        ) : null}

        {job.status === 'running' || job.status === 'queued' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onCancel(job.id)}
            aria-label={`Cancel download of ${job.title}`}
            className="shrink-0 h-7 w-7 px-0"
          >
            <StopCircle size={15} weight="fill" />
          </Button>
        ) : null}
      </div>

      {running || job.status === 'queued' ? (
        <ProgressBar value={job.percent} indeterminate={indeterminate} />
      ) : null}
    </li>
  );
}

export function ActiveList({ jobs, onCancel }) {
  if (!jobs.length) return null;
  return (
    <section aria-label="Active downloads">
      <div className="flex items-baseline justify-between px-4 pb-1.5">
        <h2 className="text-[13px] font-semibold text-[var(--text)]">Active</h2>
        <span className="font-mono text-[11.5px] text-[var(--text-subtle)]">
          {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}
        </span>
      </div>
      <ul className="rounded-lg border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)] overflow-hidden">
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} onCancel={onCancel} />
        ))}
      </ul>
    </section>
  );
}
