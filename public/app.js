import {buildDocx, ARCHIVE_FILENAME} from './docx.js';
import {makeReport, updateReportItem, storeReport, loadReport} from './archive-report.js';

const $ = id => document.getElementById(id);
const refs = {
  form:$('lookup-form'), url:$('article-url'), mode:$('page-mode'),
  analyze:$('analyze-btn'), results:$('results'), count:$('result-count'),
  description:$('result-description'), list:$('article-list'), selectAll:$('select-all'),
  selected:$('selected-count'), word:$('download-btn'), archive:$('archive-btn'),
  note:$('archive-note'), manual:$('manual-archive'), progress:$('task-progress'),
  notice:$('notification'), warnings:$('warnings'), previous:$('previous-report'), next:$('next-batch')
};
// Always provide a working Next button, including when cached HTML lacks the element.
if (!refs.next && refs.warnings) {
  refs.next = document.createElement('button');
  refs.next.id = 'next-batch';
  refs.next.type = 'button';
  refs.next.hidden = true;
}
if (refs.next) {
  refs.next.classList.add('btn', 'btn-primary', 'next-batch-button');
  refs.next.textContent = 'عرض المقالات التالية ←';
}
const state = {articles:[], busy:false, iaConfigured:false, archiveState:'checking', title:'مقالات', mode:'article', statusLoaded:false,turnstileConfigured:false};
let activeReport = null;
let archiveCheck = null;
const PROGRESS_KEY = 'journalist-archive-progress-v2';
const stateProgress = {source:'',mode:'author',nextCursor:null,archived:{}};
function saveProgress(){try{localStorage.setItem(PROGRESS_KEY,JSON.stringify(stateProgress));}catch{}}
function loadProgress(){try{const p=JSON.parse(localStorage.getItem(PROGRESS_KEY)||'null');if(p&&typeof p.source==='string'&&p.archived&&typeof p.archived==='object'){Object.assign(stateProgress,p);return true;}}catch{}return false;}
function recordSuccess(url,archiveUrl){if(!archiveUrl)return;stateProgress.archived[url]=archiveUrl;saveProgress();}
loadProgress();
let turnstileWidgetId = null, turnstileSiteKey = '', turnstileReady = false, tokenResolve = null, tokenReject = null;
window.onTurnstileLoaded = () => { turnstileReady = true; renderTurnstile(); };
function renderTurnstile() {
  if (!turnstileReady || !turnstileSiteKey || turnstileWidgetId !== null || !window.turnstile) return;
  turnstileWidgetId = window.turnstile.render('turnstile-widget', {
    sitekey:turnstileSiteKey, action:'archive', execution:'execute', appearance:'interaction-only',
    callback: token => {const done=tokenResolve;tokenResolve=null;tokenReject=null;if(done)done(token);},
    'error-callback':()=>{const done=tokenReject;tokenResolve=null;tokenReject=null;if(done)done(new Error('تعذّر تحقق Turnstile. أعد المحاولة.'));},
    'expired-callback':()=>{const done=tokenReject;tokenResolve=null;tokenReject=null;if(done)done(new Error('انتهت صلاحية التحقق. أعد المحاولة.'));}
  });
}
async function getTurnstileToken() {
  if (!state.turnstileConfigured) throw new Error('مفاتيح Turnstile ليست متاحة على الخادم.');
  for(let i=0;i<40&&turnstileWidgetId===null;i++){if(window.turnstile)turnstileReady=true;renderTurnstile();if(turnstileWidgetId!==null)break;await sleep(250);}
  if(turnstileWidgetId===null)throw new Error('لم يُحمّل Turnstile. قد يكون المتصفح يمنع سكربت التحقق.');
  return new Promise((resolve,reject)=>{
    tokenResolve=resolve;tokenReject=reject;
    try {window.turnstile.reset(turnstileWidgetId);window.turnstile.execute(turnstileWidgetId);}
    catch(error){tokenResolve=null;tokenReject=null;reject(error);}
  });
}

