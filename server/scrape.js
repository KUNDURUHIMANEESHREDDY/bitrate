/**
 * Page scraper for sites yt-dlp cannot extract.
 *
 * Some sites (notably KVS/Kernel-Video-Sharing adult CMSs) render their player
 * config as plain <source> URLs in the HTML. yt-dlp's generic extractor looks
 * for flashvars and finds nothing, but the bytes are right there. This fetches
 * the page as a browser would and pulls out the direct media links, fresh
 * tokens included (tokens expire, so they are scraped at download time, never
 * stored).
 */
import { withSpan } from './trace.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function scrapeMediaLinks(pageUrl) {
  return withSpan('scrape-page', () => scrape(pageUrl), {
    input: { host: hostOf(pageUrl) },
    output: (found) => found && { links: found.links.length, resolutions: [...new Set(found.links.map((l) => l.res))] },
  });
}

/** Host only, for tracing. Query strings can carry signed media tokens. */
function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

async function scrape(pageUrl) {
  const res = await fetch(pageUrl, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Page returned HTTP ${res.status}.`);
  const html = await res.text();

  const title = (html.match(/<title>([^<]+)<\/title>/i)?.[1] || '')
    .split('|')[0].trim().slice(0, 150) || null;

  const mp4s = [...new Set(
    [...html.matchAll(/https?:\/\/[^\s"']+\.mp4[^\s"']*/g)].map((m) => m[0]),
  )].filter((u) => !/preview|\.jpg/i.test(u));

  const m3u8s = [...new Set(
    [...html.matchAll(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/g)].map((m) => m[0]),
  )];

  const resOf = (u) => {
    const m = u.match(/_(\d{3,4})p/i);
    return m ? `${m[1]}p` : (/\.mp4/i.test(u) ? 'SD' : 'HLS');
  };

  // Highest resolution first; tokenised (authorised) links before bare ones.
  const rank = (u) => {
    const r = parseInt(resOf(u), 10) || 0;
    return r + (/acctoken|token|expires|sign/i.test(u) ? 0.5 : 0);
  };

  const links = mp4s
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 6)
    .map((url) => ({ url, res: resOf(url), kind: 'mp4' }));

  for (const u of m3u8s.slice(0, 2)) links.push({ url: u, res: 'HLS', kind: 'hls' });

  return { title, links };
}
