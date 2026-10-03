/**
 * Cookie-file handling.
 *
 * A Netscape cookies.txt is not a preference, it is a browser credential: it
 * carries session tokens for every site the user has signed into. The README says
 * so, and the code should match the weight of that.
 *
 * Nothing here stores a cookie in job state, a trace, an event, a log line or an
 * error message. The job record keeps a boolean saying whether cookies were used,
 * which is the only part of that fact anyone needs to answer "why did this work
 * for me and not for them".
 */
import fs from 'node:fs';
import path from 'node:path';
import { DOWNLOAD_DIR, DATA_DIR, MAX_COOKIE_BYTES } from './config.js';

/**
 * Validate a user-supplied cookie path and return the resolved absolute form.
 *
 * Four checks, each closing a specific hole:
 *   - it is a path at all, and contains no NUL
 *   - it is a regular file, and not a directory or a device
 *   - it is not inside the download directory, which is served back to the
 *     browser by the media route
 *   - it is not inside the data directory, which is where job state lives
 *
 * The size ceiling is not paranoia so much as a stop on a hung read: yt-dlp is
 * handed this path and will parse whatever it finds.
 */
export function validateCookieFile(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, file: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Invalid cookie path.' };
  if (raw.includes('\0')) return { ok: false, error: 'Invalid cookie path.' };

  let full;
  try {
    full = path.resolve(raw);
  } catch {
    return { ok: false, error: 'Invalid cookie path.' };
  }

  // Containment is checked on the resolved path so `..` cannot walk out of the
  // directory it appeared to name.
  for (const [dir, label] of [[DOWNLOAD_DIR, 'download directory'], [DATA_DIR, 'data directory']]) {
    const base = path.resolve(dir);
    if (full === base || full.startsWith(base + path.sep)) {
      return { ok: false, error: `The cookie file cannot live in the ${label}, which the app serves or reads.` };
    }
  }

  let st;
  try {
    st = fs.lstatSync(full);
  } catch (err) {
    return { ok: false, error: err.code === 'ENOENT' ? 'That cookie file does not exist.' : err.message };
  }

  // A symlink is refused rather than followed: the target could be anywhere, and
  // a link is not a thing a person picking a credentials file intends to use.
  if (st.isSymbolicLink()) return { ok: false, error: 'The cookie file must be a real file, not a link.' };
  if (!st.isFile()) return { ok: false, error: 'The cookie path is not a regular file.' };
  if (st.size === 0) return { ok: false, error: 'That cookie file is empty.' };
  if (st.size > MAX_COOKIE_BYTES) {
    return { ok: false, error: `That cookie file is larger than the ${MAX_COOKIE_BYTES} byte limit.` };
  }

  return { ok: true, file: full };
}

/** yt-dlp argument list for a validated cookie file. */
export function cookieArgs(file) {
  return file ? ['--cookies', file] : [];
}

/** Deliberately vague, for a user-facing error. */
export const describeCookieFailure = (error) =>
  error || 'That cookie file could not be used.';