'use strict';

// Real companion logic with controlled rasterizer/audio completions. Never opens
// the user's companion, changes wallpaper, or reads/writes their learning data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-speech-test-'));
const requireRoot = createRequire(path.join(root, 'companion.js'));
const renders = [], audio = [];
const ctx = vm.createContext({
  console, Buffer, URL, __dirname: root,
  process: { pid: process.pid, platform: process.platform, env: {
    WORDPAPER_TEST_MODE: '1', WORDPAPER_COMPANION_DATA_DIR: temp, WORDPAPER_DATA_DIR: temp,
    WORDPAPER_STATE_PATH: path.join(temp, 'state.json'), WORDPAPER_CONFIG_PATH: path.join(temp, 'config.json'),
    WORDPAPER_CUSTOM_WORDS_PATH: path.join(temp, 'custom.json'),
  } },
  require: name => name === 'child_process' ? { execFile: (...args) => { renders.push(args); return { kill() {} }; } } : requireRoot(name),
  setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
  recordPrepare: (text, voiceId, cb) => {
    audio.push({text,voiceId});
    cb(null,{file:path.join(temp,voiceId+'.mp3'),cues:[{start:.1,end:.4,from:0,to:text.split(' ')[0].length}],fallback:false});
  },
});
const source = fs.readFileSync(path.join(root, 'companion.js'), 'utf8');
vm.runInContext(source.slice(0, source.indexOf('const server = http.createServer(')), ctx);
const run = code => vm.runInContext(code, ctx);
run(`speechAudio.prepare = recordPrepare; patrickVisible = true; CFG.library = 'cet4';
  petFirstPassWords = () => [{word:'WRONG PAGE WORD',meaning:'不应读这个词'}];`);
let passed = 0;
function reset(example = 'We plunge into the water together.') {
  ctx.example = example;
  run(`ttsStopNow(); patrickCmds.length=0; CFG.speechVoice='aria';
    displayedQuiz = patrickQuizState = { id:'visible-quiz', library:'custom',
      word:{word:'plunge',phonetic:'/plʌndʒ/',meaning:'跳入',example}, pickedIndex:-1 };
    examplesCache.custom = {};
    featureCache = {at:Date.now(), flags:{betaPatrickVoice:true}};`);
  renders.length = 0; audio.length = 0;
}
function renderAt(index, error) {
  const args = renders[index];
  if (!error) fs.writeFileSync(args[1][args[1].indexOf('--out') + 1], `image-${index}`);
  args[3](error);
}
function begin() {
  const result = run("patrickSpeakWord(0, 'visible-quiz')");
  renderAt(renders.length - 1);
  ctx.id = result.id;
  assert.equal(run('startSpeakCardAudio(id)'), true);
  return result;
}
function test(name, fn) { reset(); fn(); passed++; console.log('PASS', name); }
function complete(part,error=false) {ctx.part=part;ctx.audioError=error;return run('completeSpeakPart(id,part,audioError)');}

