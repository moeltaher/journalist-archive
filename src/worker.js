import {
  cleanText, safePublicUrl, sameSite, isAuthorPath, pickArticles,
  paginationLink, htmlDecodeLoose, normalizeDate
} from './utils.js';
export {ArchiveQuota} from './archive-quota.js';
import {issueInspectTicket, validateInspectTicket} from './inspect-auth.js';
import {readAuthorCursor, takeAuthorCandidates, MAX_AUTHOR_CANDIDATES_PER_PAGE} from './author-pages.js';

const MAX_PAGE_BYTES = 2_600_000;
const MAX_AUTHOR_PAGES = 4;
const MAX_ARTICLES = 45;
const ARCHIVE_BASE = 'https://web.archive.org';

class ApiError extends Error {
  constructor(message, status = 400, code = null) { super(message); this.status = status; this.code = code; }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', ...headers}
  });
}

async function parseBody(request) {
  if (!/application\/json/i.test(request.headers.get('Content-Type') || '')) {
    throw new ApiError('صيغة الطلب غير مدعومة.', 415);
  }
  const length = Number(request.headers.get('content-length'));
  if (length > 16_384) throw new ApiError('حجم الطلب أكبر من المسموح.', 413);
  let raw;
  try { raw = await readLimited(request, 16_384); }
  catch { throw new ApiError('حجم الطلب أكبر من المسموح.', 413); }
  try { return JSON.parse(new TextDecoder().decode(raw)); }
  catch { throw new ApiError('تعذر قراءة بيانات الطلب.'); }
}

async function readLimited(response, maxBytes) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let length = 0;
  const parts = [];
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('TOO_LARGE');
    }
    parts.push(value);
  }
  const out = new Uint8Array(length);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

async function downloadHtml(url) {
  let next = safePublicUrl(url);
  for (let i = 0; i < 5; i++) {
    let response;
    try {
      response = await fetch(next, {
        method: 'GET', redirect: 'manual',
        headers: {'Accept': 'text/html,application/xhtml+xml;q=0.9', 'User-Agent': 'JournalistArchive/0.1 (+https://github.com/moeltaher/journalist-archive)'}
      });
    } catch {
      throw new ApiError('تعذر الاتصال بالموقع. قد يمنع الطلبات الآلية أو يكون غير متاح.', 502);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      if (!location) throw new ApiError('لم يرسل الموقع عنوان إعادة التوجيه.', 502);
      try { next = safePublicUrl(new URL(location, next).href); }
      catch { throw new ApiError('أعاد الموقع التوجيه إلى عنوان غير مدعوم.', 502); }
      continue;
    }
    if (!response.ok) throw new ApiError(`رفض الموقع الوصول إلى الصفحة (HTTP ${response.status}).`, 502);
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType && !/(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
      throw new ApiError('الرابط لا يشير إلى صفحة HTML قابلة للاستخراج.', 422);
    }
    if (Number(response.headers.get('Content-Length')) > MAX_PAGE_BYTES) {
      throw new ApiError('حجم الصفحة أكبر من الحد المدعوم.', 413);
    }
    let bytes;
    try { bytes = await readLimited(response, MAX_PAGE_BYTES); }
    catch { throw new ApiError('حجم الصفحة أكبر من الحد المدعوم.', 413); }
    const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] || 'utf-8';
    let html;
    try { html = new TextDecoder(charset).decode(bytes); }
    catch { html = new TextDecoder('utf-8').decode(bytes); }
    return { url: next, html };
  }
  throw new ApiError('أعاد الموقع التوجيه مرات كثيرة.', 502);
}

function collector(onDone, maxLength = 8000) {
  const active = [];
  return {
    element(element) {
      const state = {value: ''};
      active.push(state);
      element.onEndTag(() => {
        const i = active.indexOf(state);
        if (i >= 0) active.splice(i, 1);
        onDone(cleanText(state.value), element);
      });
    },
    text(chunk) {
      for (const state of active) {
        if (state.value.length < maxLength) state.value += chunk.text.slice(0, maxLength - state.value.length);
      }
    }
  };
}

