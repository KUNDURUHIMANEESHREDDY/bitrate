/**
 * Per-job scratch space, and the promotion of a verified file into the library.
 *
 * This exists to delete a guessing step. When yt-dlp finished without reporting a
 * path, the old answer was to scan the download directory for media files newer
 * than the job and take the newest one. That is not deterministic: with more than
 * one download running, two jobs whose files land inside the same timestamp window
 * are indistinguishable, and the loser is reported as having successfully produced
 * the winner's file.
 *
 * So each job gets a directory of its own. yt-dlp writes there, the final artifact
 * is identified inside that one directory, and only then is it moved into the
 * library. Nothing is ever inferred from a directory several jobs share.
 *
 * A second thing falls out of this for free: an interrupted job leaves its
 * workspace behind, so a restart has something to resume from rather than nothing.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DOWNLOAD_DIR, JOBS_DIR } from './config.js';

/** Extensions that mean "a real finished artifact" rather than "work in progress". */
const MEDIA_RE = /\.(mp4|mkv|webm|mov|m4v|avi|flv|ts|mpg|mpeg|m4a|mp3|aac|opus|ogg|wav|flac|weba|srt|vtt|ass|jpg|jpeg|png|webp|gif|avif)$/i;
/** Suffixes yt-dlp uses for its own temporaries. */
const PARTIAL_RE = /\.(part|ytdl|temp|tmp)$/i;

/**
 * A Windows filename the filesystem will refuse, or will silently mangle.
 *
 * CON, PRN and friends are reserved on every volume, and a trailing dot or space
 * is stripped by the Win32 layer rather than reported, so two different names end
 * up as one file. Neither is worth discovering at rename time.
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeFileName(name, fallback = 'download') {
  const cleaned = String(name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 150);
  if (!cleaned) return fallback;
  if (RESERVED.test(cleaned)) return `${fallback}-${cleaned}`;
  return cleaned;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a job id to its directory, refusing anything that is not one.
 *
 * The id is not attacker-supplied today, but it is written into a filesystem path
 * and this costs three lines to make that safe rather than a traversal to find
 * later.
 */
export function workspaceFor(jobId) {
  const id = String(jobId || '');
  if (!UUID_RE.test(id)) return null;
  return path.join(JOBS_DIR, id);
}

export async function ensureWorkspace(jobId) {
  const dir = workspaceFor(jobId);
  if (!dir) return null;
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ *
 * Durable state
 * ------------------------------------------------------------------ */

const statePath = (dir) => path.join(dir, 'state.json');

/**
 * Record what a job needs in order to be picked up again.
 *
 * Deliberately separate from jobs.json, which is a view for the UI: this is the
 * part that has to survive a crash with enough detail to be useful, and it is
 * written atomically so a process killed mid-write leaves the previous state
 * readable rather than a truncated file.
 */
export async function writeState(jobId, state) {
  const dir = workspaceFor(jobId);
  if (!dir) return null;
  await fsp.mkdir(dir, { recursive: true });
  const target = statePath(dir);
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2));
  await fsp.rename(tmp, target);
  return target;
}

