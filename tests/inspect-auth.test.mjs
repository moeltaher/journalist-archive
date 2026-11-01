import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {issueInspectTicket, validateInspectTicket, INSPECT_SESSION_MS} from '../src/inspect-auth.js';
globalThis.crypto ||= webcrypto;
const key='a-test-key-not-a-real-secret-12345';
const source='https://manassa.news/author/2631';
const now=Date.UTC(2026,10,2);
const request=(ip='203.0.113.22',agent='Browser')=>new Request('https://journalist-archive.test.workers.dev/api/inspect',{headers:{'CF-Connecting-IP':ip,'User-Agent':agent}});
test('authorized author scan and same-publisher article extraction',async()=>{
 const r=request(), v=await issueInspectTicket(key,r,source,now);
 assert.equal(Date.parse(v.expiresAt),now+INSPECT_SESSION_MS);
 assert.equal(await validateInspectTicket(key,r,v.accessTicket,source,'inspect',now+100),true);
 assert.equal(await validateInspectTicket(key,r,v.accessTicket,'https://manassa.news/stories/12345','article',now+100),true);
 assert.equal(await validateInspectTicket(key,r,v.accessTicket,'https://www.manassa.news/stories/12345','article',now+100),true);
});
test('ticket rejected for unrelated author, different publisher, expiry and tampering',async()=>{
 const r=request(), v=await issueInspectTicket(key,r,source,now),t=v.accessTicket;
 assert.equal(await validateInspectTicket(key,r,t,'https://manassa.news/author/999','inspect',now),false);
 assert.equal(await validateInspectTicket(key,r,t,'https://another.org/story/1','article',now),false);
 assert.equal(await validateInspectTicket(key,r,t,source,'inspect',now+INSPECT_SESSION_MS),false);
 assert.equal(await validateInspectTicket(key,r,t.slice(0,-5)+'wrong',source,'inspect',now),false);
 assert.equal(await validateInspectTicket(key,r,null,source,'inspect',now),false);
});
test('ticket restricted to IP, browser and operation',async()=>{
 const r=request(),t=(await issueInspectTicket(key,r,source,now)).accessTicket;
 assert.equal(await validateInspectTicket(key,request('203.0.113.23'),t,source,'inspect',now),false);
 assert.equal(await validateInspectTicket(key,request(undefined,'OtherBrowser'),t,source,'inspect',now),false);
 assert.equal(await validateInspectTicket(key,r,t,source,'archive',now),false);
});
