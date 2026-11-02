// Local browser QA only. Never deployed: all external services are fixtures.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {workerFixture} from './helpers/worker-fixture.mjs';
const fixture=await workerFixture();
const publicRoot=new URL('../public/',import.meta.url).pathname;
const widgetScript=`
// Deliberately simulated Turnstile for offline browser QA.
let count=0;const widgets=new Map();
window.turnstile={
  render(selector,options){
    const host=document.querySelector(selector);
    if(!host||host.closest('[hidden]'))throw new Error('Hidden/missing widget host');
    host.textContent='اختبار محلي يحاكي التحقق — لا اتصال بـ Cloudflare';
    const id='fixture-'+(++count);widgets.set(id,{host,options});return id;
  },
  remove(id){const w=widgets.get(id);if(w)w.host.textContent='';widgets.delete(id);},
  execute(id){const {options}=widgets.get(id);options.callback(options.action+'-browser-'+Date.now()+'-'+count);}
};`;
const server=http.createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/__fixture-turnstile.js'){res.setHeader('Content-Type','text/javascript');res.end(widgetScript);return;}
    if(path.startsWith('/api/')) {
      let result;
      if(path==='/api/status') {
        const response=await fixture.mf.dispatchFetch('https://archive.example.org/api/status');
        result={status:response.status,data:await response.json()};
      } else {
        let raw='';for await(const chunk of req)raw+=chunk;
        result=await fixture.post(path,JSON.parse(raw));
      }
      res.writeHead(result.status,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify(result.data));return;
    }
    const file=resolve(publicRoot,'.'+(path==='/'?'/index.html':path));
    if(!file.startsWith(publicRoot))throw new Error('Invalid path');
    let content=await readFile(file);
    if(path==='/'||path==='/index.html') {
      content=content.toString().replace('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit','/__fixture-turnstile.js')
        .replace('<body>','<body><aside style="background:#fff0c2;padding:12px;text-align:center">معاينة اختبار محلي — Turnstile ومواقع الأخبار وInternet Archive محاكاة. لا تُرسل طلبات أرشفة حقيقية.</aside>');
    }
    res.setHeader('Content-Type',({'.html':'text/html;charset=utf-8','.js':'text/javascript','.css':'text/css'})[extname(file)]||'application/octet-stream');
    res.end(content);
  } catch(error) {res.writeHead(500);res.end(String(error.message));}
});
const portIndex=process.argv.indexOf('--port');
server.listen(Number(portIndex>=0?process.argv[portIndex+1]:process.env.PORT||5173),'0.0.0.0',()=>console.log('Offline QA preview ready'));
process.on('SIGTERM',()=>server.close(async()=>{await fixture.close();process.exit();}));
