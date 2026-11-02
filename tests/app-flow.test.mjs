import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture} from './helpers/app-fixture.mjs';
const story='https://news.example.org/stories/1',author='https://news.example.org/author/reporter';

test('article -> Word -> archive uses the right visible widget and creates a real DOCX blob',async t=>{
  const f=await appFixture(t);
  await f.submit(story);
  assert.equal(f.ids('results').hidden,false);
  assert.equal(f.ids('article-list').children.length,1);
  await f.click('download-btn');
  assert.equal(f.downloads.length,1);
  assert.ok(new TextDecoder().decode(await f.downloads[0].arrayBuffer()).includes('النص الكامل للمقال'));
  await f.click('archive-btn',{navigation:true});
  assert.equal(f.navigation,'/archive-results.html');
  assert.deepEqual(f.widgets.map(w=>w.selector),['#inspect-turnstile-widget','#archive-turnstile-widget']);
  assert.deepEqual(f.counts(),{inspect:1,archive:1});
  assert.equal(f.calls.filter(c=>c.path==='/api/archive').length,1);
});

test('author -> additional batch -> Word retains the cursor and shares inspection permission',async t=>{
  const f=await appFixture(t);
  await f.submit(author);
  assert.equal(f.ids('next-batch').hidden,false);
  await f.click('next-batch');
  assert.equal(f.ids('next-batch').hidden,true);
  assert.equal(f.ids('article-list').children.length,1);
  await f.click('download-btn');
  assert.equal(f.counts().inspect,1);
  assert.equal(f.calls.filter(c=>c.path==='/api/inspect').at(-1).data.cursor.offset,45);
  assert.equal(f.calls.find(c=>c.path==='/api/article').data.url,'https://news.example.org/stories/3');
});

test('a rejected cached permission is renewed for pagination without losing results or cursor',async t=>{
  const f=await appFixture(t);
  await f.submit(author);
  f.invalidInspect.add('inspect-ticket-1');
  await f.click('next-batch');
  assert.equal(f.counts().inspect,2);
  assert.equal(f.ids('next-batch').hidden,true);
  assert.equal(f.calls.filter(c=>c.path==='/api/inspect').length,3);
});

test('parallel Word extraction renews a rejected permission once',async t=>{
  const f=await appFixture(t);
  await f.submit(author);
  f.invalidInspect.add('inspect-ticket-1');
  await f.click('download-btn');
  assert.equal(f.counts().inspect,2);
  assert.equal(f.downloads.length,1);
  assert.match(f.ids('notification').textContent,/2 مقالًا/);
});

test('locally expired inspection permission is refreshed before downloading Word',async t=>{
  const f=await appFixture(t);
  await f.submit(story);
  f.advance(3600000);
  await f.click('download-btn');
  assert.equal(f.counts().inspect,2);
  assert.equal(f.calls.filter(c=>c.path==='/api/article').length,1);
});

for(const outcome of ['error','timeout','hang']) {
  test(`Turnstile ${outcome} unlocks the form and the next click can succeed`,async t=>{
    const f=await appFixture(t);
    f.outcome=outcome;
    const run=f.submit(story);
    if(outcome==='hang') {
      await f.waitFor(()=>f.timers.size>0);
      [...f.timers.values()].find(timer=>timer.ms===120000).fn();
    }
    await run;
    assert.equal(f.ids('analyze-btn').disabled,false);
    assert.equal(f.calls.filter(c=>c.path==='/api/inspect').length,0);
    await f.submit(story);
    assert.equal(f.ids('results').hidden,false);
    assert.equal(f.counts().inspect,1);
  });
}

test('Siteverify rejection is shown, then a fresh token succeeds on the next click',async t=>{
  const f=await appFixture(t);
  f.failures.set('/api/inspect-authorize',[{status:403,data:{error:'رمز منتهي',code:'TURNSTILE_REJECTED'}}]);
  await f.submit(story);
  assert.match(f.ids('notification').textContent,/رمز منتهي/);
  await f.submit(story);
  const tokens=f.calls.filter(c=>c.path==='/api/inspect-authorize').map(c=>c.data.token);
  assert.equal(new Set(tokens).size,2);
  assert.equal(f.ids('results').hidden,false);
});

test('changing the source obtains a separate inspection permission',async t=>{
  const f=await appFixture(t);
  await f.submit(story);
  await f.submit(author);
  assert.equal(f.counts().inspect,2);
  assert.equal(f.ids('article-list').children.length,2);
});

test('archive polling renews after session expiry without submitting the article again',async t=>{
  const f=await appFixture(t);
  await f.submit(story);
  f.archiveSleepJump=31*60*1000;
  await f.click('archive-btn',{navigation:true});
  assert.equal(f.counts().archive,2);
  assert.equal(f.calls.filter(c=>c.path==='/api/archive').length,1);
  assert.equal(f.calls.filter(c=>c.path==='/api/archive-status').length,1);
});

test('an ambiguous archive network error is not automatically resubmitted',async t=>{
  const f=await appFixture(t);
  await f.submit(story);
  f.failures.set('/api/archive',[new Error('connection lost after submission')]);
  await f.click('archive-btn',{navigation:true});
  assert.equal(f.calls.filter(c=>c.path==='/api/archive').length,1);
  assert.equal(f.calls.filter(c=>c.path==='/api/archive-status').length,0);
  assert.match(f.ids('notification').textContent,/1 طلبًا دون تأكيد/);
});

test('reloading to continue a saved author cursor authorizes again; tickets are never persisted',async t=>{
  const f=await appFixture(t,{search:'?continue=1',savedProgress:{source:author,mode:'author',nextCursor:{pageUrl:author,offset:45},archived:{}}});
  assert.equal(f.counts().inspect,1);
  assert.equal(f.ids('results').hidden,false);
  assert.equal(f.calls.find(c=>c.path==='/api/inspect').data.cursor.offset,45);
  assert.ok(![...f.storage.values()].join('').includes('ticket-'));
});

test('a failed archive challenge leaves Word usable and a later archive click can retry',async t=>{
  const f=await appFixture(t);
  await f.submit(story);
  f.outcome='error';
  await f.click('archive-btn');
  assert.equal(f.calls.filter(c=>c.path==='/api/archive').length,0);
  await f.click('download-btn');
  assert.equal(f.downloads.length,1);
  await f.click('archive-btn',{navigation:true});
  assert.equal(f.calls.filter(c=>c.path==='/api/archive').length,1);
  assert.deepEqual(f.counts(),{inspect:1,archive:1});
});

test('persistent archive auth failure stops the unsent remainder instead of prompting for each URL',async t=>{
  const f=await appFixture(t);
  await f.submit(author);
  f.failures.set('/api/archive',Array.from({length:2},()=>({status:403,data:{error:'تصريح مرفوض',code:'ARCHIVE_AUTH_REQUIRED'}})));
  await f.click('archive-btn',{navigation:true});
  assert.equal(f.calls.filter(c=>c.path==='/api/archive').length,2);
  assert.equal(f.calls.filter(c=>c.path==='/api/archive-status').length,0);
  assert.equal(f.counts().archive,2);
  assert.match(f.ids('notification').textContent,/تعذّرت أرشفة 2/);
});
