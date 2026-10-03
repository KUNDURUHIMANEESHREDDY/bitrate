/**
 * Page scraper for sites yt-dlp cannot extract.
 *
 * Some sites (notably KVS/Kernel-Video-Sharing adult CMSs) render their player
 * config as plain <source> URLs in the HTML. yt-dlp's generic extractor looks
 * for flashvars and finds nothing, but the bytes are right there. This fetches
 * the page as a browser would and pulls out the direct media links, fresh
 * tokens included (tokens expire, so they are scraped at download time, never
 * stored).
 *
 * Two limits apply here that did not before, and both are about what the page can
 * make this process do:
 *
 *   - the body is read through a hard byte ceiling, so an origin that streams
 *     forever is refused rather than buffered into memory
 *   - every extracted URL is checked before it is offered, because a link handed
 *     back here is a link the direct downloader will fetch. A page that puts
 *     http://127.0.0.1/ in its HTML would otherwise be aiming the app at the
 *     user's own machine.
 */
import { withSpan } from './trace.js';
import { validateExtractedMediaUrl } from './network-policy.js';
import { safeFetch, readCapped } from './http-client.js';
import { MAX_SCRAPE_BYTES, SCRAPE_TIMEOUT_MS } from './config.js';
import { gates } from './limits.js';
import { recordFailure } from './metrics.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export async function scrapeMediaLinks(pageUrl) {
  return withSpan('scrape-page', () => gates.scrape.run(() => scrape(pageUrl)), {
    input: { host: hostOf(pageUrl) },
    output: (found) => found && {
      links: found.links.length,
      resolutions: [...new Set(found.links.map((l) => l.res))],
      // How many candidates were dropped, so a page full of internal links is
      // visible as such rather than looking like a page that had no media.
      filtered: found.filtered ?? 0,
      // Whether the page had HLS at all. Not a link, just a fact about the page,
      // so the caller can explain an empty result instead of returning nothing.
      hlsSeen: found.hlsSeen ?? 0,
    },
    // A blocked address is counted as one rather than as a scrape failure: the
    // page was never read, and lumping the two together would make a policy
    // decision look like a broken website.
    onError: (err) => { recordFailure(err, 'scrape_failed'); },
  });
}

/** Host only, for tracing. Query strings can carry signed media tokens. */
function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

async function scrape(pageUrl) {
  const res = await safeFetch(pageUrl, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    timeoutMs: SCRAPE_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`Page returned HTTP ${res.status}.`);
  const html = await readCapped(res, MAX_SCRAPE_BYTES, 'page');

  const title = (html.match(/<title>([^<]+)<\/title>/i)?.[1] || '')
    .split('|')[0].trim().slice(0, 150) || null;

  const candidates = [
    ...html.matchAll(/https?:\/\/[^\s"']+\.mp4[^\s"']*/g),
    ...html.matchAll(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/g),
  ].map((m) => m[0]);

  // A dropped candidate is a normal outcome, not an error: pages routinely link
  // to internal hosts for thumbnails and player assets. Counting them is what
  // makes "no media found" distinguishable from "all the media was filtered".
  const allowed = [];
  let filtered = 0;
  for (const raw of candidates) {
    if (/preview|\.jpg/i.test(raw)) continue;
    const url = validateExtractedMediaUrl(raw);
    if (!url) { filtered += 1; continue; }
    allowed.push(url);
  }

  const unique = [...new Set(allowed)];
  const mp4s = unique.filter((u) => /\.mp4/i.test(u));
  const m3u8s = unique.filter((u) => /\.m3u8/i.test(u));

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

  // HLS is deliberately not offered here.
  //
  // A `.m3u8` is a playlist: a text file listing variant playlists and segments.
  // The direct engine is a byte-range downloader -- it probes for a length, plans
  // windows across the body and writes them to a `.part` file -- and none of that
  // means anything for a playlist. Offering one produced a download that either
  // failed with "Could not determine file size" or, on an origin that reports a
  // length, saved a few kilobytes of playlist text into the library under a video
  // name. Both are worse than not offering it.
  //
  // These URLs are still useful, just not here: the yt-dlp path resolves a manifest
  // properly, fetches the segments and hands the result to ffmpeg. A page that only
  // exposes HLS is a case where the direct fallback genuinely does not apply, and
  // saying so beats offering a button that cannot work.
  //
  // `hlsSeen` records that the page had one, so the API can say why no direct
  // option appeared instead of leaving the user to wonder.
  const hlsSeen = m3u8s.length;

  return { title, links, filtered, hlsSeen };
}