function extractStructured(data) {
  const nodes = [];
  function walk(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return;
    if (Array.isArray(obj)) { for (const n of obj.slice(0, 50)) walk(n, depth + 1); return; }
    const type = String(obj['@type'] || '');
    if (/^(NewsArticle|Article|BlogPosting|ReportageNewsArticle|AnalysisNewsArticle)$/i.test(type) ||
        (Array.isArray(obj['@type']) && obj['@type'].some(x => /Article|Posting/i.test(x)))) nodes.push(obj);
    if (obj['@graph']) walk(obj['@graph'], depth + 1);
    if (obj.mainEntity) walk(obj.mainEntity, depth + 1);
  }
  for (const value of data) { try { walk(JSON.parse(value)); } catch { /* malformed site metadata */ } }
  return nodes[0] || null;
}

function itemListLinks(raw, pageUrl) {
  const out = [];
  let data;
  try { data = JSON.parse(raw); } catch { return out; }
  function collect(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6 || out.length > 1000) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0,1000)) collect(item,depth+1);
      return;
    }
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some(t => /^(?:ItemList|CollectionPage)$/i.test(String(t || '')))) {
      for (const element of (Array.isArray(node.itemListElement) ? node.itemListElement : []).slice(0,1000)) {
        const item = element.item || element;
        const target = typeof item === 'string' ? item : item.url || item['@id'] || element.url;
        const label = typeof item === 'string' ? (element.name || '') : (item.name || item.headline || element.name || '');
        if (!target || !label) continue;
        try { out.push({url:new URL(target,pageUrl).href,text:cleanText(label),card:true}); }
        catch { /* malformed item URL */ }
      }
    }
    if (node['@graph']) collect(node['@graph'],depth+1);
    if (node.mainEntity) collect(node.mainEntity,depth+1);
  }
  collect(data);
  return out.slice(0,1000);
}

function normalizedBlocks(items) {
  const result = [], seen = new Set();
  for (const item of items) {
    const text = cleanText(item.text);
    if ((item.type === 'p' && text.length < 28) || (item.type !== 'p' && text.length < 5)) continue;
    if (text.length > 8000 || seen.has(text)) continue;
    seen.add(text);
    result.push({type: item.type, text});
    if (result.length >= 350) break;
  }
  return result;
}

function chooseBody(sections, structuredArticle) {
  const keys = ['body', 'article', 'content', 'main', 'all'];
  for (const key of keys) {
    const blocks = normalizedBlocks(sections[key]);
    const textLength = blocks.reduce((sum, x) => sum + x.text.length, 0);
    const longParagraphs = blocks.filter(x => x.type === 'p' && x.text.length > 65).length;
    if (textLength >= 230 && longParagraphs >= 2) return blocks;
  }
  if (structuredArticle && typeof structuredArticle.articleBody === 'string' && structuredArticle.articleBody.length >= 120) {
    const paras = structuredArticle.articleBody.split(/(?:\r?\n){2,}/).map(x => ({type:'p', text: cleanText(x)}));
    const blocks = normalizedBlocks(paras);
    if (blocks.length) return blocks;
  }
  return normalizedBlocks(sections.article.length ? sections.article : sections.main.length ? sections.main : sections.all);
}

