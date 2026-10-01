import { useEffect, useRef, useState, useCallback } from 'react';
import { listJobs, listFiles, health as getHealth } from '../lib/api.js';

/**
 * Live server state over SSE.
 *
 * Progress arrives several times a second, so it is written straight into a
 * ref-held map and the component reads from it. Routing that through React
 * state would re-render the whole tree on every packet for no benefit.
 */
export function useServerState() {
  const [jobs, setJobs] = useState([]);
  const [files, setFiles] = useState([]);
  const [health, setHealth] = useState(null);
  const [connected, setConnected] = useState(false);

  const refreshFiles = useCallback(async () => {
    try { setFiles(await listFiles()); } catch { /* transient */ }
  }, []);

  useEffect(() => {
    let alive = true;
    let source;
    let retry;

    const boot = async () => {
      // allSettled, not all: one unavailable endpoint must not blank the rest.
      const [j, f, h] = await Promise.allSettled([listJobs(), listFiles(), getHealth()]);
      if (!alive) return;
      if (j.status === 'fulfilled') setJobs(j.value);
      if (f.status === 'fulfilled') setFiles(f.value);
      if (h.status === 'fulfilled') setHealth(h.value);
    };
    boot();

    const connect = () => {
      if (!alive) return;
      source = new EventSource('/api/events');

      source.addEventListener('open', () => alive && setConnected(true));

      source.addEventListener('job', (evt) => {
        if (!alive) return;
        const job = JSON.parse(evt.data);
        setJobs((prev) => {
          const idx = prev.findIndex((j) => j.id === job.id);
          if (idx === -1) return [job, ...prev];
          const next = [...prev];
          next[idx] = job;
          return next;
        });
      });

      source.addEventListener('library-changed', () => alive && refreshFiles());
      source.addEventListener('jobs-cleared', () => {
        if (!alive) return;
        setJobs((prev) => prev.filter((j) => j.status === 'running' || j.status === 'queued'));
      });

      source.addEventListener('error', () => {
        if (!alive) return;
        setConnected(false);
        // EventSource retries on its own, but a hard close needs a new socket.
        try { source.close(); } catch { /* already closed */ }
        retry = setTimeout(connect, 2500);
      });
    };
    connect();

    return () => {
      alive = false;
      clearTimeout(retry);
      try { source?.close(); } catch { /* already closed */ }
    };
  }, [refreshFiles]);

  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued');
  const finished = jobs.filter((j) => j.status === 'done' || j.status === 'error' || j.status === 'cancelled');

  return { jobs, active, finished, files, health, connected, refreshFiles };
}
