import {Miniflare, Response} from 'miniflare';
import {build} from 'esbuild';
import {createHmac} from 'node:crypto';

export const ORIGIN='https://archive.example.org';
export const SOURCE='https://news.example.org/author/reporter';
export const STORY='https://news.example.org/stories/1000';
export const SECRET='fixture-secret-not-for-production-12345';
export const bodyText='هذا نص تجريبي لاختبار استخراج المقالات وحفظها في ملف وورد، مع التحقق من أن الحماية الأمنية تسمح بالوصول بعد اجتياز الاختبار وتحافظ على إمكانية متابعة العمل بعد انتهاء التصريح.';
const html=body=>new Response(`<html><head><meta charset="utf-8"></head><body>${body}</body></html>`,{headers:{'Content-Type':'text/html;charset=utf-8'}});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

export function signTicket(ticket,changes,prefix) {
  const payload=JSON.parse(Buffer.from(ticket.split('.')[0],'base64url'));
  const encoded=Buffer.from(JSON.stringify({...payload,...changes})).toString('base64url');
  return encoded+'.'+createHmac('sha256',SECRET).update(prefix+encoded).digest('base64url');
}

export async function workerFixture() {
  const seen=[],used=new Set();
  let serial=0;
  const bundle=await build({entryPoints:[new URL('../../src/worker.js',import.meta.url).pathname],
    bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
  const mf=new Miniflare({
    modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',cf:false,
    bindings:{TURNSTILE_SITE_KEY:'fixture-public-key',TURNSTILE_SECRET_KEY:SECRET,
      IA_ACCESS_KEY:'fixture-ia-key',IA_SECRET_KEY:'fixture-ia-secret'},
    durableObjects:{ARCHIVE_QUOTA:{className:'ArchiveQuota',useSQLite:true}},
    outboundService:async request=>{
      const url=new URL(request.url);
      seen.push({url:request.url,method:request.method});
      if(url.hostname==='challenges.cloudflare.com') {
        const body=await request.json();
        const token=body.response;
        if(token==='network-failure')return new Response('Unavailable',{status:503});
        if(token==='malformed-json')return new Response('{bad json');
        if(token==='no-response') {
          await new Promise(resolve=>setTimeout(resolve,16000));
          return json({success:false});
        }
        if(token==='expired-token'||used.has(token))return json({success:false,'error-codes':['timeout-or-duplicate']});
        used.add(token);
        return json({success:true,hostname:token==='wrong-hostname'?'other.example.org':new URL(ORIGIN).hostname,
          action:token.startsWith('inspect')?'inspect':'archive'});
      }
      if(url.hostname==='news.example.org') {
        if(url.pathname==='/author/reporter') {
          const page2=url.searchParams.get('page')==='2';
          const links=Array.from({length:page2?2:50},(_,i)=>{
            const n=1000+i+(page2?50:0);
            return `<article><a href="/stories/${n}">عنوان مقال صحفي تجريبي محفوظ ${n}</a></article>`;
          }).join('');
          return html(`<h1>مقالات الكاتب</h1>${links}${page2?'':'<a rel="next" href="?page=2">التالي</a>'}`);
        }
        if(url.pathname.startsWith('/stories/'))return html(`<meta property="og:type" content="article"><h1>عنوان المقال الصحفي</h1><article><p>${bodyText}</p></article>`);
      }
      if(url.hostname==='web.archive.org') {
        if(url.pathname==='/save'&&request.method==='POST')return json({job_id:'fixture-job-12345'});
        if(url.pathname==='/save/status/fixture-job-12345')return json({status:'success',timestamp:'20261102010000',original_url:STORY});
      }
      // All outbound traffic is intercepted. A fixture miss must never use the network.
      throw new Error('Unexpected external request in offline test: '+request.url);
    }
  });
  const post=async(path,data,headers={})=>{
    const response=await mf.dispatchFetch(ORIGIN+path,{method:'POST',headers:{'Content-Type':'application/json',
      Origin:ORIGIN,'User-Agent':'FixtureBrowser','CF-Connecting-IP':'203.0.113.22',...headers},body:JSON.stringify(data)});
    return {status:response.status,data:await response.json()};
  };
  const authorize=async(action='inspect',urls=[STORY])=>post(`/api/${action}-authorize`,
    action==='inspect'?{url:urls[0],token:`inspect-${++serial}`}:{urls,token:`archive-${++serial}`});
  return {mf,post,authorize,seen,close:()=>mf.dispose()};
}
