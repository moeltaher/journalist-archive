import test from 'node:test';
import assert from 'node:assert/strict';
import {AccessSession} from '../public/access-session.js';

const authError = (code='INSPECT_AUTH_REQUIRED') => Object.assign(new Error('expired or changed network'),{status:403,code});
function setup(overrides={}) {
  let now=Date.UTC(2026,10,2), authorizations=0;
  const calls=[];
  const session=new AccessSession({
    ticketField:'accessTicket',errorCode:'INSPECT_AUTH_REQUIRED',now:()=>now,
    authorize:async scope=>({ticket:`${scope}-${++authorizations}`,expiresAt:new Date(now+3600000).toISOString()}),
    request:async(path,data)=>{calls.push({path,...data});return data;},...overrides
  });
  return {session,calls,advance:ms=>now+=ms,count:()=>authorizations};
}

test('article discovery, next batch and Word reuse a valid scoped permission',async()=>{
  const m=setup();
  await m.session.request('author','/api/inspect',{url:'author'});
  await m.session.request('author','/api/inspect',{url:'author',cursor:{offset:45}});
  await Promise.all([1,2,3].map(i=>m.session.request('author','/api/article',{url:'story'+i})));
  assert.equal(m.count(),1);
  assert.deepEqual(m.calls.map(c=>c.accessTicket),Array(5).fill('author-1'));
});

test('parallel renewal after local expiry requires just one new challenge',async()=>{
  const m=setup();
  await m.session.getTicket('author');
  m.advance(3600000);
  assert.deepEqual(await Promise.all([1,2,3].map(()=>m.session.getTicket('author'))),Array(3).fill('author-2'));
  assert.equal(m.count(),2);
});

test('network binding rejection renews once, including concurrent old-ticket failures',async()=>{
  const calls=[];
  const m=setup({request:async(path,data)=>{
    calls.push(data.accessTicket);
    if(data.accessTicket==='author-1')throw authError();
    return 'ok';
  }});
  await m.session.getTicket('author');
  assert.deepEqual(await Promise.all([1,2,3].map(()=>m.session.request('author','/api/article',{}))),['ok','ok','ok']);
  assert.equal(m.count(),2);
  assert.equal(calls.filter(t=>t==='author-2').length,3);
});

test('a late rejection of the old permission does not discard the replacement',async()=>{
  const m=setup();
  const first=await m.session.getTicket('source');
  m.session.invalidate('source',first);
  const second=await m.session.getTicket('source');
  m.session.invalidate('source',first);
  assert.equal(await m.session.getTicket('source'),second);
  assert.equal(m.count(),2);
});

test('persistent rejection stops after one retry and the next click can reauthorize',async()=>{
  const m=setup({request:async()=>{throw authError();}});
  await assert.rejects(m.session.request('source','/api/inspect',{}),/expired/);
  assert.equal(m.count(),2);
  await m.session.getTicket('source');
  assert.equal(m.count(),3);
});

test('a failed authorization is not cached and concurrent source changes stay scoped',async()=>{
  let attempts=0;
  const m=setup({authorize:async scope=>{
    if(++attempts===1)throw new Error('Turnstile failed');
    return {ticket:scope,expiresAt:'2026-11-02T01:00:00Z'};
  }});
  await assert.rejects(m.session.getTicket('a'),/Turnstile failed/);
  assert.deepEqual(await Promise.all(['a','b'].map(s=>m.session.getTicket(s))),['a','b']);
});

test('archive renewal shares a challenge between submission and status polling',async()=>{
  const m=setup({ticketField:'ticket',errorCode:'ARCHIVE_AUTH_REQUIRED'});
  await m.session.getTicket('selected-urls');
  m.advance(3600000);
  const results=await Promise.all([
    m.session.request('selected-urls','/api/archive',{url:'next-story'}),
    m.session.request('selected-urls','/api/archive-status',{url:'earlier-story',job:'job-123'})
  ]);
  assert.equal(m.count(),2);
  assert.ok(results.every(r=>r.ticket==='selected-urls-2'));
  assert.equal(results[1].job,'job-123');
});

test('archive submission is replayed only after a typed pre-submission auth rejection',async()=>{
  let submissions=0;
  const m=setup({ticketField:'ticket',errorCode:'ARCHIVE_AUTH_REQUIRED',request:async()=>{
    if(++submissions===1)throw authError('ARCHIVE_AUTH_REQUIRED');
    return {jobId:'accepted-once'};
  }});
  assert.equal((await m.session.request('urls','/api/archive',{})).jobId,'accepted-once');
  assert.equal(submissions,2);
  assert.equal(m.count(),2);
});

for(const error of [new Error('network lost'),Object.assign(new Error('upstream failure'),{status:502}),
  Object.assign(new Error('rate limit'),{status:429}),Object.assign(new Error('origin forbidden'),{status:403})]) {
  test(`no archive replay on ${error.message}`,async()=>{
    let submissions=0;
    const m=setup({ticketField:'ticket',errorCode:'ARCHIVE_AUTH_REQUIRED',request:async()=>{submissions++;throw error;}});
    await assert.rejects(m.session.request('urls','/api/archive',{}),e=>e===error);
    assert.equal(submissions,1);
    assert.equal(m.count(),1);
  });
}

test('malformed or expired authorization responses never reach an operation',async()=>{
  for(const result of [{},{ticket:'x'},{ticket:'x',expiresAt:'invalid'},{ticket:'x',expiresAt:'2020-01-01'}]) {
    const m=setup({authorize:async()=>result});
    await assert.rejects(m.session.request('source','/api/article',{}),/تصريح صالح/);
    assert.equal(m.calls.length,0);
  }
});