async function parsePage(html, pageUrl) {
  const meta = {}, headings = [], titles = [], dates = [], structured = [];
  const links = [], sections = {all: [], main: [], article: [], body: [], content: []};
  const rewriter = new HTMLRewriter()
    .on('meta', {element(e) {
      const key = (e.getAttribute('property') || e.getAttribute('name') || '').toLowerCase();
      const val = e.getAttribute('content');
      if (key && val && val.length < 1500 && !meta[key]) meta[key] = htmlDecodeLoose(val);
    }})
    .on('title', collector(text => { if (text) titles.push(text); }, 600))
    .on('h1', collector(text => { if (text && headings.length < 8) headings.push(text); }, 600))
    .on('time', {element(e) { const val = e.getAttribute('datetime'); if (val && dates.length < 8) dates.push(val); }})
    .on('script[type="application/ld+json"]', collector(text => {if (text && structured.length < 16) structured.push(text);}, 90_000))
    .on('link[rel="next"]', {element(e) { const href = e.getAttribute('href'); if (href) { try {links.push({url: new URL(href, pageUrl).href, text:'next', rel:'next', card:false});} catch {} } }})
    .on('a[href]', {
      ...collector(() => {}),
      element(e) {
        const href = e.getAttribute('href'), rel = e.getAttribute('rel') || '';
        if (!href || links.length >= 3000) return;
        let abs;
        try { abs = new URL(href, pageUrl).href; } catch { return; }
        const ariaLabel = e.getAttribute('aria-label') || '';
        const linkTitle = e.getAttribute('title') || '';
        const className = e.getAttribute('class') || '';
        const elementId = e.getAttribute('id') || '';
        const fallbackTitle = ariaLabel || linkTitle;
        const state = {value:''};
        // This per-link closure captures nested span/strong text via the handler's text() below.
        this._stack ||= [];
        this._stack.push(state);
        e.onEndTag(() => {
          const i = this._stack.indexOf(state);
          if (i >= 0) this._stack.splice(i, 1);
          links.push({url:abs, text: cleanText(state.value) || cleanText(fallbackTitle),
            rel, ariaLabel, title:linkTitle, className,
            id:elementId, card:false});
        });
      },
      text(chunk) {
        for (const state of (this._stack || [])) {
          if (state.value.length < 250) state.value += chunk.text.slice(0, 250 - state.value.length);
        }
      }
    });


  // Some CMSs expose "load more" only via a button's data-url or data-href.
  // Read declarative URLs; never run arbitrary onClick code or invent API calls.
  const paginationButtons = () => {
    const active = [];
    return {
      element(element) {
        if (links.length >= 3000) return;
        const candidate = ['data-next-url','data-load-more-url','data-more-url',
          'data-page-url','data-href','data-url'].map(key => element.getAttribute(key)).find(Boolean);
        if (!candidate) return;
        let resolved;
        try { resolved = new URL(candidate, pageUrl).href; } catch { return; }
        const ariaLabel = element.getAttribute('aria-label') || '';
        const title = element.getAttribute('title') || '';
        const className = element.getAttribute('class') || '';
        const elementId = element.getAttribute('id') || '';
        const state = {text:''};
        active.push(state);
        element.onEndTag(() => {
          const at = active.indexOf(state);
          if (at >= 0) active.splice(at,1);
          links.push({url:resolved, text:cleanText(state.text),
            ariaLabel, title, className, id:elementId, rel:'', card:false});
        });
      },
      text(chunk) {
        for (const state of active) {
          if (state.text.length < 160) state.text += chunk.text.slice(0,160-state.text.length);
        }
      }
    };
  };
  rewriter.on('button',paginationButtons());
  rewriter.on('[role="button"]',paginationButtons());
  rewriter.on('[data-next-url]',paginationButtons());
  rewriter.on('[data-load-more-url]',paginationButtons());

  function add(selector, group, type) {
    rewriter.on(selector, collector(text => {
      if (text && sections[group].length < 400) sections[group].push({type, text});
    }, 8000));
  }
  for (const type of ['p', 'h2', 'h3', 'li']) {
    add(`article ${type}`, 'article', type);
    add(`main ${type}`, 'main', type);
    add(`[itemprop="articleBody"] ${type}`, 'body', type);
    add(`[class*="article-body"] ${type}`, 'content', type);
    add(`[class*="story-body"] ${type}`, 'content', type);
    add(`[class*="entry-content"] ${type}`, 'content', type);
    if (type === 'p') add('p', 'all', type);
  }

  await rewriter.transform(new Response(html, {headers:{'content-type':'text/html; charset=utf-8'}})).text();
  for (const script of structured) {
    try { links.push(...itemListLinks(script, pageUrl)); } catch { /* ignore malformed metadata */ }
  }
  const story = extractStructured(structured);
  const body = chooseBody(sections, story);
  const authorValue = story?.author;
  const author = typeof authorValue === 'string' ? authorValue : Array.isArray(authorValue) ?
    authorValue.map(x => x?.name || '').filter(Boolean).join('، ') : authorValue?.name || meta.author || meta['article:author'] || '';
  const title = cleanText(htmlDecodeLoose(story?.headline || meta['og:title'] || meta['twitter:title'] || headings[0] || titles[0] || new URL(pageUrl).hostname));
  const site = cleanText(meta['og:site_name'] || new URL(pageUrl).hostname);
  const date = normalizeDate(story?.datePublished || meta['article:published_time'] || meta['date'] || meta['pubdate'] || dates[0]);
  return { url: pageUrl, title, author: cleanText(author), site, date, blocks: body, links, structured: Boolean(story), ogType: meta['og:type'] || '' };
}

function isArticle(page) {
  const count = page.blocks.filter(x => x.type === 'p').length;
  const words = page.blocks.reduce((a, x) => a + x.text.length, 0);
  return page.structured || /article/i.test(page.ogType) || (count >= 3 && words >= 650);
}

