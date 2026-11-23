'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-shortcuts-'));
const requireRoot = createRequire(path.join(root, 'companion.js'));
const renders = [];
const shortcuts = require('../js/patrick-shortcuts');
const ctx = vm.createContext({ console, Buffer, URL, __dirname: root,
  process: {pid: process.pid, platform: process.platform, env: {
    WORDPAPER_TEST_MODE:'1', WORDPAPER_DATA_DIR:temp, WORDPAPER_COMPANION_DATA_DIR:temp,
    WORDPAPER_CONFIG_PATH:path.join(temp,'config.json'), WORDPAPER_STATE_PATH:path.join(temp,'state.json'),
    WORDPAPER_CUSTOM_WORDS_PATH:path.join(temp,'custom.json'),
  }},
  require: name => name === 'child_process' ? {execFile(...args){renders.push(args);return {kill(){}};}} : requireRoot(name),
  setTimeout:()=>({unref(){}}),clearTimeout(){},setInterval:()=>({unref(){}}),clearInterval(){},
});
const source = fs.readFileSync(path.join(root,'companion.js'),'utf8');
vm.runInContext(source.slice(0,source.indexOf('const server = http.createServer(')),ctx);
const run = code => vm.runInContext(code,ctx);
const db = new DatabaseSync(':memory:'); ctx.testDb = db;
db.exec(`CREATE TABLE users(id INTEGER); INSERT INTO users VALUES(1),(2);
  CREATE TABLE user_state(user_id INTEGER, namespace TEXT, value_json TEXT, revision INTEGER, updated_at INTEGER);
  CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);`);
run(`openSrsDb=()=>({prepare:(...args)=>testDb.prepare(...args),exec:(...args)=>testDb.exec(...args),close(){}});
  CFG.srsUserId=1; CFG.library='custom'; CFG.petMode='patrick'; featureOn=()=>true; patrickVisible=true;
  ttsPrewarm=()=>{}; speechAudio.prepare=()=>{}; playSfx=()=>{}; scheduleStatusBubble=()=>{};
  syncWallpaperToPet=()=>{}; petFirstPassWords=()=>[{word:'alpha',meaning:'首位'}, {word:'beta',meaning:'次位'}];
  refreshPetInPlace=(before,after,done)=>done();
  examplesCache.custom={alpha:['An alpha example! 第一个例句。','Another alpha example? 第二个例句。']};
  state.petMemoryEvents=[];`);
