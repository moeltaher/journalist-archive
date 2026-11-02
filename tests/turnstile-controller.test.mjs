import test from 'node:test';
import assert from 'node:assert/strict';
import {TurnstileController, TURNSTILE_HOSTS} from '../public/turnstile-controller.js';

function mock(options={}) {
  const seen=[];
  const widgets=new Map();
  const containers=Object.values(TURNSTILE_HOSTS).map(id=>[id,{isConnected:true,closest:()=>null}]);
  const elements=new Map(containers);
  const api={
    render(selector,options){
      seen.push(['render',selector,options.action,options.sitekey]);
      assert.equal(selector[0],'#');
      assert.ok(elements.has(selector.slice(1)));
      const id='widget-'+widgets.size;
      widgets.set(id,{selector,options});
      return id;
    },
    execute(id) {
      seen.push(['execute',id]);
      widgets.get(id).options.callback('token-'+widgets.get(id).options.action);
    },
    reset(id){seen.push(['reset',id]);},
    remove(id){seen.push(['remove',id]);}
  };
  const controller=new TurnstileController({getApi:()=>api,locate:id=>elements.get(id),...options});
  controller.setSiteKey('public-test-sitekey');
  return {controller,seen,widgets,elements,api};
}
test('inspection verifies in visible form using a #selector, without rendering archive widget',async()=>{
  const m=mock();
  assert.equal(m.widgets.size,0);
  assert.equal(await m.controller.execute('inspect'),'token-inspect');
  assert.deepEqual(m.seen.slice(0,2),[
    ['render','#inspect-turnstile-widget','inspect','public-test-sitekey'],
    ['execute','widget-0']
  ]);
  assert.equal(m.widgets.size,1);
});
test('archive has an independent widget with its own Turnstile action',async()=>{
  const m=mock();
  await m.controller.execute('inspect');
  assert.equal(await m.controller.execute('archive'),'token-archive');
  assert.deepEqual(m.seen.filter(x=>x[0]==='render').map(x=>[x[1],x[2]]),
    [['#inspect-turnstile-widget','inspect'],['#archive-turnstile-widget','archive']]);
});
test('subsequent verification removes the old widget and creates a fresh challenge',async()=>{
  const m=mock();
  await m.controller.execute('inspect');
  await m.controller.execute('inspect');
  assert.equal(m.seen.filter(x=>x[0]==='render').length,2);
  assert.equal(m.seen.filter(x=>x[0]==='remove').length,1);
});
test('missing or hidden verification host is rejected before creating a widget',()=>{
  const m=mock();
  m.elements.delete(TURNSTILE_HOSTS.inspect);
  assert.throws(()=>m.controller.execute('inspect'),/موضع اختبار/);
  assert.equal(m.widgets.size,0);
  const n=mock();
  n.elements.set(TURNSTILE_HOSTS.inspect,{isConnected:true,closest:()=>({hidden:true})});
  assert.throws(()=>n.controller.execute('inspect'),/موضع اختبار/);
});
test('changing the public site key removes old widgets before next challenge',async()=>{
  const m=mock();
  await m.controller.execute('inspect');
  m.controller.setSiteKey('another-test-key');
  assert.equal(m.seen.filter(x=>x[0]==='remove').length,1);
  await m.controller.execute('archive');
  assert.equal(m.seen.filter(x=>x[0]==='render').at(-1)[3],'another-test-key');
});

test('interactive timeout rejects promptly and permits another attempt', async()=>{
  const m=mock();
  m.api.execute=()=>{};
  const pending=m.controller.execute('inspect');
  const rejected=assert.rejects(pending,/مهلة|انته/);
  const options=m.widgets.get('widget-0').options;
  assert.equal(typeof options['timeout-callback'],'function');
  options['timeout-callback']();
  await rejected;
  m.api.execute=id=>m.widgets.get(id).options.callback('fresh-token');
  assert.equal(await m.controller.execute('inspect'),'fresh-token');
});

test('a late callback from a failed challenge cannot finish a new attempt', async()=>{
  const m=mock();
  m.api.execute=()=>{};
  const first=m.controller.execute('inspect');
  const rejected=assert.rejects(first,/فشل/);
  const old=m.widgets.get('widget-0').options;
  old['error-callback']();
  await rejected;
  const second=m.controller.execute('inspect');
  old.callback('stale-consumed-token');
  const current=[...m.widgets.values()].at(-1).options;
  current.callback('new-token');
  assert.equal(await second,'new-token');
});