async function inspect(url, mode, cursor = null) {
  const rootUrl = safePublicUrl(url);
  let position;
  try { position = readAuthorCursor(cursor, rootUrl); }
  catch (error) { throw new ApiError(error.message || 'موضع استكمال الأرشفة غير صالح.', 422); }

  const first = await downloadHtml(position.pageUrl);
  const page = await parsePage(first.html, first.url);
  const type = cursor ? 'author' : mode === 'article' || mode === 'author' ? mode : isAuthorPath(first.url) ? 'author' :
    (page.structured || /article/i.test(page.ogType)) ? 'article' :
    pickArticles(page.links, first.url).length >= 4 ? 'author' : isArticle(page) ? 'article' :
    pickArticles(page.links, first.url).length >= 2 ? 'author' : 'article';

  if (type === 'article') {
    return {mode:'article', title:page.title, scannedPages:1, nextCursor:null,
      articles:[{url:first.url, title:page.title, author:page.author, date:page.date}],
      warnings:page.blocks.reduce((sum,b)=>sum+b.text.length,0)<80 ?
        ['لم نتأكد من إمكانية استخراج النص الكامل؛ يمكنك تجربة تنزيل Word لمعرفة النتيجة.'] : []};
  }

  const results = new Map(), visited = new Set(), warnings = [];
  let count = 0, next = first.url, offset = position.offset, nextCursor = null;
  while (next && count < MAX_AUTHOR_PAGES && results.size < MAX_ARTICLES) {
    if (visited.has(next)) {
      warnings.push('رصدنا تكرارًا في روابط صفحات الكاتب، ولذلك أوقفنا تتبع الصفحات لتجنب الدوران.');
      nextCursor = null;
      break;
    }
    visited.add(next);
    let current;
    if (count === 0) current = page;
    else {
      try {
        const fetched = await downloadHtml(next);
        current = await parsePage(fetched.html, fetched.url);
      } catch {
        warnings.push('تعذر فتح إحدى صفحات الكاتب. يمكنك استكمال البحث لاحقًا.');
        nextCursor = {pageUrl:next, offset:0};
        break;
      }
    }
    count++;
    const candidates = pickArticles(current.links, rootUrl, MAX_AUTHOR_CANDIDATES_PER_PAGE);
    const portion = takeAuthorCandidates(candidates, offset, MAX_ARTICLES-results.size);
    for (const item of portion.articles) {
      if (!results.has(item.url)) results.set(item.url, item);
    }
    if (portion.hasMoreOnPage) {
      nextCursor = {pageUrl:current.url, offset:portion.nextOffset};
      break;
    }

    const pageAfter = paginationLink(current.links, current.url, rootUrl);
    offset = 0;
    if (!pageAfter || visited.has(pageAfter)) {
      if (pageAfter) warnings.push('رصدنا رابط صفحة مكررًا وتوقف استكشاف القائمة لتجنب الدوران.');
      nextCursor = null;
      break;
    }
    next = pageAfter;
    nextCursor = {pageUrl:pageAfter, offset:0};
  }
  if (nextCursor) warnings.push('تتوفر صفحات أو مقالات إضافية. اضغط «عرض المقالات التالية» لاستكمال الاكتشاف.');
  if (!results.size) warnings.push('لم نعثر على روابط مقالات جديدة في الصفحات المفحوصة. ربما يعتمد الموقع على JavaScript أو بنية مختلفة.');
  return {mode:'author', title:cursor ? null : page.title, articles:[...results.values()],
    scannedPages:count, nextCursor, warnings};
}

async function extractedArticle(url) {
  const source = await downloadHtml(url);
  const page = await parsePage(source.html, source.url);
  const contentLength = page.blocks.reduce((sum, b) => sum + b.text.length, 0);
  if (contentLength < 80) throw new ApiError('لم نتمكن من استخراج نص المقال. ربما يعتمد الموقع على JavaScript أو يمنع الجلب الآلي.', 422);
  return {url:source.url, title:page.title, author:page.author, site:page.site,
    date:page.date, blocks:page.blocks, characters:contentLength};
}

async function checkRate(binding, request, globalKey = null) {
  if (!binding) return;
  const key = globalKey || request.headers.get('CF-Connecting-IP') || 'anonymous';
  const {success} = await binding.limit({key});
  if (!success) throw new ApiError('طلبات كثيرة في وقت قصير. حاول مجددًا بعد دقيقة.', 429);
}