try {
  test('click reads the visible quiz and waits for the matching image to appear', () => {
    const result = run("patrickSpeakWord(0, 'visible-quiz')");
    assert.equal(result.word, 'plunge');
    ctx.id = result.id;
    assert.equal(run('startSpeakCardAudio(id)'), false);
    assert.equal(run("patrickCmds.some(c=>c.cmd==='speak-audio')"), false, 'prewarming cannot start playback');
    assert.equal(run('patrickCmds.length'), 0);
    renderAt(0);
    assert.equal(run('patrickCmds[0].cmd'), 'speak-card');
    assert.equal(run('startSpeakCardAudio(id)'), true);
    assert.equal(run('startSpeakCardAudio(id)'), false, 'duplicate shown ACK cannot replay');
    assert.equal(audio.at(-1).text, 'plunge');
    assert.equal(run('patrickCmds.at(-1).phase'), 'word');
    assert.equal(run('ttsQueue.length'),0);
  });
  test('word then full example; bubble ends only after audio completes', () => {
    begin();
    assert.equal(complete(0),true);
    assert.equal(audio.at(-1).text, 'We plunge into the water together.');
    assert.equal(run('patrickCmds.at(-1).phase'),'example');
    assert.equal(complete(0),false,'duplicate audio completion must not enqueue another example');
    assert.equal(run("patrickCmds.filter(c=>c.cmd==='speak-end').length"), 0);
    complete(1);
    assert.equal(run('speakCardState'), null);
    assert.equal(run('patrickCmds.at(-1).reason'), 'done');
    assert.equal(run('patrickQuizState.id'), 'visible-quiz', 'listening never answers or removes the quiz');
  });
  test('repeated clicks replace audio; stale callbacks cannot close the new bubble', () => {
    const first = begin();
    const second = run("patrickSpeakWord(0, 'visible-quiz')");
    assert.notEqual(first.id, second.id);
    assert.equal(complete(0),false);
    assert.equal(run('speakCardState.id'), second.id);
    assert.equal(run("patrickCmds.filter(c=>c.cmd==='speak-audio').length"), 1, 'old callback must not continue its example');
    renderAt(1); ctx.id = second.id;
    run('startSpeakCardAudio(id)');
    complete(0);complete(1);
    assert.equal(run('patrickCmds.at(-1).id'), second.id);
  });
  test('out-of-order image conversions cannot publish stale speech', () => {
    run("patrickSpeakWord(0, 'visible-quiz')");
    const second = run("patrickSpeakWord(0, 'visible-quiz')");
    renderAt(1); renderAt(0);
    assert.equal(run("patrickCmds.filter(c=>c.cmd==='speak-card').length"), 1);
    assert.equal(run('patrickCmds.at(-1).id'), second.id);
    assert.equal(fs.readFileSync(run('CARD_PNG.speak'), 'utf8'), 'image-1');
  });
  test('quiz speech lock permits only the active session example', () => {
    begin();
    const count = run('ttsQueue.length');
    run("ttsEnqueue([{text:'unrelated sentence'}, {text:speakCardState.example.en}], {allow:['unrelated sentence',speakCardState.example.en],speechId:'old-id'})");
    assert.equal(run('ttsQueue.length'), count);
  });
  test('stale quiz clicks do not interrupt the current speech', () => {
    const speech = begin();
    assert.equal(run("patrickSpeakWord(0, 'older-quiz').error"), 'stale-quiz');
    assert.equal(run('speakCardState.id'), speech.id);
    run('clearQuizCard()');
    assert.equal(complete(0),false);
    assert.equal(run('speakCardState'), null);
    assert.equal(run("patrickCmds.filter(c=>c.cmd==='speak-audio').length"),1);
    assert.equal(run('patrickCmds.at(-1).reason'), 'cancelled');
  });
  test('audio failure closes the session and drops remaining utterances', () => {
    begin(); complete(0,true);
    assert.equal(run('ttsQueue.length'), 0);
    assert.equal(run('speakCardState'), null);
    assert.equal(run('patrickCmds.at(-1).reason'), 'error');
  });
  test('missing examples read the word once; disabled voice does not open a bubble', () => {
    reset(''); begin();
    assert.equal(run('ttsQueue.length'), 0);
    complete(0);
    assert.equal(run('patrickCmds.at(-1).reason'), 'done');
    run('featureCache.flags.betaPatrickVoice=false');
    assert.equal(run("patrickSpeakWord(0, 'visible-quiz').error"), 'voice-disabled');
    assert.equal(renders.length, 1);
  });
  test('listening to a result holds its dismissal until the example finishes', () => {
    run('patrickQuizState=null; displayedQuiz.pickedIndex=0;');
    begin();
    assert.equal(run('speakCardState.resultHeld'), true);
    assert.ok(run('quizResultUntil - Date.now()') > 100000);
    assert.equal(run("patrickCmds.find(c=>c.cmd==='speak-card').holdResult"), true);
    complete(0);complete(1);
    assert.equal(run('patrickCmds.at(-1).resumeQuizMs'), run('QUIZ_RESULT_DWELL_MS'));
    assert.ok(run('quizResultUntil - Date.now()') <= run('QUIZ_RESULT_DWELL_MS'));
  });
  test('render failure and pet shutdown release the current session', () => {
    run("patrickSpeakWord(0, 'visible-quiz')");
    renderAt(0, new Error('conversion failed'));
    assert.equal(run('speakCardState'), null);
    begin(); run('stopPatrickPet()');
    assert.equal(complete(0),false);
    assert.equal(run('speakCardState'), null);
    assert.equal(run('ttsQueue.length'), 0);
  });
  test('a reading keeps its chosen voice and carries real timing into native playback',()=>{
    run("CFG.speechVoice='sonia'");begin();
    run("CFG.speechVoice='ryan'");complete(0);
    assert.equal(audio.at(-1).voiceId,'sonia');
    assert.equal(run('patrickCmds.at(-1).cues[0].start'),.1);
    assert.match(run('patrickCmds.at(-1).file'),/sonia/);
  });
  test('bubble avoids the quiz and stays within multiple screen origins', () => {
    for (const origin of [-1440, 0, 1512]) {
      ctx.screenRect = { x: origin, y: 24, w: 1440, h: 876 };
      for (const [px, py, side] of [[680,250,1], [1250,600,-1], [10,24,1], [10,680,1]]) {
        ctx.petRect = {x:origin+px,y:py,w:190,h:206};
        ctx.quizRect = {x:origin+(side===1?px+200:px-310),y:Math.max(24,py-90),w:300,h:296};
        const result = run('speakCardPosition(petRect,{w:340,h:260},screenRect,quizRect)');
        assert.ok(result.x >= origin && result.x+340 <= origin+1440);
        assert.ok(result.y >= 24 && result.y+260 <= 900);
        const q = ctx.quizRect;
        assert.ok(result.x+340<=q.x || result.x>=q.x+q.w || result.y+260<=q.y || result.y>=q.y+q.h);
      }
    }
  });
  const fixtureFlag = process.argv.indexOf('--fixtures');
  if (fixtureFlag >= 0) {
    const out = path.resolve(process.argv[fixtureFlag+1]); fs.mkdirSync(out, {recursive:true});
    ctx.word = {word:'plunge',phonetic:'/plʌndʒ/'};
    ctx.ex = {en:'She took a deep breath and prepared to plunge into the clear blue water.',zh:'她深吸了一口气，准备跳进清澈湛蓝的水里。'};
    for (const dark of [false,true]) {
      const fixture = run(`buildSpeakSVG(word,ex,${dark},${dark})`);
      fs.writeFileSync(path.join(out, dark?'dark.svg':'light.svg'),fixture.svg);
      fs.writeFileSync(path.join(out, dark?'dark.json':'light.json'),JSON.stringify(fixture.geom));
    }
    ctx.word = {word:'W'.repeat(60),phonetic:'/ˌsuːpərˌkæləˌfrædʒəˌlɪstɪk/'.repeat(4)};
    ctx.ex = {en:'A complete sentence with unexpectedly long words. '.repeat(16),zh:'完整保留长句与译文，不提前截断。'.repeat(12)};
    fs.writeFileSync(path.join(out,'long.svg'),run('buildSpeakSVG(word,ex,true).svg'));
    fs.writeFileSync(path.join(out,'empty.svg'),run("buildSpeakSVG({word:'amuse'},null,false).svg"));
    fs.writeFileSync(path.join(out,'patrick.jxa.js'),run('buildPatrickJXA({W:190,H:206,words:[],keys:[],frameNames:PATRICK_FRAME,dark:true})'));
    fs.writeFileSync(path.join(out,'menu.jxa.js'),run('buildMenuBarJXA(CFG.port,process.pid)'));
    new vm.Script(fs.readFileSync(path.join(out,'patrick.jxa.js'),'utf8'));
  }
  console.log(`${passed} speech checks passed`);
} finally {
  run('ttsStopNow()');
  fs.rmSync(temp,{recursive:true,force:true});
}
