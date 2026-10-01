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
 */
export function safeResolve(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null;
  const decoded = (() => {
    try { return decodeURIComponent(name); } catch { return name; }
  })();
  const base = path.resolve(DOWNLOAD_DIR);
  const full = path.resolve(base, decoded);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
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
    if (!e.isFile()) return null;
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
  const full = safeResolve(name);
  if (!full) return { ok: false, error: 'Invalid path.' };
  try {
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
  const target = name ? safeResolve(name) : DOWNLOAD_DIR;
  if (!target) return { ok: false, error: 'Invalid path.' };
  try {
    const args = name ? ['/select,', target] : [DOWNLOAD_DIR];
    // explorer needs the trailing comma glued to the path or it opens the parent.
    const child = name
      ? spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function streamFile(name) {
  const full = safeResolve(name);
  if (!full || !fs.existsSync(full)) return null;
  return { full, stat: fs.statSync(full) };
}
