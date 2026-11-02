import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {workerFixture,ORIGIN,SOURCE,STORY,signTicket,bodyText} from './helpers/worker-fixture.mjs';
import {buildDocx} from '../public/docx.js';
let f;
before(async()=>{f=await workerFixture();});
after(async()=>{await f?.close();});
beforeEach(()=>{f.seen.length=0;});

test('all extraction, submission and polling endpoints reject missing permission before outbound I/O',async()=>{
  for(const path of ['/api/inspect','/api/article','/api/archive','/api/archive-status']) {
    const result=await f.post(path,{url:STORY,job:'fixture-job-12345'});
    assert.equal(result.status,403,path);
    assert.equal(result.data.code,path.includes('archive')?'ARCHIVE_AUTH_REQUIRED':'INSPECT_AUTH_REQUIRED');
  }
  assert.equal(f.seen.length,0);
});

test('single article authorization, extraction and DOCX use the actual Worker and HTMLRewriter',async()=>{
  const auth=await f.authorize();
  assert.equal(auth.status,200);
  const permission={url:STORY,accessTicket:auth.data.accessTicket};
  const discovery=await f.post('/api/inspect',{...permission,mode:'auto'});
  assert.equal(discovery.status,200);
  assert.equal(discovery.data.mode,'article');
  assert.equal(discovery.data.articles[0].url,STORY);
  const extracted=await f.post('/api/article',permission);
  assert.equal(extracted.status,200);
  assert.ok(extracted.data.blocks.some(block=>block.text===bodyText));
  const docx=new Uint8Array(await buildDocx([extracted.data]).arrayBuffer());
  assert.deepEqual([...docx.slice(0,4)],[80,75,3,4]);
  assert.ok(new TextDecoder().decode(docx).includes(bodyText));
  assert.equal(f.seen.filter(r=>r.url.includes('siteverify')).length,1);
});

test('author discovery continues beyond 45 articles and into the next HTML page with the same ticket',async()=>{
  const auth=await f.authorize('inspect',[SOURCE]);
  const first=await f.post('/api/inspect',{url:SOURCE,mode:'auto',accessTicket:auth.data.accessTicket});
  assert.equal(first.status,200);
  assert.equal(first.data.mode,'author');
  assert.equal(first.data.articles.length,45);
  assert.equal(first.data.nextCursor.offset,45);
  const next=await f.post('/api/inspect',{url:SOURCE,cursor:first.data.nextCursor,accessTicket:auth.data.accessTicket});
  assert.equal(next.status,200);
  assert.equal(next.data.articles.length,7);
  assert.equal(next.data.nextCursor,null);
  assert.equal(new Set([...first.data.articles,...next.data.articles].map(a=>a.url)).size,52);
  const text=await f.post('/api/article',{url:next.data.articles[0].url,accessTicket:auth.data.accessTicket});
  assert.equal(text.status,200);
  assert.equal(f.seen.filter(r=>r.url.includes('siteverify')).length,1);
});

test('expired, replayed, wrong-action and wrong-hostname Turnstile tokens do not issue permissions',async()=>{
  for(const token of ['expired-token','archive-wrong-action','wrong-hostname','short']) {
    const result=await f.post('/api/inspect-authorize',{url:STORY,token});
    assert.equal(result.status,403);
    assert.equal(result.data.code,'TURNSTILE_REJECTED');
    assert.equal(result.data.accessTicket,undefined);
    assert.ok(!result.data.error.includes('زر الأرشفة'));
  }
  const data={url:STORY,token:'inspect-single-use'};
  assert.equal((await f.post('/api/inspect-authorize',data)).status,200);
  assert.equal((await f.post('/api/inspect-authorize',data)).status,403);
  assert.equal((await f.authorize()).status,200);
  assert.equal(f.seen.filter(r=>r.url.includes('news.example.org')||r.url.includes('web.archive.org')).length,0);
});

test('Siteverify failure and malformed JSON fail closed; a fresh token can retry',async()=>{
  for(const token of ['network-failure','malformed-json']) {
    const result=await f.post('/api/inspect-authorize',{url:STORY,token});
    assert.equal(result.status,502);
    assert.equal(result.data.accessTicket,undefined);
  }
  assert.equal((await f.authorize()).status,200);
});

