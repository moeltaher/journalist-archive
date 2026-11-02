import {parseHTML} from 'linkedom';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

let sequence=0;
export async function appFixture(t,{savedProgress=null,search=''}={}) {
  const {document,window:dom}=parseHTML(await readFile(new URL('../../public/index.html',import.meta.url),'utf8'));
  dom.HTMLElement.prototype.scrollIntoView=function(){};
  const ids=id=>document.getElementById(id);
  // linkedom implements selection incompletely; keep the select's value writable.
  Object.defineProperty(ids('page-mode'),'value',{value:'auto',writable:true});
  const storage=new Map();
  if(savedProgress)storage.set('journalist-archive-progress-v2',JSON.stringify(savedProgress));
  const calls=[],widgets=[],downloads=[],timers=new Map(),failures=new Map(),invalidInspect=new Set(),invalidArchive=new Set();
  let clock=Date.UTC(2026,10,2),inspectCount=0,archiveCount=0,tokenCount=0,timerId=0;
  const f={document,dom,ids,calls,widgets,downloads,storage,invalidInspect,invalidArchive,failures,
    outcome:'success',navigation:null,archiveSleepJump:0,clock:()=>clock,advance:ms=>clock+=ms,
    counts:()=>({inspect:inspectCount,archive:archiveCount}),timers};
  const globals=['document','window','localStorage','fetch','setTimeout','clearTimeout'];
  const originals=new Map(globals.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const oldNow=Date.now,oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
  t.after(()=>{
    for(const [name,descriptor] of originals)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
    Date.now=oldNow;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;
  });
  Date.now=()=>clock;
  globalThis.setTimeout=(fn,ms,...args)=>{
    const id=++timerId;
    if(ms===6000||ms===17000) {
      setImmediate(()=>{clock+=f.archiveSleepJump||ms;f.archiveSleepJump=0;fn(...args);});
    } else if(ms!==60000) timers.set(id,{fn:()=>fn(...args),ms});
    return id;
  };
  globalThis.clearTimeout=id=>timers.delete(id);
  URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:fixture';};
  URL.revokeObjectURL=()=>{};
  globalThis.document=document;
  globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
  globalThis.window={location:{search,assign:path=>f.navigation=path},history:{replaceState(){}},turnstile:{
    render(selector,options) {
      const host=document.querySelector(selector);
      assert.ok(host,'Turnstile CSS selector must match the actual HTML');
      assert.equal(host.closest('[hidden]'),null,'Turnstile must be visible');
      const id=widgets.length;widgets.push({selector,options,removed:false});return id;
    },
    remove:id=>widgets[id].removed=true,
    execute:id=>{
      const options=widgets[id].options;
      const outcome=f.outcome;f.outcome='success';
      if(outcome==='hang')return;
      if(outcome==='error')return options['error-callback']();
      if(outcome==='timeout')return options['timeout-callback']();
      options.callback(`${options.action}-token-${++tokenCount}`);
    }
  }};
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  globalThis.fetch=async(path,options={})=>{
    const data=options.body?JSON.parse(options.body):null;
    calls.push({path,data});
    const queued=failures.get(path);
    if(queued?.length) {
      const next=queued.shift();
      if(next instanceof Error)throw next;
      return json(next.data,next.status);
    }
    if(path==='/api/status')return json({archiveConfigured:true,turnstileConfigured:true,turnstileSiteConfigured:true,
      turnstileSecretConfigured:true,turnstileSiteKey:'fixture-public-key'});
    if(path==='/api/inspect-authorize') {
      assert.match(data.token,/^inspect-token-/);
      return json({accessTicket:`inspect-ticket-${++inspectCount}`,expiresAt:new Date(clock+3600000).toISOString()});
    }
    if(path==='/api/archive-authorize') {
      assert.match(data.token,/^archive-token-/);
      return json({ticket:`archive-ticket-${++archiveCount}`,expiresAt:new Date(clock+1800000).toISOString()});
    }
    if(['/api/inspect','/api/article'].includes(path)) {
      assert.ok(data.accessTicket);
      if(invalidInspect.has(data.accessTicket))return json({error:'انتهت صلاحية التصريح',code:'INSPECT_AUTH_REQUIRED'},403);
    }
    if(['/api/archive','/api/archive-status'].includes(path)) {
      assert.ok(data.ticket);
      if(invalidArchive.has(data.ticket))return json({error:'انتهت صلاحية تصريح الأرشفة',code:'ARCHIVE_AUTH_REQUIRED'},403);
    }
    if(path==='/api/inspect') {
      const author=data.url.includes('/author/');
      const articles=(author?(data.cursor?[3]:[1,2]):[1]).map(i=>({url:`https://news.example.org/stories/${i}`,title:'عنوان المقال الصحفي '+i}));
      return json({mode:author?'author':'article',title:'أرشيف تجريبي',articles,scannedPages:1,
        nextCursor:author&&!data.cursor?{pageUrl:data.url,offset:45}:null,warnings:[]});
    }
    if(path==='/api/article')return json({url:data.url,title:'عنوان المقال الصحفي',blocks:[{type:'p',text:'النص الكامل للمقال التجريبي الذي يحفظ في الملف.'}]});
    if(path==='/api/archive')return json({jobId:'job-'+data.url.split('/').at(-1),status:'pending'});
    if(path==='/api/archive-status')return json({status:'success',archiveUrl:'https://web.archive.org/web/20261102010000/'+data.url});
    throw new Error('Unexpected application request: '+path);
  };
  f.waitFor=async predicate=>{
    for(let i=0;i<1000;i++) {if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}
    throw new Error('UI did not settle: '+ids('notification').textContent);
  };
  f.submit=async url=>{
    ids('article-url').value=url;
    ids('lookup-form').dispatchEvent(new dom.Event('submit',{cancelable:true}));
    await f.waitFor(()=>!ids('analyze-btn').disabled);
  };
  f.click=async(id,{navigation=false}={})=>{
    ids(id).dispatchEvent(new dom.Event('click'));
    await f.waitFor(()=>navigation?f.navigation:!ids('analyze-btn').disabled);
  };
  await import(`../../public/app.js?fixture=${++sequence}`);
  await f.waitFor(()=>!ids('archive-note').textContent.includes('نفحص'));
  if(search)await f.waitFor(()=>!ids('analyze-btn').disabled);
  return f;
}
