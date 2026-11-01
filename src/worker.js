import {
  cleanText, safePublicUrl, sameSite, isAuthorPath, pickArticles,
  paginationLink, htmlDecodeLoose, normalizeDate
} from './utils.js';

const MAX_PAGE_BYTES = 2_600_000;
const MAX_AUTHOR_PAGES = 4;
const MAX_ARTICLES = 45;
const ARCHIVE_BASE = 'https://web.archive.org';

class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
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
        const fallbackTitle = e.getAttribute('aria-label') || e.getAttribute('title') || '';
        const state = {value:''};
        // This per-link closure captures nested span/strong text via the handler's text() below.
        this._stack ||= [];
        this._stack.push(state);
        e.onEndTag(() => {
          const i = this._stack.indexOf(state);
          if (i >= 0) this._stack.splice(i, 1);
          links.push({url:abs, text: cleanText(state.value) || cleanText(fallbackTitle), rel, card:false});
        });
      },
      text(chunk) {
        for (const state of (this._stack || [])) {
          if (state.value.length < 250) state.value += chunk.text.slice(0, 250 - state.value.length);
        }
      }
    });

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

async function inspect(url, mode) {
  const first = await downloadHtml(url);
  const page = await parsePage(first.html, first.url);
  let type = mode === 'article' || mode === 'author' ? mode : isAuthorPath(first.url) ? 'author' :
    (page.structured || /article/i.test(page.ogType)) ? 'article' :
    pickArticles(page.links, first.url).length >= 4 ? 'author' : isArticle(page) ? 'article' :
    pickArticles(page.links, first.url).length >= 2 ? 'author' : 'article';

  if (type === 'article') {
    return {mode:'article', title:page.title, scannedPages:1,
      articles:[{url: first.url, title: page.title, author: page.author, date: page.date}],
      warnings: page.blocks.reduce((sum, b) => sum + b.text.length, 0) < 80 ?
        ['لم نتأكد من إمكانية استخراج النص الكامل؛ يمكنك تجربة تنزيل Word لمعرفة النتيجة.'] : []};
  }

  const results = new Map();
  let count = 0, next = first.url;
  const visited = new Set(), warnings = [];
  while (next && count < MAX_AUTHOR_PAGES && results.size < MAX_ARTICLES) {
    if (visited.has(next)) break;
    visited.add(next);
    let current;
    if (count === 0) current = page;
    else {
      try {
        const second = await downloadHtml(next);
        current = await parsePage(second.html, second.url);
      } catch {
        warnings.push('تعذر الوصول إلى إحدى صفحات القائمة؛ قد تكون النتائج غير مكتملة.');
        break;
      }
    }
    count++;
    for (const item of pickArticles(current.links, first.url, MAX_ARTICLES)) {
      if (!results.has(item.url)) results.set(item.url, item);
      if (results.size >= MAX_ARTICLES) break;
    }
    next = paginationLink(current.links, current.url, first.url);
  }
  if (results.size >= MAX_ARTICLES) warnings.push(`عُرض أول ${MAX_ARTICLES} رابطًا مرشحًا فقط؛ قد توجد مقالات إضافية.`);
  else if (count === MAX_AUTHOR_PAGES && next) warnings.push(`تم فحص ${MAX_AUTHOR_PAGES} صفحات من قائمة الكاتب فقط؛ قد توجد صفحات أخرى.`);
  if (!results.size) warnings.push('لم نعثر على روابط مقالات واضحة في هذه الصفحة. ربما يحمل الموقع القائمة باستخدام JavaScript أو يغيّر بنيتها.');
  return {mode:'author', title:page.title, articles:[...results.values()], scannedPages:count, warnings};
}

async function extractedArticle(url) {
  const source = await downloadHtml(url);
  const page = await parsePage(source.html, source.url);
  const contentLength = page.blocks.reduce((sum, b) => sum + b.text.length, 0);
  if (contentLength < 80) throw new ApiError('لم نتمكن من استخراج نص المقال. ربما يعتمد الموقع على JavaScript أو يمنع الجلب الآلي.', 422);
  return {url:source.url, title:page.title, author:page.author, site:page.site,
    date:page.date, blocks:page.blocks, characters:contentLength};
}

async function checkRate(binding, request) {
  if (!binding) return;
  const key = request.headers.get('CF-Connecting-IP') || 'anonymous';
  const {success} = await binding.limit({key});
  if (!success) throw new ApiError('طلبات كثيرة في وقت قصير. حاول مجددًا بعد دقيقة.', 429);
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
      if (path === '/api/status' && request.method === 'GET') return json({version:'0.1.0', archiveConfigured:Boolean(env.IA_ACCESS_KEY && env.IA_SECRET_KEY)});
      if (path === '/api/archive-status' && request.method === 'GET') {
        await checkRate(env.ARTICLE_LIMITER, request);
        return json(await archiveStatus(new URL(request.url).searchParams.get('job') || '', env));
      }
      if (request.method !== 'POST') throw new ApiError('هذه العملية غير مدعومة.', 405);
      const incomingOrigin = request.headers.get('Origin');
      if (incomingOrigin && incomingOrigin !== new URL(request.url).origin) throw new ApiError('طلبات النطاقات الأخرى غير مسموحة.', 403);
      const payload = await parseBody(request);
      const url = safePublicUrl(payload.url);
      if (path === '/api/inspect') {
        await checkRate(env.INSPECT_LIMITER, request);
        const mode = ['auto','article','author'].includes(payload.mode) ? payload.mode : 'auto';
        return json(await inspect(url, mode));
      }
      if (path === '/api/article') {
        await checkRate(env.ARTICLE_LIMITER, request);
        return json(await extractedArticle(url));
      }
      if (path === '/api/archive') {
        await checkRate(env.ARCHIVE_LIMITER, request);
        return json(await submitArchive(url, env));
      }
      throw new ApiError('العنوان المطلوب غير موجود.', 404);
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Unexpected error:', error?.message || 'unknown');
      return json({error:error instanceof ApiError ? error.message : 'حدث خطأ غير متوقع أثناء معالجة الطلب.'}, error instanceof ApiError ? error.status : 500);
    }
  }
};
