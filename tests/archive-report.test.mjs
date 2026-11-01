import test from 'node:test';
import assert from 'node:assert/strict';
import {makeReport, updateReportItem, storeReport, loadReport, getReportStats, archivedLinks, archiveLinksText, isArchiveLink, ARCHIVE_REPORT_KEY} from '../public/archive-report.js';

const input=[
  {title:'مقال عن الصحافة',url:'https://example.org/news/1'},
  {title:'تحقيق طويل',url:'https://example.org/news/2'},
  {title:'تقرير آخر',url:'https://example.org/news/3'}
];
const archive='https://web.archive.org/web/20261101194530/https://example.org/news/1';

test('a final report shows only verified archive.org links, separate from failures',()=>{
  const report=makeReport(input,'مقالات كاتب');
  updateReportItem(report,input[0].url,{status:'success',archiveUrl:archive,message:'نجحت الأرشفة'});
  updateReportItem(report,input[1].url,{status:'error',message:'الموقع رفض الحفظ'});
  updateReportItem(report,input[2].url,{status:'missing-link',message:'نجحت الأرشفة ولكن لا يوجد رابط'});
  assert.deepEqual(getReportStats(report),{total:3,saved:1,failed:1,missingLink:1,unconfirmed:0});
  assert.equal(archivedLinks(report).length,1);
  assert.equal(archivedLinks(report)[0].url,archive);
  assert.match(archiveLinksText(report),/مقال عن الصحافة\nhttps:\/\/web\.archive\.org/);
  assert.ok(!archiveLinksText(report).includes('تحقيق طويل'));
});

test('unverified or spoofed links never appear as successful captures',()=>{
  for(const bad of ['https://web.archive.org.attacker.test/web/20261101194530/https://example.org',
    'javascript:alert(1)','https://web.archive.org/save/https://example.org',
    'http://web.archive.org/web/20261101194530/https://example.org']) assert.equal(isArchiveLink(bad),false);
  const report=makeReport(input.slice(0,1));
  updateReportItem(report,input[0].url,{status:'success',archiveUrl:'https://example.org/not-an-archive'});
  assert.equal(report.items[0].status,'missing-link');
  assert.deepEqual(archivedLinks(report),[]);
});

test('report survives a local browser reload and refuses unsafe persisted links',()=>{
  const values=new Map();
  const storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const report=makeReport(input.slice(0,1));
  updateReportItem(report,input[0].url,{status:'success',archiveUrl:archive});
  storeReport(report,storage);
  assert.equal(loadReport(storage).items[0].archiveUrl,archive);
  const persisted=JSON.parse(values.get(ARCHIVE_REPORT_KEY));
  persisted.items[0].archiveUrl='javascript:alert(1)';
  values.set(ARCHIVE_REPORT_KEY,JSON.stringify(persisted));
  assert.equal(loadReport(storage).items[0].status,'missing-link');
  assert.equal(getReportStats(loadReport(storage)).saved,0);
});
