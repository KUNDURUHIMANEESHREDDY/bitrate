/**
 * The API token, when one is configured.
 *
 * Empty on the ordinary loopback install, which is the default and needs nothing.
 * It is delivered by the desktop shell rather than typed by a person, so there is
 * no session to keep and nothing to log out of. When the app is served to a plain
 * browser instead, it can be supplied in the URL fragment as `#token=...`, which
 * never reaches the server or a referrer header.
 */
const TOKEN = readToken();

function readToken() {
  const injected = typeof window !== 'undefined' && window.__BITRATE_TOKEN__;
  if (injected) return String(injected);
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  const match = /(?:^|[#&])token=([^&]+)/.exec(hash);
  return match ? decodeURIComponent(match[1]) : '';
}

/** True when the server is asking for a token this client does not have. */
export const hasToken = () => Boolean(TOKEN);

/**
 * Add the credential to a request.
 *
 * A header rather than a query parameter wherever possible: a query string lands in
 * proxy logs and browser history, and this one is a full-control credential.
 */
function authed(headers = {}) {
  return TOKEN ? { ...headers, 'X-Bitrate-Token': TOKEN } : headers;
}

/**
 * Append the token to a URL that something other than `fetch` will load.
 *
 * EventSource, `<audio>`, `<img>` and a download link cannot set a header, so the
 * server also accepts the credential in the query string for exactly this case.
 * That is safe only over loopback or behind TLS, which is the reason a non-loopback
 * bind without a token is a startup error rather than a warning.
 */
export const withToken = (path) => {
  if (!TOKEN) return path;
  return path + (path.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(TOKEN)}`;
};

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(withToken(path), {
    method,
    headers: authed(body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

export const health = () => request('/api/health');
export const probe = (url) => request('/api/probe', { method: 'POST', body: { url } });
export const listJobs = () => request('/api/jobs');
export const listFiles = () => request('/api/library');
export const cancelJob = (id) => request(`/api/jobs/${id}/cancel`, { method: 'POST' });
export const clearJobs = () => request('/api/jobs/clear', { method: 'POST' });
export const deleteFile = (name) =>
  request(`/api/library/${encodeURIComponent(name)}`, { method: 'DELETE' });
export const revealFile = (name) =>
  request('/api/library/reveal', { method: 'POST', body: { name: name || null } });

export const startDownload = (payload) =>
  request('/api/downloads', { method: 'POST', body: payload });

export const scrape = (url) => request('/api/scrape', { method: 'POST', body: { url } });

export const startDirect = ({ fileUrl, referer, title, res }) =>
  request('/api/downloads', { method: 'POST', body: { direct: true, fileUrl, referer, title, res } });

// A media URL for an element that cannot set a header, so it carries the token.
export const fileUrl = (name) => withToken(`/api/library/file/${encodeURIComponent(name)}`);