test('inspection tickets reject changed network/browser/origin, other sources, tampering and expiry',async()=>{
  const {data}=await f.authorize('inspect',[SOURCE]);
  const ticket=data.accessTicket;
  const expired=signTicket(ticket,{expires:Date.now()-1},'journalist-inspect-v1|');
  f.seen.length=0;
  for(const [path,url,accessTicket,headers] of [
    ['/api/inspect',SOURCE,ticket,{'CF-Connecting-IP':'203.0.113.23'}],
    ['/api/inspect',SOURCE,ticket,{'User-Agent':'OtherBrowser'}],
    ['/api/inspect',SOURCE,ticket,{Origin:'https://other.example.org'}],
    ['/api/inspect',SOURCE+'/other',ticket,{}],
    ['/api/article','https://other.example.org/story',ticket,{}],
    ['/api/inspect',SOURCE,ticket.slice(0,-8)+'tampered',{}],
    ['/api/article',STORY,expired,{}]
  ])assert.equal((await f.post(path,{url,accessTicket},headers)).status,403);
  assert.equal(f.seen.length,0);
});

test('archive authorization, submission and polling work independently of inspection',async()=>{
  const {data}=await f.authorize('archive');
  assert.ok(data.ticket);
  assert.equal((await f.post('/api/inspect',{url:STORY,accessTicket:data.ticket})).status,403);
  const submitted=await f.post('/api/archive',{url:STORY,ticket:data.ticket});
  assert.equal(submitted.status,200);
  const result=await f.post('/api/archive-status',{url:STORY,ticket:data.ticket,job:submitted.data.jobId});
  assert.equal(result.status,200);
  assert.equal(result.data.archiveUrl,'https://web.archive.org/web/20261102010000/'+STORY);
  assert.equal(f.seen.filter(r=>r.url==='https://web.archive.org/save').length,1);
});

test('expired archive tickets cannot submit or poll; renewal polls an existing job without resubmitting',async()=>{
  const {data}=await f.authorize('archive');
  const submitted=await f.post('/api/archive',{url:STORY,ticket:data.ticket});
  const expired=signTicket(data.ticket,{expires:Date.now()-1},'journalist-archive-ticket-v1|');
  for(const path of ['/api/archive','/api/archive-status']) {
    const denied=await f.post(path,{url:STORY,ticket:expired,job:submitted.data.jobId});
    assert.equal(denied.status,403);
    assert.equal(denied.data.code,'ARCHIVE_AUTH_REQUIRED');
  }
  const fresh=await f.authorize('archive');
  const result=await f.post('/api/archive-status',{url:STORY,ticket:fresh.data.ticket,job:submitted.data.jobId});
  assert.equal(result.status,200);
  assert.equal(f.seen.filter(r=>r.url==='https://web.archive.org/save').length,1);
});

test('archive tickets are bound to selected URLs, origin, browser, network and ticket type',async()=>{
  const archive=await f.authorize('archive');
  const inspect=await f.authorize();
  f.seen.length=0;
  for(const [url,ticket,headers] of [
    [STORY+'1',archive.data.ticket,{}],
    [STORY,archive.data.ticket,{'User-Agent':'OtherBrowser'}],
    [STORY,archive.data.ticket,{'CF-Connecting-IP':'203.0.113.23'}],
    [STORY,archive.data.ticket,{Origin:ORIGIN+'.evil.org'}],
    [STORY,inspect.data.accessTicket,{}]
  ])assert.equal((await f.post('/api/archive',{url,ticket},headers)).status,403);
  assert.equal(f.seen.length,0);
});

test('a stalled Siteverify response is bounded and fails closed',async()=>{
  const started=Date.now();
  const result=await f.post('/api/inspect-authorize',{url:STORY,token:'no-response'});
  assert.equal(result.status,502);
  assert.ok(Date.now()-started<30000);
  assert.equal(result.data.accessTicket,undefined);
});
