'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { createIdleClock } = require('../lib/patrick-idle');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-idle-'));
let count = 0;
function test(name, fn) { fn(); console.log('PASS', name); count++; }
function clock(ms=0) { const c=createIdleClock({userKey:'1',elapsedMs:ms,studyAt:10});c.context({userKey:'1',studyAt:10,eligible:true});return c; }
test('phase boundaries and timer use total unstudied time', () => {
  const c=clock(299000);c.tick(1);assert.equal(c.tick(1001).phase,1);
  for(let t=2001;t<=601001;t+=1000)c.tick(t);
  assert.equal(c.snapshot().phase,2);assert.equal(c.format(),'15:00');
  assert.equal(clock(3729000).format(),'01:02:09');
});
test('sleep gaps, screen lock, and no work do not accumulate time', () => {
  const c=clock();c.tick(1);c.tick(1001);c.tick(90001);c.tick(91001,true);
  c.context({userKey:'1',studyAt:10,eligible:false});c.tick(92001);
  assert.equal(c.snapshot().elapsedMs,1000);
  c.context({userKey:'1',studyAt:10,eligible:true});c.tick(93001);
  assert.equal(c.snapshot().elapsedMs,2000);
});
test('only new learning clears the clock, repeated snapshots and restart preserve it', () => {
  const c=clock(1080000);c.context({userKey:'1',studyAt:10,eligible:true});assert.equal(c.format(),'18:00');
  const restored=createIdleClock(c.snapshot());restored.context({userKey:'1',studyAt:10,eligible:true});assert.equal(restored.format(),'18:00');
  c.context({userKey:'1',studyAt:20,eligible:true});assert.equal(c.snapshot().elapsedMs,0);
  restored.context({userKey:'2',studyAt:1,eligible:true});assert.equal(restored.snapshot().elapsedMs,0);
});
const requireRoot=createRequire(path.join(root,'companion.js'));
const ctx=vm.createContext({console,Buffer,URL,__dirname:root,
  process:{pid:process.pid,platform:process.platform,env:{WORDPAPER_TEST_MODE:'1',WORDPAPER_DATA_DIR:tmp,WORDPAPER_COMPANION_DATA_DIR:tmp}},
  require:name=>name==='child_process'?{execFile(){return {};}}:requireRoot(name),
  setTimeout:()=>({unref(){}}),clearTimeout(){},setInterval:()=>({unref(){}}),clearInterval(){}});
const source=fs.readFileSync(path.join(root,'companion.js'),'utf8');vm.runInContext(source.slice(0,source.indexOf('const server = http.createServer(')),ctx);
const run=s=>vm.runInContext(s,ctx);
const db=new DatabaseSync(':memory:');
db.exec('CREATE TABLE users(id INTEGER); INSERT INTO users VALUES(1),(2); CREATE TABLE user_state(user_id INTEGER, namespace TEXT, value_json TEXT, revision INTEGER, updated_at INTEGER)');
ctx.testDb=db;
run(`openSrsDb=()=>({prepare:(...args)=>testDb.prepare(...args),close(){}});CFG.srsUserId=1;CFG.library='custom';
  featureOn=()=>true;petFirstPassWords=()=>[{word:'hello',meaning:'你好'}];`);
test('context watches actual web learning and keeps accounts isolated',()=>{
  db.prepare('INSERT INTO user_state VALUES(?,?,?,?,?)').run(1,'review',JSON.stringify({custom:{words:{'hello|你好':{word:{word:'hello',meaning:'你好'},stage:1,due:Date.now()+60000,lastSeenAt:100}}}}),1,999);
  assert.equal(run('patrickIdleContext().studyAt'),100);assert.equal(run('patrickIdleContext().eligible'),false);
  db.prepare('UPDATE user_state SET value_json=? WHERE user_id=1').run(JSON.stringify({custom:{words:{'hello|你好':{stage:0,due:1,lastSeenAt:200}}}}));
  run('patrickIdleCache.at=0');assert.equal(run('patrickIdleContext().studyAt'),200);assert.equal(run('patrickIdleContext().eligible'),true);
  run('CFG.quizAutoStart=false;patrickIdleCache.at=0');assert.equal(run('patrickIdleContext().eligible'),false);
  run('CFG.quizAutoStart=true;CFG.srsUserId=2;patrickIdleCache.at=0');assert.equal(run('patrickIdleContext().studyAt'),0);
  run('notePatrickStudy(500,2)');assert.equal(run('patrickIdleContext().studyAt'),500);
});
const native=run('buildPatrickJXA({W:190,H:206,words:[],keys:[],frameNames:PATRICK_FRAME,dark:true})');
new vm.Script(native);
if(process.argv[2]==='--fixtures'){
  const out=path.resolve(process.argv[3]);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'patrick-idle.jxa.js'),native);
}
db.close();fs.rmSync(tmp,{recursive:true,force:true});console.log(count+' idle checks passed');
