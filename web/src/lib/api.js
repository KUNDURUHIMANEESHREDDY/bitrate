async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
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

export const fileUrl = (name) => `/api/library/file/${encodeURIComponent(name)}`;