test('render-time failures settle the pending operation', async()=>{
  const m=mock();
  m.api.render=(selector,options)=>{options['error-callback']();return 'broken-widget';};
  m.api.execute=()=>{};
  // A synchronous callback must be observed, not leave the UI busy indefinitely.
  const result=m.controller.execute('inspect');
  assert.equal(m.controller.pending.size,0);
  await assert.rejects(result,/فشل/);
});

test('no callback is bounded by a timer, cleared on success and failure',async()=>{
  const timers=new Map();let sequence=0;
  const m=mock({setTimer:fn=>{timers.set(++sequence,fn);return sequence;},clearTimer:id=>timers.delete(id)});
  await m.controller.execute('inspect');
  assert.equal(timers.size,0);
  m.api.execute=()=>{};
  const pending=m.controller.execute('inspect');
  const rejected=assert.rejects(pending,/مهلة/);
  [...timers.values()][0]();
  await rejected;
  assert.equal(m.controller.pending.size,0);
  assert.equal(timers.size,0);
});

test('pending inspect and archive challenges are isolated, while duplicate same-action calls are blocked',async()=>{
  const m=mock();m.api.execute=()=>{};
  const inspect=m.controller.execute('inspect'),archive=m.controller.execute('archive');
  assert.throws(()=>m.controller.execute('inspect'),/جارٍ/);
  m.widgets.get('widget-1').options.callback('archive-token');
  assert.equal(await archive,'archive-token');
  assert.equal(m.controller.pending.size,1);
  m.widgets.get('widget-0').options.callback('inspect-token');
  assert.equal(await inspect,'inspect-token');
});

test('key rotation rejects pending verification and ignores the old callback',async()=>{
  const m=mock();m.api.execute=()=>{};
  const first=m.controller.execute('inspect');
  const rejected=assert.rejects(first,/تغيّرت/);
  const old=m.widgets.get('widget-0').options;
  m.controller.setSiteKey('rotated-site-key');
  await rejected;
  const next=m.controller.execute('inspect');
  old.callback('old-token');
  m.widgets.get('widget-1').options.callback('rotated-token');
  assert.equal(await next,'rotated-token');
});

test('expiry and unsupported-browser callbacks release the operation',async()=>{
  for(const callback of ['expired-callback','unsupported-callback']) {
    const m=mock();m.api.execute=()=>{};
    const pending=m.controller.execute('inspect');
    const rejected=assert.rejects(pending);
    m.widgets.get('widget-0').options[callback]();
    await rejected;
    assert.equal(m.controller.pending.size,0);
  }
});

test('empty tokens and API exceptions do not poison subsequent attempts',async()=>{
  const m=mock();
  m.api.execute=id=>m.widgets.get(id).options.callback('');
  await assert.rejects(m.controller.execute('inspect'),/رمز تحقق صالح/);
  m.api.execute=()=>{throw new Error('execute failed');};
  await assert.rejects(m.controller.execute('inspect'),/execute failed/);
  m.api.execute=id=>m.widgets.get(id).options.callback('fresh');
  assert.equal(await m.controller.execute('inspect'),'fresh');
});

test('missing library, site key and unsupported action fail before creating widgets',()=>{
  const m=mock();
  assert.throws(()=>m.controller.execute('other'),/غير مدعومة/);
  m.controller.setSiteKey('');
  assert.throws(()=>m.controller.execute('inspect'),/لم يتم إعداد/);
  m.controller.setSiteKey('key');m.api.render=null;
  assert.throws(()=>m.controller.execute('inspect'),/لم تُحمّل/);
  assert.equal(m.widgets.size,0);
});

test('browser timer APIs are not invoked with the controller as their receiver',async()=>{
  const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
  globalThis.setTimeout=function(...args){
    assert.ok(this===undefined||this===globalThis,'Illegal invocation of window.setTimeout');
    return oldSet(...args);
  };
  globalThis.clearTimeout=function(...args){
    assert.ok(this===undefined||this===globalThis,'Illegal invocation of window.clearTimeout');
    return oldClear(...args);
  };
  try {assert.equal(await mock().controller.execute('inspect'),'token-inspect');}
  finally {globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});

test('a stale widget removal error does not prevent a fresh verification',async()=>{
  const m=mock();
  await m.controller.execute('inspect');
  m.api.remove=()=>{throw new Error('unknown widget');};
  assert.equal(await m.controller.execute('inspect'),'token-inspect');
  assert.equal(m.widgets.size,2);
});