// A Turnstile token is one-time and lasts five minutes. After Siteverify succeeds,
// issue a short-lived, signed permission for the exact selected article URLs.
// The existing IP rate limiter remains necessary: these tickets are not single-use.
const MAX_ARCHIVE_BATCH = 45;
const ARCHIVE_TICKET_MS = 30 * 60 * 1000;
const cryptoEncoder = new TextEncoder();
const cryptoDecoder = new TextDecoder();
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function encodeUrlSafe(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function decodeUrlSafe(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid signed value');
  const encoded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), char => char.charCodeAt(0));
}
async function ticketKey(env) {
  if (typeof env.TURNSTILE_SECRET_KEY !== 'string' || env.TURNSTILE_SECRET_KEY.length < 12) {
    throw new ApiError('لم تُضبط بيانات حماية Turnstile بصورة صحيحة.', 503);
  }
  return crypto.subtle.importKey('raw', cryptoEncoder.encode(env.TURNSTILE_SECRET_KEY),
    {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);
}
async function urlDigest(url) {
  return encodeUrlSafe(new Uint8Array(await crypto.subtle.digest('SHA-256', cryptoEncoder.encode(url))));
}
async function clientDigest(key, request) {
  // Bind to this browser and network without putting an IP address into the ticket.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const agent = request.headers.get('User-Agent') || '';
  const bytes = await crypto.subtle.sign('HMAC', key, cryptoEncoder.encode('archive-client-v1|' + ip + '|' + agent));
  return encodeUrlSafe(new Uint8Array(bytes)).slice(0, 32);
}
function checkedUrls(urls) {
  if (!Array.isArray(urls) || !urls.length || urls.length > MAX_ARCHIVE_BATCH) {
    throw new ApiError('يمكن اعتماد دفعة تحتوي على 1 إلى 45 رابطًا فقط.', 422);
  }
  const clean = urls.map(safePublicUrl);
  if (new Set(clean).size !== clean.length) throw new ApiError('احذف الروابط المكررة من دفعة الأرشفة.', 422);
  return clean;
}
async function verifyTurnstile(token, request, env, action = 'archive') {
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY) {
    throw new ApiError('لم يتم إعداد مفاتيح Turnstile في Production.', 503);
  }
  if (typeof token !== 'string' || token.length < 8 || token.length > 2048) {
    throw new ApiError('رمز التحقق الأمني غير صالح. أعد المحاولة.', 403, 'TURNSTILE_REJECTED');
  }
  const body = {
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
    remoteip: request.headers.get('CF-Connecting-IP') || undefined
  };
  let response;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
      signal:AbortSignal.timeout(15_000)
    });
  } catch {
    throw new ApiError('تعذّر الاتصال بخدمة Turnstile. حاول مجددًا.', 502);
  }
  if (!response.ok) throw new ApiError('تعذّر التحقق من حماية Turnstile. حاول مجددًا.', 502);
  let result;
  try { result = await response.json(); }
  catch { throw new ApiError('استجابة Turnstile غير مفهومة.', 502); }
  if (result?.success !== true ||
      result.hostname !== new URL(request.url).hostname || result.action !== action) {
    throw new ApiError('لم ينجح التحقق الأمني. أعد محاولة العملية لإجراء تحقق جديد.', 403, 'TURNSTILE_REJECTED');
  }
}
async function issueArchiveTicket(request, env, urls) {
  const key = await ticketKey(env);
  const payload = {
    v:1, expires:Date.now() + ARCHIVE_TICKET_MS,
    origin:new URL(request.url).origin,
    client:await clientDigest(key, request),
    urls:await Promise.all(urls.map(urlDigest))
  };
  const encoded = encodeUrlSafe(cryptoEncoder.encode(JSON.stringify(payload)));
  const content = cryptoEncoder.encode('journalist-archive-ticket-v1|' + encoded);
  const signature = encodeUrlSafe(new Uint8Array(await crypto.subtle.sign('HMAC', key, content)));
  return {ticket:encoded + '.' + signature, expiresAt:new Date(payload.expires).toISOString()};
}
async function requireArchiveTicket(ticket, url, request, env) {
  if (typeof ticket !== 'string' || ticket.length > 6500 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)) {
    throw new ApiError('يجب إكمال تحقق Turnstile قبل الأرشفة.', 403, 'ARCHIVE_AUTH_REQUIRED');
  }
  try {
    const [encoded,signature] = ticket.split('.');
    const key = await ticketKey(env);
    const valid = await crypto.subtle.verify('HMAC',key,decodeUrlSafe(signature),
      cryptoEncoder.encode('journalist-archive-ticket-v1|' + encoded));
    if (!valid) throw new Error('signature');
    const data = JSON.parse(cryptoDecoder.decode(decodeUrlSafe(encoded)));
    if (data?.v !== 1 || !Number.isFinite(data.expires) || data.expires <= Date.now() ||
        data.expires > Date.now() + ARCHIVE_TICKET_MS ||
        data.origin !== new URL(request.url).origin ||
        data.client !== await clientDigest(key,request) ||
        !Array.isArray(data.urls) || data.urls.length < 1 || data.urls.length > MAX_ARCHIVE_BATCH ||
        !data.urls.includes(await urlDigest(url))) throw new Error('expired or unauthorized URL');
  } catch {
    throw new ApiError('انتهت صلاحية تصريح الأرشفة أو تغيّر اتصالك. أعد التحقق من Turnstile.', 403, 'ARCHIVE_AUTH_REQUIRED');
  }
}