function announce(message, type='info') {
  refs.notice.hidden = false;
  refs.notice.textContent = message;
  refs.notice.className = `notification ${type}`;
}
function setProgress(message) {
  refs.progress.hidden = !message;
  refs.progress.textContent = message || '';
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function selectedItems() { return state.articles.filter(a => a.selected); }
function updateButtons() {
  const chosen = selectedItems();
  refs.selected.textContent = `${chosen.length} محدد`;
  refs.selectAll.checked = chosen.length > 0 && chosen.length === state.articles.length;
  refs.selectAll.indeterminate = chosen.length > 0 && chosen.length < state.articles.length;
  refs.word.disabled = state.busy || chosen.length === 0;
  refs.archive.disabled = state.busy || chosen.length === 0;
  refs.analyze.disabled = state.busy;
  if (refs.next) {
    refs.next.hidden = state.mode !== 'author' || !stateProgress.nextCursor;
    refs.next.disabled = state.busy;
  }
  refs.mode.disabled = state.busy;
  refs.url.disabled = state.busy;
  refs.selectAll.disabled = state.busy;
  refs.list.querySelectorAll('input[type=checkbox]').forEach(input => { input.disabled=state.busy; });
  if (state.archiveState === 'ready') {
    refs.note.textContent = 'الاتصال مُفعّل. عند الضغط على زر الأرشفة سنعيد التحقق ثم نرسل الروابط إلى Internet Archive.';
  } else if (state.archiveState === 'checking') {
    refs.note.textContent = 'نجري التحقق من اتصال Internet Archive. يمكنك الضغط على زر الأرشفة لإعادة التحقق.';
  } else if (state.archiveState === 'missing') {
    refs.note.textContent = 'لا يرى التطبيق مفاتيح Internet Archive في النسخة المنشورة حاليًا. اضغط على زر الأرشفة لإعادة التحقق، أو راجع أسرار Production والنشر في Cloudflare.';
  } else {
    refs.note.textContent = 'تعذّر فحص اتصال Internet Archive. اضغط على زر الأرشفة لإعادة المحاولة؛ يمكن تنزيل Word بصورة مستقلة.';
  }
  if (chosen.length === 1 && !state.iaConfigured) {
    refs.manual.href = `https://web.archive.org/save/${chosen[0].url}`;
    refs.manual.hidden = false;
  } else refs.manual.hidden = true;
}
function setBusy(value) { state.busy = value; updateButtons(); }

function saveActiveReport(item, status, message, archiveUrl) {
  if (!activeReport) return;
  updateReportItem(activeReport, item.url, {status, message, archiveUrl});
  try { storeReport(activeReport); } catch { /* Final report navigation will handle a storage failure. */ }
}


async function requestJSON(path, data) {
  const res = await fetch(path, data ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)} : {cache:'no-store'});
  let json;
  try { json = await res.json(); } catch { throw new Error('لم يستجب الخادم ببيانات مفهومة.'); }
  if (!res.ok) throw new Error(json?.error || `تعذّر تنفيذ الطلب (${res.status}).`);
  return json;
}

async function refreshArchiveAvailability({silent=false}={}) {
  if (archiveCheck) return archiveCheck;
  state.archiveState = 'checking';
  updateButtons();
  archiveCheck = (async () => {
    try {
      const result = await requestJSON('/api/status');
      state.iaConfigured = Boolean(result.archiveConfigured);
      state.turnstileConfigured = Boolean(result.turnstileConfigured);
      if (result.turnstileSiteKey && result.turnstileSiteKey !== turnstileSiteKey) {
        turnstileSiteKey = result.turnstileSiteKey;
        renderTurnstile();
      }
      state.archiveState = state.iaConfigured ? 'ready' : 'missing';
      if (!state.iaConfigured && !silent) {
        announce('الخادم لا يرى مفاتيح Internet Archive حاليًا. تحقق من حفظ IA_ACCESS_KEY وIA_SECRET_KEY كأسرار ضمن Production ومن نجاح نشر التغيير، ثم أعد المحاولة.', 'error');
      }
      return state.iaConfigured;
    } catch (error) {
      state.iaConfigured = false;
      state.archiveState = 'error';
      if (!silent) announce('تعذّر الاتصال بالخادم للتحقق من الأرشفة: ' + (error.message || 'خطأ غير معروف'), 'error');
      return false;
    } finally {
      state.statusLoaded = true;
      updateButtons();
    }
  })();
  try { return await archiveCheck; }
  finally { archiveCheck = null; }
}

function attachLink(parent, title, url) {
  const a = document.createElement('a');
  a.textContent = title;
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  parent.appendChild(a);
  return a;
}