let passed=0;
function send(payload) {
  ctx.payload=payload; let status, body;
  ctx.response={writeHead(code){status=code;},end(value){body=JSON.parse(value);}};
  run('handlePatrickShortcut(payload,response)'); return {status,body};
}
function test(name,fn){fn();passed++;console.log('PASS',name);}
function offer(word='alpha', extra={}) {
  ctx.word={word,meaning:word==='alpha'?'首位':'次位',...extra};
  run("clearQuizCard(); offerQuiz([word],'custom',1)");
  return run('displayedQuiz.id');
}
try {
  test('ASDF defaults, modifiers, contextual reuse and key conflicts share one definition',()=>{
    const bindings=shortcuts.normalize({});
    assert.deepEqual([0,1,2,3].map(code=>shortcuts.actionFor(bindings,code,0,'study')),['answer0','answer1','answer2','answer3']);
    assert.equal(shortcuts.actionFor(bindings,123,0,'study'),'example-prev');
    assert.equal(shortcuts.actionFor(bindings,123,1,'roam'),'moveLeft');
    assert.equal(shortcuts.actionFor(bindings,51,8,'study'),'');
    assert.equal(shortcuts.validate({...bindings,answer0:{code:'KeyS',mods:0}}).ok,false);
    assert.equal(shortcuts.validate({...bindings,chat:{code:'KeyS',mods:0}}).ok,false);
    assert.equal(shortcuts.validate({...bindings,answer0:{code:'KeyJ',mods:2}}).ok,true);
    assert.equal(shortcuts.validate({...bindings,answer0:{code:'KeyQ',mods:8}}).ok,false);
    assert.equal(shortcuts.validate({...bindings,answer0:{code:'bad',mods:0}}).ok,false);
    const custom=shortcuts.normalize({...bindings,answer0:{code:'KeyJ',mods:2}});
    assert.equal(shortcuts.actionFor(custom,38,2,'study'),'answer0');
    assert.equal(shortcuts.actionFor(custom,0,0,'study'),'');
    assert.equal(shortcuts.validate({...bindings,next:{code:'Delete',mods:0}}).ok,false,'forward delete alias must also conflict');
  });
  test('Delete directly masters a fresh word without adding practice or review rounds',()=>{
    const id=offer();
    assert.equal(send({action:'remember',quizId:id}).body.ok,true);
    const item=run("readReviewState(testDb,1).custom.words['alpha|首位']");
    assert.equal(item.stage,8);assert.equal(item.learnedCount,0);
    assert.equal(item.due,null);assert.equal(item.manualMastered,true);
    assert.equal(item.reviewCount,0);assert.equal(item.events.at(-1).type,"manual-mastered");
    assert.equal(run("displayedQuiz.manualMastered"),true);
    assert.equal(run("srsDueWords(testDb,1,'custom').length"),0);
    const count=run('state.petMemoryEvents.length');
    assert.equal(send({action:'remember',quizId:id}).body.duplicate,true);
    const next=offer('beta');
    assert.equal(send({action:'remember',quizId:id}).status,409);
    assert.equal(run('displayedQuiz.id'),next);
    assert.equal(run('state.petMemoryEvents.length'),count);
  });
  test('Delete cancels an existing review schedule, preserves counters, and is account scoped',()=>{
    const now=Date.now(); ctx.now=now;
    run(`writeReviewState(testDb,1,{custom:{words:{'alpha|首位':{
      word:{word:'alpha',meaning:'首位'},stage:2,due:now-1000,reviewCount:3,learnedCount:1
    }}}});`);
    const id=offer('alpha',{stage:2,due:now-1000});
    assert.equal(send({action:'remember',quizId:id}).body.mastered,true);
    const item=run("readReviewState(testDb,1).custom.words['alpha|首位']");
    assert.equal(item.stage,8);assert.equal(item.reviewCount,3);assert.equal(item.due,null);
    const next=offer('beta');run('CFG.srsUserId=2');
    assert.equal(send({action:'remember',quizId:next}).body.error,'stale-account');
    run('CFG.srsUserId=1');
  });
  test('Enter immediately selects another eligible word without recording skipped learning',()=>{
    run('writeReviewState(testDb,1,{})');
    const id=offer();const count=run('state.petMemoryEvents.length');
    const result=send({action:'next',quizId:id});
    assert.equal(result.body.offered,true);assert.equal(run('displayedQuiz.word.word'),'beta');
    assert.equal(run('state.petMemoryEvents.length'),count);
    assert.equal(send({action:'next',quizId:id}).status,409);
    assert.equal(run('displayedQuiz.hold'),true);
  });
  test('example arrows end at an AI choice and left returns without changing word identity',()=>{
    const id=offer();
    assert.equal(send({action:'replay',quizId:id}).body.exampleIndex,0);
    const first=run('speakCardState.id');
    assert.equal(send({action:'example-next',quizId:id}).body.exampleIndex,1);
    assert.equal(run('speakCardState.example.en'),'Another alpha example?');
    assert.equal(run('speakCardState.example.zh'),'第二个例句。');
    assert.equal(run('startSpeakCardAudio('+JSON.stringify(first)+')'),false);
    const choice=send({action:'example-next',quizId:id}).body;
    assert.equal(choice.exampleIndex,2);assert.equal(choice.exampleChoice,true);
    assert.equal(run('speakCardState.examplePending'),false);
    assert.equal(run('speakCardState.example'),null);
    assert.equal(send({action:'example-prev',quizId:id}).body.exampleIndex,1);
    assert.equal(send({action:'replay',quizId:id}).body.exampleIndex,1);
    assert.equal(run('displayedQuiz.id'),id);
  });
  test('zero and single examples stay usable, repeated examples are deduplicated',()=>{
    run("examplesCache.custom.beta=[]");
    const id=offer('beta');assert.equal(send({action:'example-next',quizId:id}).body.exampleCount,0);
    assert.equal(run('speakCardState.example'),null);
    run("examplesCache.custom.beta=['A beta example. 例句。','A beta example. 例句。']");
    send({action:'example-prev',quizId:id});
    assert.equal(send({action:'example-prev',quizId:id}).body.exampleIndex,0);
    assert.equal(run('speakCardState.exampleCount'),1);
  });
  test('answer keys expand truncated answers before answering and hold the result',()=>{
    const id=offer();
    run('displayedQuiz.geom={collapsedOptions:[true,false,false,false]}');
    const count=run('state.petMemoryEvents.length');
    assert.equal(send({action:'answer',quizId:id,picked:0}).body.expanded,true);
    assert.equal(run('state.petMemoryEvents.length'),count);
    run('displayedQuiz.geom={collapsedOptions:[]}');
    assert.equal(send({action:'answer',quizId:id,picked:0}).body.ok,true);
    assert.equal(run('displayedQuiz.hold'),true);
    assert.equal(run('state.petMemoryEvents.length'),count+1);
  });
  test('Escape stops speech without recording, and editing windows reject delayed shortcuts',()=>{
    const id=offer();send({action:'replay',quizId:id});
    const count=run('state.petMemoryEvents.length');
    run('sentenceWinChild={}');assert.equal(send({action:'remember',quizId:id}).body.error,'editing');
    run('sentenceWinChild=null');assert.equal(send({action:'dismiss',quizId:id}).body.ok,true);
    assert.equal(run('speakCardState'),null);assert.equal(run('displayedQuiz'),null);
    assert.equal(run('state.petMemoryEvents.length'),count);
  });
  test('empty next selection ends cleanly and does not reoffer the skipped only word',()=>{
    run("writeReviewState(testDb,1,{});petFirstPassWords=()=>[{word:'alpha',meaning:'首位'}]");
    const id=offer();assert.equal(send({action:'next',quizId:id}).body.empty,true);
    assert.equal(run('displayedQuiz'),null);
  });
  test('speech-only shortcuts require the actual page key and cannot mark a replacement',()=>{
    assert.equal(send({action:'remember',wordKey:'wrong',index:0}).status,409);
    assert.equal(send({action:'example-next',wordKey:'alpha|首位',index:0,exampleIndex:0}).body.exampleIndex,1);
    run("petFirstPassWords=()=>[{word:'beta',meaning:'次位'}]");
    assert.equal(send({action:'remember',wordKey:'alpha|首位',index:0}).status,409);
  });
  const native=run('buildPatrickJXA({W:190,H:206,words:[],keys:[],frameNames:PATRICK_FRAME,dark:true})');
  new vm.Script(native);
  if(process.argv[2]==='--fixtures') {
    const out=path.resolve(process.argv[3]);fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,'patrick.jxa.js'),native);
  }
  console.log(`${passed} shortcut checks passed`);
} finally {db.close();fs.rmSync(temp,{recursive:true,force:true});}
