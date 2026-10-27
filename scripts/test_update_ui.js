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
const voicePanel = fs.readFileSync(root+'/js/pet-voices.js','utf8');
const updateFunction = voicePanel.slice(voicePanel.indexOf('  function updatePresentation('),voicePanel.indexOf('  function renderMenu('));
const updateContext={};vm.runInNewContext(updateFunction,updateContext);
const initial=vm.runInNewContext('('+companion.match(/let updateState = (.*);/)[1]+')', {BUNDLED_VERSION:'2.4.5'});
for(const [label,update,command,disabled] of [
  ['initial',initial,'update-check',false],
  ['checked',{...initial,checked:true},'update-check',false],
  ['available',{...initial,available:true,latest:'2.6.3'},'update-apply',false],
  ['applying',{...initial,applying:true},'',true],
  ['failed',{...initial,error:'unreachable'},'update-check',false],
  ['retry install',{...initial,error:'download failed',available:true},'update-apply',false],
]) {
  const view=updateContext.updatePresentation({appMode:true,version:'2.4.5',update});
  assert.equal(view.command,command);assert.equal(view.disabled,disabled);
  console.log('PASS menu update entry',label);
}
(async()=>{await pollingCase(false);await pollingCase(true);await retryCase()})().catch(error=>{console.error(error);process.exitCode=1});