function renderItem(item) {
  const row = document.createElement('div');
  row.className = 'article-row';
  const checked = document.createElement('input');
  checked.type = 'checkbox'; checked.checked = item.selected;
  checked.setAttribute('aria-label', `تحديد مقال: ${item.title}`);
  checked.addEventListener('change', () => {item.selected=checked.checked;updateButtons();});
  const information = document.createElement('div');
  information.className = 'article-info';
  const name = document.createElement('p'); name.className='article-title'; name.textContent=item.title;
  const source = document.createElement('div'); source.className='article-source';
  try { source.textContent = new URL(item.url).hostname + new URL(item.url).pathname; }
  catch { source.textContent = item.url; }
  const status = document.createElement('span'); status.className='article-status';
  status.textContent=item.status || 'جاهز';
  if (item.statusType) status.classList.add(item.statusType);
  item.statusEl = status;
  const links = document.createElement('div'); links.className='article-links';
  attachLink(links, 'المقال الأصلي ↗', item.url);
  item.linksEl = links;
  information.append(name,source,status,links);
  row.append(checked,information);
  return row;
}
function updateItem(item, label, type, archiveUrl) {
  item.status = label; item.statusType = type;
  if (item.statusEl) {item.statusEl.textContent = label;item.statusEl.className = `article-status ${type || ''}`;}
  if (archiveUrl && !item.archiveUrl && item.linksEl) {
    item.archiveUrl = archiveUrl;
    recordSuccess(item.url,archiveUrl);
    attachLink(item.linksEl, 'النسخة المؤرشفة ↗', archiveUrl);
  }
}

function showResults(response) {
  state.title = response.title || state.title || 'أرشيف مقالات';
  state.mode = response.mode;
  stateProgress.nextCursor=response.nextCursor||null;
  saveProgress();
  state.articles = response.articles.map(a => {
    const archiveUrl=stateProgress.archived[a.url] || null;
    return {...a,selected:!archiveUrl,status:archiveUrl?'مؤرشف سابقًا':'جاهز',statusType:archiveUrl?'success':'',archiveUrl};
  });
  refs.list.replaceChildren();
  for (const item of state.articles) {refs.list.appendChild(renderItem(item));if(item.archiveUrl)attachLink(item.linksEl,'النسخة المؤرشفة ↗',item.archiveUrl);}
  const n = state.articles.length;
  refs.count.textContent = `${n} ${n===1?'مقال': 'مقال / رابط'}`;
  refs.description.textContent = response.mode === 'article' ? 'تم التعرف على مقال واحد. اختر طريقة حفظه.' :
    `هذه مجموعة من مقالات الكاتب (فُحصت ${response.scannedPages||1} صفحات). المقالات المحفوظة سابقًا غير محددة تلقائيًا. ${response.nextCursor?'توجد مقالات أخرى؛ استخدم زر «عرض المقالات التالية».':'لم يُكتشف رابط صفحة تالية.'}`;
  refs.warnings.replaceChildren();
  for (const warning of response.warnings || []) {
    const p = document.createElement('p'); p.textContent=warning;refs.warnings.appendChild(p);
  }
  // Put the real action directly beneath the notice about more articles.
  if (refs.next) {
    refs.next.hidden = response.mode !== 'author' || !response.nextCursor;
    refs.warnings.appendChild(refs.next);
  }
  refs.warnings.hidden = !(response.warnings || []).length && !response.nextCursor;
  refs.results.hidden = false;
  setProgress('');
  updateButtons();
  void refreshArchiveAvailability({silent:true});
  refs.results.scrollIntoView({behavior:'smooth',block:'start'});
}

refs.form.addEventListener('submit', async event => {
  event.preventDefault();
  const url = refs.url.value.trim();
  if (!url) return;
  if(stateProgress.source!==url){stateProgress.source=url;stateProgress.nextCursor=null;stateProgress.archived={};saveProgress();}
  setBusy(true); announce('نجلب الصفحة ونبحث عن المقالات المنشورة فيها…');
  refs.results.hidden = true;
  try {
    const result = await requestJSON('/api/inspect',{url,mode:refs.mode.value});
    showResults(result);
    announce(result.articles.length ? `تم العثور على ${result.articles.length} رابطًا. راجع القائمة ثم اختر تنزيل Word أو الأرشفة.` :
      'اكتمل فحص الرابط، لكن لم نعثر على مقالات قابلة للاختيار.', result.articles.length?'success':'info');
  } catch (error) { announce(error.message || 'تعذّر فحص الرابط.', 'error'); }
  finally {setBusy(false);}
});

