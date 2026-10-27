const fs = require('fs');
const vm = require('vm');
const root = require('path').resolve(__dirname, '..');
const assert = require('assert/strict');
const app = fs.readFileSync(root+'/js/app.js','utf8');
const companion = fs.readFileSync(root+'/companion.js','utf8');
const bind = app.slice(app.indexOf('  async function bindUpdateUI()'), app.indexOf('  function bindPersistenceUI()'));
async function pollingCase(outage) {
  const nodes = {}; let click, tick, stopped=false, reloads=0, checks=0, phase='before';
  for(const key of ['#update-row','#btn-update','#update-status','#btn-update-badge']) nodes[key]={addEventListener:(ev,fn)=>{click=fn},scrollIntoView(){}};
  const ctx = { AbortSignal, $:sel=>nodes[sel], window:{Store:{csrfToken:()=>''},location:{reload:()=>reloads++}}, toast:()=>{}, updatePolling:null,
    setInterval:fn=>{tick=fn;return 1},clearInterval:()=>{stopped=true},setTimeout:fn=>fn(),
    fetch:async url=>{
      if(phase==='outage') throw new Error('server restarting');
      let value;
      if(url.includes('/check')) { checks++; value={supported:true,available:phase==='before',latest:'2.4.5',current:phase==='after'?'2.4.5':'2.4.4'}; }
      else if(url.includes('/apply')) value={ok:true,started:true,target:'2.4.5'};
      else value={applying:false,error:'',current:phase==='after'?'2.4.5':'2.4.4',target:''};
      return {ok:true,json:async()=>value};
    }};
  vm.createContext(ctx); vm.runInContext(bind,ctx); await ctx.bindUpdateUI(); await click(); stopped=false;
  if(outage){phase='outage';await tick();}
  phase='after'; for(let n=0;n<362 && !stopped;n++) await tick();
  assert.equal(reloads, 1, 'successful update must reload after reconnect or fast restart');
  assert.match(nodes['#update-status'].textContent, /已更新到/);
  console.log('PASS successful update', outage ? 'after outage' : 'fast restart');
}
async function retryCase() {
  const nodes = {}; let click, tick, failed = false, checks = 0, applies = 0;
  for (const key of ['#update-row', '#btn-update', '#update-status', '#btn-update-badge']) nodes[key] = { addEventListener: (event, fn) => { click = fn; }, scrollIntoView() {} };
  const ctx = { AbortSignal, $: selector => nodes[selector], window: { Store: { csrfToken: () => '' }, location: { reload() {} } },
    toast() {}, updatePolling: null, setInterval: fn => { tick = fn; return 1; }, clearInterval() {}, setTimeout: fn => fn(),
    fetch: async url => {
      let value;
      if (url.includes('/check')) { checks++; value = { supported: true, checked: true, available: true, current: '2.6.1', latest: checks > 1 ? '2.6.3' : '2.6.2' }; }
      else if (url.includes('/apply')) { applies++; value = { started: true, target: checks > 1 ? '2.6.3' : '2.6.2' }; }
      else value = { applying: false, error: failed ? '版本信息已变化，请重新检查更新' : '', current: '2.6.1' };
      return { ok: true, json: async () => value };
    } };
  vm.createContext(ctx); vm.runInContext(bind, ctx); await ctx.bindUpdateUI(); await click();
  failed = true; await tick();
  assert.equal(nodes['#btn-update'].disabled, false);
  await click();
  assert.equal(checks, 2, 'retry must refresh release metadata before installing');
  assert.equal(applies, 2, 'one retry click installs the newly discovered release');
  console.log('PASS failed update retry refreshes release metadata');
}
const build = companion.slice(companion.indexOf('function buildMenuBarJXA('),companion.indexOf('let menuBarChild = null;'));
const ctx={};vm.createContext(ctx);vm.runInContext(build,ctx);const jxa=ctx.buildMenuBarJXA(12345,9999);
const menu=jxa.slice(jxa.indexOf('      var menu = $.NSMenu.alloc.init;'),jxa.indexOf('      item.menu = menu;')+'      item.menu = menu;'.length);
const initial=vm.runInNewContext('('+companion.match(/let updateState = (.*);/)[1]+')', {BUNDLED_VERSION:'2.4.5'});
for(const [label,update] of [['initial',initial],['checked',{...initial,current:'2.4.5',checked:true}]]){
  const titles=[]; const sandbox={$:{NSMenu:{alloc:{init:{setAutoenablesItems(){}}}}}, st:{ok:true,appMode:true,version:'2.4.5',pet:true,web:'http://localhost:8770',update},item:{},addItem:(m,t,c)=>titles.push({title:t,command:c}),sep:()=>{}};
  vm.runInNewContext(menu,sandbox);
  assert(titles.some(t=>t.command==='update-check'), 'check update must remain actionable: '+label);
  console.log('PASS menu update entry',label);
}
(async()=>{await pollingCase(false);await pollingCase(true);await retryCase()})().catch(error=>{console.error(error);process.exitCode=1});
