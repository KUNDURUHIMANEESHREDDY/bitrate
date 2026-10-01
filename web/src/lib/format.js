const units = ['B', 'KB', 'MB', 'GB', 'TB'];

export function bytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  if (n < 1024) return `${n} B`;
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function speed(n) {
  const b = bytes(n);
  return b ? `${b}/s` : null;
}

export function duration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return null;
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function eta(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m left`;
  return `${Math.floor(m / 60)}h ${m % 60}m left`;
}

export function relativeTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export const pct = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0);

/** Title-case an extractor key without the "IE" prefix people never want to read. */
export function extractorName(key) {
  if (!key) return null;
  return key.replace(/^ie$/i, '').replace(/^Youtube/g, 'YouTube').replace(/^Soundcloud/g, 'SoundCloud');
}