async function requireDailyQuota(env) {
  if(!env.ARCHIVE_QUOTA)throw new ApiError('عداد حماية الأرشفة غير مفعّل.',503);
  try {
    const stub=env.ARCHIVE_QUOTA.get(env.ARCHIVE_QUOTA.idFromName('archive-account'));
    const result=await stub.takeArchiveAttempt();
    if(result?.allowed===false)throw new ApiError('اكتمل الحد اليومي البالغ 100 محاولة أرشفة. حاول بعد منتصف الليل UTC.',429);
    if(result?.allowed!==true)throw new Error('invalid quota response');
  }catch(error){
    if(error instanceof ApiError)throw error;
    throw new ApiError('تعذّر فحص الحصة اليومية. أعد المحاولة لاحقًا.',503);
  }
}
function archiveHeaders(env) {
  return {'Accept':'application/json', 'Authorization':`LOW ${env.IA_ACCESS_KEY}:${env.IA_SECRET_KEY}`};
}

async function submitArchive(url, env) {
  if (!env.IA_ACCESS_KEY || !env.IA_SECRET_KEY) {
    throw new ApiError('الأرشفة الآلية غير مفعّلة بعد. أضف مفاتيح Internet Archive إلى Secrets في Cloudflare.', 503);
  }
  const body = new URLSearchParams({url});
  let response;
  try {response = await fetch(`${ARCHIVE_BASE}/save`, {method:'POST', headers:{...archiveHeaders(env), 'Content-Type':'application/x-www-form-urlencoded'}, body, redirect:'manual'});}
  catch {throw new ApiError('تعذر الاتصال بخدمة Wayback Machine.', 502);}
  if (response.status === 429) throw new ApiError('طلب Internet Archive تقليل عدد المحاولات. جرّب لاحقًا.', 429);
  if (!response.ok) throw new ApiError(`رفض Internet Archive الطلب (HTTP ${response.status}). تحقق من المفاتيح والحدود المسموحة.`, 502);
  let data;
  try { data = await response.json(); } catch { throw new ApiError('استجاب Internet Archive بصيغة غير متوقعة.', 502); }
  if (!data.job_id) throw new ApiError(data.message || 'لم تؤكد خدمة الأرشفة قبول الطلب.', 502);
  return {status:'pending', jobId:data.job_id, message: data.message || 'تم إرسال طلب الحفظ.'};
}

