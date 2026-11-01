import test from 'node:test';
import assert from 'node:assert/strict';
import {TurnstileController, TURNSTILE_HOSTS} from '../public/turnstile-controller.js';

function mock() {
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
  const controller=new TurnstileController({getApi:()=>api,locate:id=>elements.get(id)});
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
test('subsequent verification reuses its widget and resets before execute',async()=>{
  const m=mock();
  await m.controller.execute('inspect');
  await m.controller.execute('inspect');
  assert.equal(m.seen.filter(x=>x[0]==='render').length,1);
  assert.equal(m.seen.filter(x=>x[0]==='reset').length,1);
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
