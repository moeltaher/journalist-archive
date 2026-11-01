import {loadReport, getReportStats, archivedLinks, archiveLinksText, isArchiveLink} from './archive-report.js';

const $ = id => document.getElementById(id);
const report = loadReport();

function alertUser(message, type = 'info') {
  const note = $('report-notice');
  note.textContent = message;
  note.className = `notification ${type}`;
  note.hidden = false;
}

function link(parent, text, url, className = '') {
  const a = document.createElement('a');
  a.textContent = text;
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (className) a.className = className;
  parent.append(a);
  return a;
}

async function copyText(text) {
  if (!text) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    alertUser('تم نسخ روابط الأرشفة.', 'success');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    alertUser(ok ? 'تم نسخ روابط الأرشفة.' : 'تعذر النسخ التلقائي. يمكنك فتح الروابط ونسخها مباشرة.', ok ? 'success' : 'error');
  }
}

function displayItem(item, success) {
  const row = document.createElement('article');
  row.className = 'archive-card';
  const title = document.createElement('h3');
  title.textContent = item.title;
  row.append(title);
  const original = document.createElement('div');
  original.className = 'archive-original';
  link(original, 'المقال الأصلي ↗', item.originalUrl);
  row.append(original);
  if (success && isArchiveLink(item.archiveUrl)) {
    const urlText = document.createElement('p');
    urlText.className = 'archive-url';
    urlText.dir = 'ltr';
    urlText.textContent = item.archiveUrl;
    row.append(urlText);
    const actions = document.createElement('div');
    actions.className = 'archive-card-actions';
    link(actions, 'فتح النسخة المؤرشفة ↗', item.archiveUrl, 'archive-open-link');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-link';
    button.textContent = 'نسخ الرابط';
    button.addEventListener('click', () => copyText(item.archiveUrl));
    actions.append(button);
    row.append(actions);
  } else {
    const status = document.createElement('p');
    status.className = `archive-explanation ${item.status === 'error' ? 'failure' : ''}`;
    status.textContent = item.message || (item.status === 'missing-link'
      ? 'أبلغت الخدمة بنجاح الأرشفة لكنها لم تُرجع رابطًا مؤكدًا.'
      : 'لم نتلقَّ تأكيدًا نهائيًا من Internet Archive.');
    row.append(status);
  }
  return row;
}

function init() {
  if (!report) {
    $('report-empty').hidden = false;
    return;
  }
  $('report-body').hidden = false;
  const stats = getReportStats(report);
  $('report-count').textContent = String(stats.total);
  $('report-saved').textContent = String(stats.saved);
  $('report-failed').textContent = String(stats.failed);
  $('report-not-confirmed').textContent = String(stats.unconfirmed + stats.missingLink);
  try {
    const at = report.completedAt || report.startedAt;
    $('report-date').textContent = new Intl.DateTimeFormat('ar-EG',{dateStyle:'medium',timeStyle:'short'}).format(new Date(at));
  } catch { $('report-date').textContent = ''; }
  const saved = $('saved-list');
  const others = $('other-list');
  for (const item of report.items) {
    if (item.status === 'success' && isArchiveLink(item.archiveUrl)) saved.append(displayItem(item, true));
    else others.append(displayItem(item, false));
  }
  const links = archivedLinks(report);
  $('no-saved').hidden = links.length > 0;
  $('other-panel').hidden = others.childElementCount === 0;
  $('copy-all').disabled = !links.length;
  $('download-links').disabled = !links.length;
  if (links.length === 0) alertUser('لا توجد روابط مؤرشفة مؤكدة في هذه العملية. راجع حالات المقالات أدناه.', 'info');
  else if (stats.failed || stats.unconfirmed || stats.missingLink) alertUser(`توفر ${links.length} رابطًا مؤرشفًا مؤكدًا. بعض المقالات لم تكتمل أرشفتها أو تعذّر حفظها.`, 'info');
  else alertUser(`اكتملت الأرشفة بنجاح. يتوفر ${links.length} رابطًا مؤرشفًا.`, 'success');
  $('copy-all').addEventListener('click', () => copyText(links.map(item => item.url).join('\n')));
  $('download-links').addEventListener('click', () => {
    const data = '\uFEFF' + archiveLinksText(report);
    const objectUrl = URL.createObjectURL(new Blob([data], {type:'text/plain;charset=utf-8'}));
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = 'روابط-المقالات-المؤرشفة.txt';
    document.body.append(anchor);
    anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
  });
}

init();