if(refs.next) refs.next.addEventListener('click', async () => {
  if(state.busy||!stateProgress.nextCursor)return;
  setBusy(true);
  announce('جاري استخراج المجموعة التالية من مقالات الكاتب…');
  const cursor=stateProgress.nextCursor;
  try {
    const result=await requestJSON('/api/inspect',{url:stateProgress.source,mode:'author',cursor});
    showResults(result);
    announce('تم تحميل المجموعة التالية. المقالات المؤرشفة سابقًا غير محددة تلقائيًا.','success');
  }catch(error){announce(error.message||'تعذّر تحميل المجموعة التالية.','error');}
  finally{setBusy(false);}
});
refs.selectAll.addEventListener('change', () => {
  const checked = refs.selectAll.checked;
  for (const item of state.articles) item.selected=checked;
  refs.list.querySelectorAll('input[type=checkbox]').forEach(input=>{input.checked=checked;});
  updateButtons();
});

refs.word.addEventListener('click', async () => {
  const chosen = selectedItems();
  if (!chosen.length) return;
  setBusy(true); announce('بدأ استخراج النصوص لإنشاء ملف Word.');
  const articles = new Array(chosen.length);
  let cursor = 0, finished = 0, failed = 0;
  const work = async () => {
    while (cursor < chosen.length) {
      const at = cursor++;
      const item = chosen[at];
      updateItem(item, 'جاري استخراج النص…', 'pending');
      try {
        const data = await requestJSON('/api/article',{url:item.url});
        articles[at] = data;
        updateItem(item, 'تم استخراج النص', 'success');
      } catch (error) {
        failed++;
        updateItem(item, `تعذّر استخراج النص: ${error.message}`, 'fail');
      }
      finished++;
      setProgress(`جاري تجهيز ملف Word — ${finished} من ${chosen.length} مقال`);
    }
  };
  try {
    await Promise.all(Array.from({length:Math.min(3,chosen.length)},work));
    const valid = articles.filter(Boolean);
    if (!valid.length) throw new Error('لم نتمكن من استخراج أي مقال. جرّب رابط مقال منفرد أو موقعًا آخر.');
    const blob = buildDocx(valid);
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = ARCHIVE_FILENAME;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    announce(`تم إنشاء ملف Word يضم ${valid.length} مقالًا${failed?`؛ تعذّر استخراج ${failed} مقالًا`:''}.`,'success');
    setProgress(`تم تجهيز ملف Word (${valid.length} مقال).`);
  } catch (error) {announce(error.message,'error');setProgress('');}
  finally {setBusy(false);}
});

async function monitorArchive(item, jobId, ticket) {
  for (let attempt=0; attempt<24; attempt++) {
    await sleep(6000);
    try {
      const result = await requestJSON('/api/archive-status',{job:jobId,url:item.url,ticket});
      if (result.status==='success') {
        updateItem(item,'نجحت الأرشفة'+(result.archiveUrl?' — الرابط متاح':'، لكن تعذّر الحصول على الرابط'),'success',result.archiveUrl);
        saveActiveReport(item, result.archiveUrl ? 'success' : 'missing-link', item.status, result.archiveUrl);
        return 'success';
      }
      if (result.status==='error') {
        updateItem(item,`فشلت الأرشفة: ${result.message || 'رفضت الخدمة حفظ الصفحة'}`,'fail');
        saveActiveReport(item, 'error', item.status);
        return 'error';
      }
    } catch (error) {
      // A transient status error is not necessarily a failed capture.
      if (attempt >= 23) break;
    }
  }
  updateItem(item,'أُرسل الطلب، لكن لم يتأكد اكتمال الحفظ. راجعه لاحقًا في Wayback Machine.','pending');
  saveActiveReport(item, 'unconfirmed', item.status);
  return 'unconfirmed';
}

