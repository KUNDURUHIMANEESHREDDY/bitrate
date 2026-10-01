import { useCallback, useEffect, useRef, useState } from 'react';
import { useServerState } from './hooks/useServerState.js';
import { probe, scrape, startDownload, startDirect, cancelJob, revealFile } from './lib/api.js';
import Header from './components/Header.jsx';
import UrlBar from './components/UrlBar.jsx';
import Preview, { PreviewSkeleton } from './components/Preview.jsx';
import DirectPanel from './components/DirectPanel.jsx';
import { ActiveList } from './components/JobList.jsx';
import Library from './components/Library.jsx';
import Toasts from './components/Toasts.jsx';
import { Button } from './components/ui.jsx';

let toastId = 0;

export default function App() {
  const { active, finished, files, health, connected, refreshFiles } = useServerState();

  const [info, setInfo] = useState(null);
  const [direct, setDirect] = useState(null);
  const [directUrl, setDirectUrl] = useState(null);
  const [probing, setProbing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [probeError, setProbeError] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(true);

  const inputRef = useRef(null);
  const seenErrors = useRef(new Set());

  const toast = useCallback((message, tone = 'info') => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setLibraryLoading(false), 400);
    return () => clearTimeout(t);
  }, []);

  // Surface download failures once each, so a toast does not repeat on every
  // progress packet that arrives while the job is still in the error state.
  useEffect(() => {
    for (const job of finished) {
      if (job.status === 'error' && !seenErrors.current.has(job.id)) {
        seenErrors.current.add(job.id);
        toast(job.error || 'A download failed.', 'error');
      }
    }
  }, [finished, toast]);

  const handleProbe = async (url) => {
    setProbing(true);
    setProbeError(null);
    setDirect(null);
    setDirectUrl(null);
    try {
      const data = await probe(url);
      setInfo(data);
    } catch (err) {
      // The extractor does not cover this site. Before giving up, check
      // whether the page itself carries direct file links.
      try {
        const found = await scrape(url);
        if (found.links?.length) {
          setDirect(found);
          setDirectUrl(url);
          setInfo(null);
          setProbeError(null);
        } else {
          setProbeError(err.message);
          setInfo(null);
        }
      } catch {
        setProbeError(err.message);
        setInfo(null);
      }
    } finally {
      setProbing(false);
    }
  };

  const handleStart = async (payload) => {
    setStarting(true);
    try {
      await startDownload(payload);
      toast('Download started.', 'success');
      setInfo(null);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setStarting(false);
    }
  };

  const handleStartDirect = async (payload) => {
    setStarting(true);
    try {
      await startDirect(payload);
      toast('Direct download started.', 'success');
      setDirect(null);
      setDirectUrl(null);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async (id) => {
    try {
      await cancelJob(id);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const handleDeleted = () => refreshFiles();

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[var(--surface-sunken)]">
      <Header health={health} connected={connected} downloadDir={health?.downloadDir} />

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col gap-5">
            <UrlBar
              inputRef={inputRef}
              onSubmit={handleProbe}
              busy={probing}
              error={probeError}
              onDismissError={() => setProbeError(null)}
            />

            {probing ? <PreviewSkeleton /> : null}

            {info ? (
              <Preview
                info={info}
                starting={starting}
                onStart={handleStart}
                onReset={() => setInfo(null)}
              />
            ) : null}

            {direct ? (
              <DirectPanel
                pageUrl={directUrl}
                result={direct}
                starting={starting}
                onStart={handleStartDirect}
                onReset={() => { setDirect(null); setDirectUrl(null); }}
              />
            ) : null}

            <ActiveList jobs={active} onCancel={handleCancel} />

            {!active.length && !info && !direct && !probing ? (
              <EmptyState onFocusInput={() => inputRef.current?.focus()} />
            ) : null}
          </div>

          <div className="lg:sticky lg:top-6 lg:h-[calc(100dvh-7.5rem)]">
            <Library
              files={files}
              loading={libraryLoading}
              onDeleted={handleDeleted}
              onOpenFolder={() => revealFile(null)}
            />
          </div>
        </div>
      </main>

      <Toasts items={toasts} onDismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />
    </div>
  );
}

function EmptyState({ onFocusInput }) {
  return (
    <section className="rounded-lg border border-dashed border-[var(--border-strong)] px-6 py-12">
      <div className="mx-auto max-w-[42ch] text-center">
        <h2 className="text-[15px] font-semibold text-[var(--text)]">Paste a link to begin</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
          Bitrate grabs the stream the site already serves, so nothing is re-encoded unless you
          ask for it. That is the difference between a download that takes seconds and one that
          takes minutes.
        </p>
        <Button variant="default" size="md" onClick={onFocusInput} className="mt-4">
          Paste a link
        </Button>
      </div>
    </section>
  );
}
