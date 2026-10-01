import { useState } from 'react';
import {
  FolderOpen, Trash, Play, MusicNotes, FilmStrip, FileText, DownloadSimple,
} from '@phosphor-icons/react';
import { Button, Tag, Skeleton } from './ui.jsx';
import { bytes, relativeTime } from '../lib/format.js';
import { fileUrl, deleteFile, revealFile } from '../lib/api.js';

const ICONS = {
  video: FilmStrip,
  audio: MusicNotes,
  subtitle: FileText,
  other: FileText,
};

function FileRow({ file, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const Icon = ICONS[file.kind] || ICONS.other;

  const remove = async () => {
    setBusy(true);
    try {
      await deleteFile(file.name);
      onDeleted(file.name);
    } catch {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <Icon size={15} weight="bold" className="mt-0.5 shrink-0 text-[var(--text-subtle)]" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] leading-snug text-[var(--text)] break-words line-clamp-2">
            {file.name}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-[var(--text-subtle)]">
            {bytes(file.size)}  {relativeTime(file.modified)}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1 pl-[26px]">
        {file.kind === 'video' || file.kind === 'audio' ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => setPreviewing((v) => !v)}
            aria-expanded={previewing}
          >
            <Play size={13} weight="fill" />
            {previewing ? 'Hide' : 'Play'}
          </Button>
        ) : null}

        <a
          href={fileUrl(file.name)}
          download={file.name}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-[var(--text-muted)] transition-colors duration-150 ease-out hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]"
        >
          <DownloadSimple size={13} weight="bold" />
          Save
        </a>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 ml-auto"
          onClick={() => revealFile(file.name)}
          aria-label={`Show ${file.name} in the file manager`}
          title="Show in file manager"
        >
          <FolderOpen size={13} weight="bold" />
        </Button>

        {confirming ? (
          <div className="flex items-center gap-1">
            <Button variant="danger" size="sm" className="h-7 px-2" onClick={remove} disabled={busy}>
              {busy ? 'Deleting' : 'Confirm'}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 px-0 text-[var(--text-subtle)] hover:text-[var(--danger)]"
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${file.name}`}
          >
            <Trash size={13} weight="bold" />
          </Button>
        )}
      </div>

      {previewing ? (
        <div className="pl-[26px]">
          {file.kind === 'video' ? (
            <video
              src={fileUrl(file.name)}
              controls
              preload="metadata"
              className="w-full max-w-sm rounded-md bg-black"
            >
              <track kind="captions" />
              Your browser cannot play this file.
            </video>
          ) : (
            <audio src={fileUrl(file.name)} controls preload="metadata" className="w-full">
              Your browser cannot play this file.
            </audio>
          )}
        </div>
      ) : null}
    </li>
  );
}

export default function Library({ files, loading, onDeleted, onOpenFolder }) {
  return (
    <section
      className="flex min-h-0 flex-col rounded-lg border border-[var(--border)] bg-[var(--surface)]"
      aria-label="Downloaded files"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-semibold text-[var(--text)]">Files</h2>
          {files.length ? (
            <span className="font-mono text-[11.5px] text-[var(--text-subtle)]">{files.length}</span>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={onOpenFolder}
          disabled={!files.length}
        >
          <FolderOpen size={13} weight="bold" />
          Open folder
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-3 p-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-2.5 w-2/5" />
              </div>
            ))}
          </div>
        ) : files.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-[13px] font-medium text-[var(--text)]">Nothing downloaded yet</p>
            <p className="mx-auto mt-1 max-w-[26ch] text-[12px] leading-relaxed text-[var(--text-muted)]">
              Finished files land in your download folder and show up here for quick playback.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {files.map((f) => (
              <FileRow key={f.name} file={f} onDeleted={onDeleted} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
