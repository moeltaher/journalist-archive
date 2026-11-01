// A single archive report is stored in this browser, never on our servers.
export const ARCHIVE_REPORT_KEY = 'journalist-archive-report-v1';
const statuses = new Set(['queued', 'pending', 'success', 'missing-link', 'error', 'unconfirmed']);

export function isArchiveLink(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'web.archive.org' &&
      url.port === '' && /^\/web\/\d{14}\/https?:\/\//i.test(url.pathname);
  } catch { return false; }
}

function safeOriginal(value) {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

export function makeReport(articles, title = 'مقالات مؤرشفة') {
  const now = new Date().toISOString();
  return {
    version: 1,
    title: String(title || 'مقالات مؤرشفة').slice(0, 220),
    startedAt: now,
    completedAt: null,
    items: articles.map(item => ({
      title: String(item.title || 'مقال دون عنوان').slice(0, 300),
      originalUrl: item.url,
      archiveUrl: null,
      status: 'queued',
      message: 'في انتظار إرسال طلب الأرشفة.'
    }))
  };
}

export function updateReportItem(report, originalUrl, change) {
  const item = report.items.find(entry => entry.originalUrl === originalUrl);
  if (!item) return;
  if (typeof change.message === 'string') item.message = change.message.slice(0, 500);
  if (typeof change.status === 'string' && statuses.has(change.status)) item.status = change.status;
  if (isArchiveLink(change.archiveUrl)) {
    item.archiveUrl = change.archiveUrl;
    item.status = 'success';
  } else if (item.status === 'success' && !isArchiveLink(item.archiveUrl)) {
    item.status = 'missing-link';
  }
}

export function getReportStats(report) {
  const items = Array.isArray(report?.items) ? report.items : [];
  const saved = items.filter(item => item.status === 'success' && isArchiveLink(item.archiveUrl)).length;
  const failed = items.filter(item => item.status === 'error').length;
  const missingLink = items.filter(item => item.status === 'missing-link').length;
  return {total: items.length, saved, failed, missingLink, unconfirmed: items.length - saved - failed - missingLink};
}

export function archivedLinks(report) {
  const items = Array.isArray(report?.items) ? report.items : [];
  return items.filter(item => item.status === 'success' && isArchiveLink(item.archiveUrl))
    .map(item => ({title: item.title, url: item.archiveUrl, originalUrl: item.originalUrl}));
}

export function archiveLinksText(report) {
  return archivedLinks(report).map(item => `${item.title}\n${item.url}`).join('\n\n');
}

export function storeReport(report, storage = localStorage) {
  storage.setItem(ARCHIVE_REPORT_KEY, JSON.stringify(report));
}

export function loadReport(storage = localStorage) {
  try {
    const data = JSON.parse(storage.getItem(ARCHIVE_REPORT_KEY) || 'null');
    if (data?.version !== 1 || !Array.isArray(data.items) || data.items.length > 100) return null;
    const items = data.items.map(item => {
      const originalUrl = safeOriginal(item.originalUrl);
      if (!originalUrl) return null;
      const status = statuses.has(item.status) ? item.status : 'unconfirmed';
      const archiveUrl = isArchiveLink(item.archiveUrl) ? item.archiveUrl : null;
      return {
        title: String(item.title || 'مقال دون عنوان').slice(0, 300),
        originalUrl,
        archiveUrl,
        status: status === 'success' && !archiveUrl ? 'missing-link' : status,
        message: String(item.message || '').slice(0, 500)
      };
    }).filter(Boolean);
    if (!items.length) return null;
    return {
      version: 1,
      title: String(data.title || 'مقالات مؤرشفة').slice(0, 220),
      startedAt: String(data.startedAt || ''),
      completedAt: data.completedAt ? String(data.completedAt) : null,
      items
    };
  } catch { return null; }
}
