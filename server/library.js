import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DOWNLOAD_DIR, isWindows } from './config.js';

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi', '.flv', '.ts', '.mpg', '.mpeg']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.opus', '.ogg', '.wav', '.flac', '.weba']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const SUB_EXT = new Set(['.srt', '.vtt', '.ass']);

/**
 * Resolve a user-supplied name to an absolute path, refusing anything that
 * escapes the download directory.
 *
 * The server is loopback-only, but a path traversal here would still let a
 * malicious page in the browser read arbitrary files through the media route,
 * so the check is not optional.
 *
 * Two checks, because one is not enough. The lexical one compares resolved path
 * strings, which stops `../` and a percent-encoded `..`. The filesystem one in
 * `realResolve` resolves symlinks and compares again, which stops the case the
 * lexical check cannot see: a name in the download directory being a link to
 * somewhere else entirely. The server only ever writes regular files here, so a
 * link in the download directory is a deliberate act rather than something a
 * download produces.
 */
export function safeResolve(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null;
  const decoded = (() => {
    try { return decodeURIComponent(name); } catch { return name; }
  })();
  // A double-encoded traversal decodes once here and once more in the path layer
  // on some platforms, so the obvious forms are refused outright rather than
  // relying on which layer wins.
  if (/%2e%2e|%252e/i.test(decoded)) return null;

  const base = path.resolve(DOWNLOAD_DIR);
  const full = path.resolve(base, decoded);
  if (!contains(base, full)) return null;
  return full;
}

/** Windows paths are case-insensitive, so the containment compare has to be too. */
const contains = (base, full) => {
  const norm = process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p;
  const b = norm(base);
  const f = norm(full);
  return f === b || f.startsWith(b + path.sep);
};

/**
 * Confirm that a path, after following symlinks, is still inside the download
 * directory.
 *
 * Returns the real path on success, or null when the file is absent or escapes.
 * Callers reading a file treat null as "absent"; callers deleting one treat it as
 * "nothing to do".
 */
export function realResolve(name) {
  const full = safeResolve(name);
  if (!full) return null;
  let real;
  try {
    real = fs.realpathSync(full);
  } catch {
    return null;
  }
  let realBase;
  try {
    realBase = fs.realpathSync(path.resolve(DOWNLOAD_DIR));
  } catch {
    realBase = path.resolve(DOWNLOAD_DIR);
  }
  if (!contains(realBase, real)) return null;
  return real;
}

export function classify(name) {
  const ext = path.extname(name).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (SUB_EXT.has(ext)) return 'subtitle';
  return 'other';
}

export async function list() {
  let entries = [];
  try {
    entries = await fsp.readdir(DOWNLOAD_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(entries.map(async (e) => {
    // Only real files are offered. A link in here points at something the user
    // put there deliberately, and streaming or deleting through it would either
    // expose a path outside the library or destroy a file in it.
    if (!e.isFile() || e.isSymbolicLink()) return null;
    const full = path.join(DOWNLOAD_DIR, e.name);
    let st;
    try { st = await fsp.stat(full); } catch { return null; }
    if (e.name.endsWith('.part') || e.name.endsWith('.ytdl') || e.name.startsWith('.')) return null;
    // A zero-byte file is a failed remux or a truncated transfer. Listing it
    // would offer a Play button that can never play anything.
    if (st.size === 0) return null;
    return {
      name: e.name,
      size: st.size,
      modified: st.mtimeMs,
      kind: classify(e.name),
    };
  }));

  return files.filter(Boolean).sort((a, b) => b.modified - a.modified);
}

export async function remove(name) {
  // Deletion unlinks the name itself, so a link is removed rather than followed.
  // The lexical check is therefore the right one here, and following the link
  // would be the bug.
  const full = safeResolve(name);
  if (!full) return { ok: false, error: 'Invalid path.' };
  try {
    const st = await fsp.lstat(full);
    if (st.isDirectory()) return { ok: false, error: 'That is a folder, not a file.' };
    await fsp.unlink(full);
    return { ok: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true };
    return { ok: false, error: err.message };
  }
}

/**
 * Delete a zero-byte leftover. A failed remux or extract leaves the target file
 * created but empty next to the real download, so it gets cleaned up here
 * rather than lingering on disk forever.
 */
export function removeIfEmpty(full) {
  try {
    const st = fs.statSync(full);
    if (st.isFile() && st.size === 0) { fs.unlinkSync(full); return true; }
  } catch { /* already gone */ }
  return false;
}

/**
 * Reveal a file in the OS file manager, or open the download folder itself.
 * Windows only; the API reports "unsupported" elsewhere instead of failing hard.
 */
export function reveal(name) {
  if (!isWindows) return { ok: false, error: 'Revealing files is only wired up on Windows.' };
  // Explorer will happily open whatever it is pointed at, including through a
  // link, so this resolves the real target rather than the name.
  const target = name ? realResolve(name) : DOWNLOAD_DIR;
  if (!target) return { ok: false, error: 'Invalid path.' };
  try {
    const args = name ? [`/select,${target}`] : [DOWNLOAD_DIR];
    // explorer needs the trailing comma glued to the path or it opens the parent.
    const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * The file the media route will serve.
 *
 * Symlink-aware on purpose. This route reads a named file and streams it back, so
 * a name that resolves outside the download directory is the one case where the
 * lexical check alone would hand out an arbitrary file.
 */
export function streamFile(name) {
  const full = realResolve(name);
  if (!full) return null;
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return null;
    return { full, stat: st };
  } catch {
    return null;
  }
}