async function archiveStatus(jobId, env) {
  if (!env.IA_ACCESS_KEY || !env.IA_SECRET_KEY) throw new ApiError('لم تُفعّل مفاتيح Internet Archive.', 503);
  if (!/^[\w-]{6,120}$/.test(jobId)) throw new ApiError('معرّف مهمة الأرشفة غير صالح.');
  let response;
  try { response = await fetch(`${ARCHIVE_BASE}/save/status/${encodeURIComponent(jobId)}`, {headers:archiveHeaders(env), redirect:'manual'}); }
  catch { throw new ApiError('تعذر الاستعلام عن حالة الحفظ.', 502); }
  if (!response.ok) throw new ApiError(`تعذر الاستعلام عن الأرشفة (HTTP ${response.status}).`, 502);
  let data;
  try { data = await response.json(); } catch { throw new ApiError('أعاد Internet Archive بيانات غير متوقعة.', 502); }
  const state = data.status === 'success' ? 'success' : data.status === 'error' ? 'error' : 'pending';
  let archiveUrl = null;
  if (state === 'success' && /^\d{14}$/.test(String(data.timestamp || ''))) {
    try { archiveUrl = `${ARCHIVE_BASE}/web/${data.timestamp}/${safePublicUrl(data.original_url || data.url)}`; } catch { /* no grounded URL */ }
  }
  return {status:state, archiveUrl, message: String(data.message || data.status_ext || '').slice(0, 250)};
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (path === '/api/status' && request.method === 'GET') return json({
        version:'0.2.0',
        archiveConfigured:Boolean(env.IA_ACCESS_KEY && env.IA_SECRET_KEY),
        turnstileConfigured:Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY),
        turnstileSiteConfigured:Boolean(env.TURNSTILE_SITE_KEY),
        turnstileSecretConfigured:Boolean(env.TURNSTILE_SECRET_KEY),
        turnstileSiteKey:env.TURNSTILE_SITE_KEY || ''
      });
      if (request.method !== 'POST') throw new ApiError('هذه العملية غير مدعومة.', 405);
      const incomingOrigin = request.headers.get('Origin');
      if (incomingOrigin && incomingOrigin !== new URL(request.url).origin) throw new ApiError('طلبات النطاقات الأخرى غير مسموحة.', 403);
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError('الطلبات الخارجية غير مسموحة.',403);
      const payload = await parseBody(request);
      if (path === '/api/inspect-authorize') {
        await checkRate(env.INSPECT_LIMITER, request);
        const source = safePublicUrl(payload.url);
        await verifyTurnstile(payload.token, request, env, 'inspect');
        return json(await issueInspectTicket(env.TURNSTILE_SECRET_KEY,request,source));
      }
      if (path === '/api/archive-status') {
        await checkRate(env.ARTICLE_LIMITER, request);
        const url=safePublicUrl(payload.url);
        await requireArchiveTicket(payload.ticket,url,request,env);
        return json(await archiveStatus(payload.job || '', env));
      }
      if (path === '/api/archive-authorize') {
        await checkRate(env.INSPECT_LIMITER, request);
        const urls = checkedUrls(payload.urls);
        await verifyTurnstile(payload.token, request, env);
        return json(await issueArchiveTicket(request, env, urls));
      }
      const url = safePublicUrl(payload.url);
      if (path === '/api/inspect') {
        await checkRate(env.INSPECT_LIMITER, request);
        if (!await validateInspectTicket(env.TURNSTILE_SECRET_KEY,request,payload.accessTicket,url,'inspect')) throw new ApiError('تحقق Turnstile مطلوب لاستخراج المقالات.',403,'INSPECT_AUTH_REQUIRED');
        const mode = ['auto','article','author'].includes(payload.mode) ? payload.mode : 'auto';
        return json(await inspect(url, mode, payload.cursor || null));
      }
      if (path === '/api/article') {
        await checkRate(env.ARTICLE_LIMITER, request);
        if (!await validateInspectTicket(env.TURNSTILE_SECRET_KEY,request,payload.accessTicket,url,'article')) throw new ApiError('انتهت صلاحية تصريح استخراج المقالات. أعد التحقق.',403,'INSPECT_AUTH_REQUIRED');
        return json(await extractedArticle(url));
      }
      if (path === '/api/archive') {
        await checkRate(env.ARCHIVE_LIMITER, request);
        await requireArchiveTicket(payload.ticket, url, request, env);
        if(!env.IA_ACCESS_KEY||!env.IA_SECRET_KEY)throw new ApiError('لم تُفعّل مفاتيح الأرشفة.',503);
        await checkRate(env.GLOBAL_ARCHIVE_MINUTE_LIMITER,request,'all-users');
        await requireDailyQuota(env);
        return json(await submitArchive(url, env));
      }
      throw new ApiError('العنوان المطلوب غير موجود.', 404);
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Unexpected error:', error?.message || 'unknown');
      return json({error:error instanceof ApiError ? error.message : 'حدث خطأ غير متوقع أثناء معالجة الطلب.',
        ...(error instanceof ApiError && error.code ? {code:error.code} : {})}, error instanceof ApiError ? error.status : 500);
    }
  }
};
