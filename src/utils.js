const BLOCKED_TLDS = /\.(?:localhost|local|internal|test|invalid|example|onion)$/i;
const PRIVATE_V4 = /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.|198\.(?:1[89])\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/;
const NON_ARTICLE_PATH = /(?:^|\/)(?:author|authors|writer|writers|contributor|contributors|category|categories|tag|tags|topics|topic|search|contact|about|privacy|terms|login|signup|register|account|rss|feed|page|pagination|profile|profiles|video|videos|photos|gallery|archive|wp-admin|advertise|advertising|section|sections)(?:\/|$)/i;
const ASSET_FILE = /\.(?:jpg|jpeg|png|gif|svg|webp|avif|pdf|xml|json|mp3|mp4|m4a|mov|zip|docx?|xlsx?|css|js)(?:$|\?)/i;

export function cleanText(input) {
  return String(input ?? '').replace(/\u00a0/g, ' ').replace(/[\u200B\uFEFF]/g, '')
    .replace(/[\t\r\n ]+/g, ' ').trim();
}

export function safePublicUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('أدخل رابطًا صالحًا لا يتجاوز 2048 حرفًا.');
  let u;
  try { u = new URL(input.trim()); } catch { throw new Error('الرابط غير صالح. يجب أن يبدأ بـ https:// أو http://.'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('يسمح فقط بروابط صفحات HTTP وHTTPS العامة.');
  if (!u.hostname.includes('.') || u.hostname === 'localhost' || BLOCKED_TLDS.test(u.hostname) || u.hostname.includes('..')) {
    throw new Error('لا يمكن الوصول إلى عناوين محلية أو خاصة.');
  }
  if (u.port && !(['80', '443'].includes(u.port))) throw new Error('الروابط التي تستخدم منافذ غير قياسية غير مدعومة.');
  if (u.hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || PRIVATE_V4.test(u.hostname)) {
    throw new Error('لا يمكن الوصول إلى عناوين IP مباشرةً.');
  }
  if (/^(?:metadata|localhost|host\.docker\.internal|kubernetes|instance-data)\./i.test(u.hostname)) {
    throw new Error('هذا النطاق غير مدعوم.');
  }
  u.hash = '';
  return u.toString();
}

export function stripTracking(input) {
  const u = new URL(input);
  for (const key of [...u.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid|ref_src|igshid|share)$/i.test(key)) u.searchParams.delete(key);
  }
  u.hash = '';
  return u.toString();
}

export function sameSite(a, b) {
  const host = u => new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  return host(a) === host(b);
}

export function isAuthorPath(url) {
  const path = new URL(url).pathname;
  return /(?:^|\/)(?:author|authors|writer|writers|contributor|contributors|journalists|staff|people|team|profile|profiles)(?:\/|$)/i.test(path);
}

export function candidateArticle(link, pageUrl) {
  let url;
  try { url = stripTracking(safePublicUrl(link.url)); } catch { return null; }
  if (!sameSite(url, pageUrl) || url === stripTracking(pageUrl)) return null;
  const u = new URL(url);
  const title = cleanText(link.text || link.title || '');
  if (!title || title.length < 12 || title.length > 220 || ASSET_FILE.test(u.pathname)) return null;
  if (/^(?:read more|more|details|continue reading|اقرأ المزيد|المزيد|التفاصيل|تابع القراءة|التالي|السابق|اشتراك|الرئيسية|home|about|news|أخبار|مقالات|articles|تسجيل الدخول)$/i.test(title)) return null;
  if (NON_ARTICLE_PATH.test(u.pathname)) return null;
  const segments = u.pathname.split('/').filter(Boolean);
  const datePath = /\/(?:19|20)\d{2}(?:\/|\-)/.test(u.pathname);
  const storyPath = /\/(?:stories|news|articles?|posts?|features?|investigations?|columns?|opinion|reports?|story)\//i.test(u.pathname);
  const slug = segments.at(-1) || '';
  const decentSlug = slug.length >= 12 || /\d{4,}/.test(slug);
  let score = 0;
  if (datePath) score += 3;
  if (storyPath) score += 2;
  if (segments.length >= 2) score += 1;
  if (decentSlug) score += 1;
  if (title.length >= 24) score += 1;
  if (link.card) score += 1;
  if (/^(?:https?:\/\/)?[^/?]+\/?$/.test(url)) score -= 5;
  if (u.pathname.length <= 5) score -= 3;
  if (score < 2) return null;
  return { url, title, score };
}

export function pickArticles(links, pageUrl, max = 45) {
  const found = new Map();
  for (const link of links) {
    const item = candidateArticle(link, pageUrl);
    if (!item) continue;
    const old = found.get(item.url);
    if (!old || (item.score * 100 + item.title.length) > (old.score * 100 + old.title.length)) found.set(item.url, item);
  }
  return [...found.values()].sort((a, b) => b.score - a.score).slice(0, max)
    .map(({url, title}) => ({url, title}));
}

export function paginationLink(links, currentUrl, rootUrl) {
  const current = new URL(currentUrl), root = new URL(rootUrl);
  const base = root.pathname.replace(/\/(?:page|paged)\/\d+\/?$/i, '').replace(/\/$/, '') || '/';
  for (const link of links) {
    if (!sameSite(link.url, currentUrl) || link.url === currentUrl) continue;
    let u;
    try { u = new URL(safePublicUrl(link.url)); } catch { continue; }
    const pathname = u.pathname.replace(/\/$/, '') || '/';
    const rootPath = base.replace(/\/$/, '') || '/';
    const isNext = /\bnext\b/i.test(link.rel || '') || /^(?:next|next page|older posts|التالي|المزيد|الأقدم|الصفحة التالية|›|»|→)$/i.test(cleanText(link.text));
    const isPage = (u.searchParams.has('page') || u.searchParams.has('paged') || /\/(?:page|paged)\/\d+\/?$/i.test(u.pathname));
    if (!isNext && !isPage) continue;
    if (!(pathname === rootPath || pathname.startsWith(rootPath + '/'))) continue;
    if (u.href === current.href) continue;
    return u.href;
  }
  return null;
}

export function htmlDecodeLoose(value) {
  return String(value || '').replace(/&(?:amp|lt|gt|quot|apos|nbsp|#(\d+)|#x([\da-f]+));/gi, (match, dec, hex) => {
    if (dec || hex) { const code = parseInt(dec || hex, hex ? 16 : 10); return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match; }
    return ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '})[match.toLowerCase()] || match;
  });
}

export function normalizeDate(value) {
  const str = cleanText(value);
  return str ? str.slice(0, 80) : '';
}