export async function readState(jobId) {
  const dir = workspaceFor(jobId);
  if (!dir) return null;
  try {
    return JSON.parse(await fsp.readFile(statePath(dir), 'utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Artifacts
 * ------------------------------------------------------------------ */

/** Finished artifacts in one workspace. Part files and yt-dlp temporaries are not results. */
export async function findArtifacts(dir) {
  if (!dir) return [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = await Promise.all(entries.map(async (e) => {
    // A subdirectory here would mean an extractor wrote somewhere unexpected.
    if (!e.isFile() || !MEDIA_RE.test(e.name) || PARTIAL_RE.test(e.name)) return null;
    const full = path.join(dir, e.name);
    let st;
    try { st = await fsp.stat(full); } catch { return null; }
    // Zero bytes is a failed remux or a truncated transfer, never a result.
    if (st.size === 0) return null;
    return { name: e.name, full, size: st.size, modified: st.mtimeMs };
  }));

  return found.filter(Boolean).sort((a, b) => b.modified - a.modified);
}

/** The single artifact a finished job produced, or null. */
export async function findArtifact(dir) {
  const all = await findArtifacts(dir);
  // More than one means a merge left an intermediate behind, or an extractor
  // produced several. The newest is the final one in yt-dlp's own ordering, and
  // this is inside a private directory, so unlike the old directory-wide scan the
  // question of another job's file cannot arise.
  return all[0] || null;
}

/**
 * Take one name in the library, atomically, or report that it is already taken.
 *
 * The claim has to be a single filesystem operation. Asking whether the name exists
 * and then renaming is two, and everything that can happen between them happens:
 * another job finishing in the same instant, a second copy of the app, an antivirus
 * scanner. Both callers pass the check, both believe they own the name, and only
 * one file survives — the rest are replaced or refused, and every job that asked
 * for one reports success with the same name. Nothing in the logs says otherwise,
 * because from each job's point of view it did succeed.
 *
 * `link` is the primitive that fits, because it refuses to create a name that
 * already exists: the test and the creation cannot be pulled apart. It leaves the
 * source in place, so the source is unlinked afterwards; if that unlink fails the
 * artifact is still in the library and the leftover goes with the workspace.
 *
 * Not every filesystem can do it. FAT32 and exFAT cannot hard link, and a link
 * cannot cross a volume boundary, so those fall back to an exclusive copy — also a
 * single atomic operation, and also a refusal when the name is taken, but a real
 * copy of the data rather than a second name for it.
 */
const LINK_UNSUPPORTED = new Set(['EPERM', 'EXDEV', 'EEXDEV', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK']);

async function claimName(source, target) {
  try {
    await fsp.link(source, target);
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    if (!LINK_UNSUPPORTED.has(err.code)) throw err;
    try {
      await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    } catch (copyErr) {
      if (copyErr.code === 'EEXIST') return false;
      throw copyErr;
    }
  }
  await fsp.unlink(source).catch(() => {});
  return true;
}

/** How many `name (n)` variants to try before giving up. */
const NAME_ATTEMPTS = 1000;

/** Move a file out of the workspace and into the library. */
export async function promote(file, { title } = {}) {
  const wanted = safeFileName(title ? `${title}${path.extname(file.name)}` : file.name);
  const ext = path.extname(wanted);
  const stem = wanted.slice(0, wanted.length - ext.length);

  for (let n = 0; n < NAME_ATTEMPTS; n += 1) {
    const target = n === 0
      ? path.join(DOWNLOAD_DIR, wanted)
      : path.join(DOWNLOAD_DIR, `${stem} (${n})${ext}`);
    if (await claimName(file.full, target)) {
      const st = await fsp.stat(target);
      return { name: path.basename(target), size: st.size, full: target };
    }
  }

  // Exhausting the list is the only way to reach this, and overwriting whatever
  // happens to sit at the last name would trade a loud failure for a silent one.
  throw new Error(`Could not find a free library name for ${wanted} in ${NAME_ATTEMPTS} attempts.`);
}

export async function cleanup(jobId) {
  const dir = workspaceFor(jobId);
  if (!dir) return;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Delete workspaces belonging to jobs that are no longer known.
 *
 * Called at startup. A crashed process leaves its workspaces behind, and without
 * this they accumulate forever in the data directory.
 */
export async function pruneWorkspaces(liveIds) {
  const keep = new Set(liveIds);
  let entries = [];
  try {
    entries = await fsp.readdir(JOBS_DIR, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || keep.has(e.name)) continue;
    if (!UUID_RE.test(e.name)) continue;
    await fsp.rm(path.join(JOBS_DIR, e.name), { recursive: true, force: true }).catch(() => {});
    removed += 1;
  }
  return removed;
}