refs.archive.addEventListener('click', async () => {
  const chosen = selectedItems();
  if (!chosen.length || state.busy) return;
  setBusy(true);
  const ready = await refreshArchiveAvailability({silent:false});
  if (!ready) {
    setBusy(false);
    return;
  }
  let ticket;
  try {
    announce('يجري التحقق الأمني قبل بدء الأرشفة…');
    const token = await getTurnstileToken();
    const result = await requestJSON('/api/archive-authorize',{token,urls:chosen.map(item=>item.url)});
    ticket = result.ticket;
    if (!ticket) throw new Error('لم يصدر تصريح الأرشفة.');
  } catch(error) {
    announce(error.message || 'تعذّر التحقق الأمني.', 'error');
    setBusy(false);
    return;
  }
  activeReport = makeReport(chosen, state.title);
  try {
    storeReport(activeReport);
  } catch {
    activeReport = null;
    announce('لا يسمح المتصفح بحفظ تقرير النتائج محليًا. فعّل تخزين المواقع ثم أعد المحاولة، حتى لا تفقد روابط الأرشفة عند الانتقال.', 'error');
    setBusy(false);
    return;
  }
  if (refs.previous) refs.previous.hidden = false;
  setBusy(true);
  announce('بدء إرسال المقالات إلى Wayback Machine. أبق هذه الصفحة مفتوحة أثناء العملية.');
  let submitted=0, declined=0;
  const tracks=[];
  for (let i=0;i<chosen.length;i++) {
    const item=chosen[i];
    updateItem(item,'جاري إرسال طلب الأرشفة…','pending');
    saveActiveReport(item, 'pending', item.status);
    setProgress(`إرسال الطلب ${i+1} من ${chosen.length} — تم قبول ${submitted} طلبات`);
    try {
      const result=await requestJSON('/api/archive',{url:item.url,ticket});
      submitted++;
      updateItem(item,'تم إرسال الطلب، في انتظار تأكيد الحفظ…','pending');
      saveActiveReport(item, 'pending', item.status);
      tracks.push(monitorArchive(item,result.jobId,ticket));
    } catch (error) {
      declined++;
      updateItem(item,`لم يُقبل الطلب: ${error.message}`,'fail');
      saveActiveReport(item, 'error', item.status);
    }
    if (i < chosen.length-1) await sleep(17_000);
  }
  setProgress(`أُرسل ${submitted} من ${chosen.length} طلبًا. يجري التحقق من نتيجة الحفظ…`);
  const states = await Promise.all(tracks);
  const success=states.filter(s => s==='success').length;
  const notConfirmed=states.filter(s => s==='unconfirmed').length;
  const failed=declined+states.filter(s => s==='error').length;
  announce(`نجحت أرشفة ${success} مقالًا، وتعذّرت أرشفة ${failed}${notConfirmed?`، وتبقى ${notConfirmed} طلبًا دون تأكيد`:''}.`, failed||notConfirmed?'info':'success');
  setProgress('اكتملت متابعة الطلبات. يجري فتح صفحة روابط النسخ المؤرشفة…');
  if (activeReport) {
    activeReport.completedAt = new Date().toISOString();
    try {
      storeReport(activeReport);
      window.location.assign('/archive-results.html');
      return;
    } catch {
      announce('اكتملت الأرشفة، لكن تعذّر فتح تقرير مستقل بسبب قيود تخزين المتصفح. الروابط المتاحة ظاهرة في قائمة المقالات أعلاه.', 'error');
    }
  }
  setBusy(false);
  activeReport = null;
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !state.busy) void refreshArchiveAvailability({silent:true});
});

(async () => {
  try { if (refs.previous) refs.previous.hidden = !loadReport(); } catch { /* Storage unavailable. */ }
  updateButtons();
  await refreshArchiveAvailability({silent:true});
  if(new URLSearchParams(window.location.search).get('continue')==='1' && stateProgress.source) {
    refs.url.value=stateProgress.source;
    refs.mode.value='author';
    const cursor=stateProgress.nextCursor;
    if(!cursor){announce('لا توجد صفحة تالية محفوظة لهذه المجموعة. يمكنك إعادة فحص صفحة الكاتب.','info');return;}
    setBusy(true);
    try{
      const result=await requestJSON('/api/inspect',{url:stateProgress.source,mode:'author',cursor});
      showResults(result);
      announce('تم الانتقال إلى المجموعة التالية دون إعادة أرشفة المقالات المحفوظة سابقًا.','success');
      window.history.replaceState(null,'','/');
    }catch(error){announce(error.message||'تعذّر متابعة المجموعة التالية.','error');}
    finally{setBusy(false);}
  }
})();
