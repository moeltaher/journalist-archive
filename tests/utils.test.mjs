import test from 'node:test';
import assert from 'node:assert/strict';
import {safePublicUrl, pickArticles, paginationLink, candidateArticle, isAuthorPath} from '../src/utils.js';
import {buildDocx, xmlEscape, safeFilename} from '../public/docx.js';

test('public http(s) URLs are accepted and invalid or private targets rejected', () => {
  assert.equal(safePublicUrl('https://manassa.news/stories/123#intro'),'https://manassa.news/stories/123');
  for (const bad of ['file:///etc/passwd','http://localhost/x','http://127.0.0.1','http://10.1.2.3/',
    'http://192.168.1.4','https://abc.local','http://user:pass@example.com/','http://[::1]/','https://example.com:444/path']) {
    assert.throws(()=>safePublicUrl(bad));
  }
});

test('recognizes author links and article candidates', () => {
  assert.equal(isAuthorPath('https://site.example.org/author/mohamed'),true);
  assert.equal(isAuthorPath('https://site.example.org/stories/123'),false);
  const page = 'https://manassa.news/authors/someone';
  const links=[
    {url:'https://manassa.news/stories/12345',text:'عنوان تحقيق صحفي طويل حول الحقوق الرقمية'},
    {url:'https://manassa.news/stories/12345?utm_campaign=hello',text:'عنوان تحقيق صحفي طويل حول الحقوق الرقمية'},
    {url:'https://manassa.news/news/22222',text:'التطورات المتعلقة بقانون الصحافة في مصر'},
    {url:'https://manassa.news/category/technology',text:'قسم التكنولوجيا في موقع المنصة'},
    {url:'https://another-domain.org/stories/12345',text:'عنوان آخر طويل للغاية'}
  ];
  const chosen=pickArticles(links,page);
  assert.equal(chosen.length,2);
  assert.ok(chosen[0].url.startsWith('https://manassa.news/'));
  assert.equal(candidateArticle({url:'https://manassa.news/category/technology',text:'قسم التكنولوجيا في موقع المنصة'},page),null);
});

test('pagination selects next author-page link', () => {
  const base='https://example.org/author/journalist';
  const out=paginationLink([{url:'https://example.org/author/journalist?page=2',text:'التالي',rel:'next'}],base,base);
  assert.equal(out,'https://example.org/author/journalist?page=2');
});

test('Word file generator produces a binary archive with RTL Arabic content', async () => {
  const archive=buildDocx([{title:'أرشيف «مدى» وحرية الصحافة',site:'موقع إخباري',author:'باحث تجريبي',date:'2026-10-28',
    url:'https://example.org/news/1?a=1&b=2', blocks:[{type:'p',text:'هذا نص عربي تجريبي & نص آخر.'},{type:'h2',text:'عنوان فرعي'}]}]);
  assert.ok(archive.size > 4000);
  const bytes=new Uint8Array(await archive.arrayBuffer());
  assert.deepEqual([...bytes.slice(0,4)],[0x50,0x4b,0x03,0x04]);
  assert.equal(xmlEscape('<&"'), '&lt;&amp;&quot;');
  assert.equal(safeFilename('المقال: الأكثر أهمية؟'),'المقال- الأكثر أهمية-');
});
