'use strict';

// Exercise the real companion functions without starting a server, audio or desktop windows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-quiz-test-'));
const requireRoot = createRequire(path.join(root, 'companion.js'));
const renders = [];
const ctx = vm.createContext({
  console, Buffer, URL, __dirname: root,
  process: { env: { WORDPAPER_TEST_MODE: '1', WORDPAPER_COMPANION_DATA_DIR: temp, WORDPAPER_DATA_DIR: temp,
    WORDPAPER_STATE_PATH: path.join(temp, 'state.json'), WORDPAPER_CONFIG_PATH: path.join(temp, 'config.json'), WORDPAPER_CUSTOM_WORDS_PATH: path.join(temp, 'custom.json') }, pid: process.pid, platform: process.platform },
  require: name => name === 'child_process' ? { execFile: (...args) => { renders.push(args); return {}; } } : requireRoot(name),
  setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
});
const source = fs.readFileSync(path.join(root, 'companion.js'), 'utf8');
vm.runInContext(source.slice(0, source.indexOf('const server = http.createServer(')), ctx);
const run = code => vm.runInContext(code, ctx);
run('ttsStopNow = () => {}; ttsPrewarm = () => {}; playSfx = () => {}; scheduleStatusBubble = () => {};');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.message); }
}

test('unbroken words and phonetics wrap without losing any characters', () => {
  for (const value of ['W'.repeat(90), 'pneumonoultramicroscopicsilicovolcanoconiosis', '/ˌsuːpərˌkæləˌfrædʒəˌlɪstɪk/'.repeat(6), 'コンピューター'.repeat(12)]) {
    ctx.value = value;
    const lines = run('wrapText(value, 13, 230, 0, 0.62)');
    assert.equal(lines.join(''), value);
    for (const line of lines) { ctx.line = line; assert.ok(run('measureText(line, 13, 0.62)') <= 230, line); }
  }
});
test('stage zero with a due time is review; future and null due are not', () => {
  assert.equal(run('isQuizReviewDue({stage: 0, due: Date.now() - 1})'), true);
  assert.equal(run('isQuizReviewDue({stage: 5, due: Date.now() + 60000})'), false);
  assert.equal(run('isQuizReviewDue({stage: 0, due: null})'), false);
});
test('round hint uses the interval AFTER passing, and round eight ends the cycle', () => {
  assert.match(run('quizRoundInfo(0).nextIn'), /1 小时/);
  assert.equal(run('quizRoundInfo(7).nextIn'), null);
});
test('long meanings stay legible and have a reversible full-text view', () => {
  ctx.options = ['长释义'.repeat(180), '短释义', '另一个释义', '最后一项'];
  const compact = run('buildQuizSVG({word:"disproportionate", pickedIndex:-1}, options, false)');
  const full = run('buildQuizSVG({word:"disproportionate", pickedIndex:-1, expand:true}, options, false)');
  assert.equal(compact.geom.collapsed, true);
  assert.equal(full.geom.expanded, true);
  assert.ok(full.geom.h > compact.geom.h);
  assert.ok(!full.svg.includes('…'));
  assert.ok(!full.svg.includes('font-size="18.4"'), 'expanded definitions must not shrink to 9.2pt');
});
test('a queued review already answered in another window is not offered again', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE user_state(user_id INTEGER, namespace TEXT, value_json TEXT, revision INTEGER, updated_at INTEGER); CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT)');
  ctx.testDb = db;
  run(`openSrsDb = () => ({ prepare: (...args) => testDb.prepare(...args), exec: sql => testDb.exec(sql), close() {} });
    CFG.petMode = 'patrick'; CFG.features = Object.assign({}, CFG.features, { betaPetQuiz: true });
    patrickQuizState = null; quizResultUntil = 0;
    writeReviewState(testDb, 1, {cet4:{words:{'memory|记忆':{word:{word:'memory',meaning:'记忆'},stage:1,due:Date.now()+60000}}}});
    queueQuiz([{word:'memory',meaning:'记忆',stage:0,due:1}], 'cet4', 1);`);
  assert.equal(run('flushPendingQuiz()'), false);
  assert.equal(run('patrickQuizState'), null);
  db.close();
});

test('stage-zero review preempts a fresh card and writes back without a browser', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE user_state(user_id INTEGER, namespace TEXT, value_json TEXT, revision INTEGER, updated_at INTEGER); CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT)');
  ctx.testDb = db;
  run(`activeUserId = () => 1; patrickVisible = true;
    writeReviewState(testDb, 1, {cet4:{words:{'memory|记忆':{word:{word:'memory',meaning:'记忆'},stage:0,due:Date.now()-1000}}}});
    CFG.library = 'cet4';
    offerQuiz([{word:'fresh', meaning:'新的'}], 'cet4');
    autoQuizTick();`);
  assert.equal(run('patrickQuizState.word.word'), 'memory');
  assert.equal(run('patrickQuizState.category'), 'review');
  assert.equal(run('patrickQuizState.srsUserId'), 1);
  assert.equal(run('patrickQuizState.stage'), 0);
  ctx.response = { writeHead() {}, end(value) { this.body = JSON.parse(value); } };
  run('answerQuiz(patrickQuizState.answerIndex, response)');
  const saved = run("readReviewState(testDb, 1).cet4.words['memory|记忆']");
  assert.equal(saved.stage, 1);
  assert.ok(Math.abs(saved.due - Date.now() - 60 * 60000) < 2000);
  assert.equal(run('state.petMemoryEvents.at(-1).srsApplied'), true);
  assert.equal(run("srsApplyAnswer(testDb, 1, 'cet4', 'memory|记忆', true).reason"), 'not-due');
  assert.equal(run("readReviewState(testDb, 1).cet4.words['memory|记忆'].reviewCount"), 1);
  db.close();
});

test('invalid answers do not consume the question or create learning events', () => {
  run("offerQuiz([{word:'fresh', meaning:'新的'}], 'cet4')");
  const before = run('state.petMemoryEvents.length');
  run('answerQuiz(1.5, response)');
  assert.equal(ctx.response.body.error, 'invalid-option');
  assert.equal(run('state.petMemoryEvents.length'), before);
  assert.equal(run('patrickQuizState.pickedIndex'), -1);
});

test('late image conversion cannot overwrite a newer expanded card or resurrect a dismissed card', () => {
  const complete = job => {
    const output = job[1].at(-1);
    fs.writeFileSync(output, output);
    job.at(-1)(null);
  };
  run('renderQuizCard()'); const old = renders.at(-1);
  run('patrickQuizState.expand = true; renderQuizCard()'); const newer = renders.at(-1);
  complete(newer);
  const png = run('CARD_PNG.quiz');
  const current = fs.readFileSync(png, 'utf8');
  complete(old);
  assert.equal(fs.readFileSync(png, 'utf8'), current);
  run('renderQuizCard()'); const late = renders.at(-1);
  run('clearQuizCard()'); complete(late);
  assert.equal(fs.existsSync(png), false);
});

test('overdue maintenance demotes once and warns even while an unanswered quiz is open', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE user_state(user_id INTEGER, namespace TEXT, value_json TEXT, revision INTEGER, updated_at INTEGER); CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT)');
  ctx.testDb = db;
  run(`openSrsDb = () => ({ prepare: (...args) => testDb.prepare(...args), exec: sql => testDb.exec(sql), close() {} });
    activeUserId = () => 1; patrickVisible = true; quizResultUntil = 0; sentenceClosedAt = 0; sentenceWinChild = null;
    state.reviewNoticeKeys = {};
    writeReviewState(testDb, 1, {cet4:{words:{
      'late|逾期':{word:{word:'late',meaning:'逾期'}, stage:3, due:Date.now()-40*3600000, reviewCount:5, failCount:1},
      'soon|即将':{word:{word:'soon',meaning:'即将'}, stage:1, due:Date.now()-60000}
    }}});
    offerQuiz([{word:'late',meaning:'逾期',stage:3,due:Date.now()-40*3600000}], 'cet4', 1);
    reviewMaintenanceTick();`);
  const saved = run("readReviewState(testDb, 1).cet4.words['late|逾期']");
  assert.equal(saved.stage, 2);
  assert.equal(saved.failCount, 1);
  assert.equal(saved.reviewCount, 5);
  assert.equal(run('patrickQuizState.stage'), 2);
  const bubbleRender = renders.at(-1);
  const bubbleSvg = fs.readFileSync(bubbleRender[1][3], 'utf8');
  if (process.argv[2] === '--policy-fixture') fs.writeFileSync(path.resolve(process.argv[3]), bubbleSvg);
  assert.match(bubbleSvg, /soon/);
  assert.match(bubbleSvg, /还有.*降到第/);
  assert.match(bubbleSvg, /已从第 4 轮降到第 3 轮/);
  fs.writeFileSync(bubbleRender[1].at(-1), 'rendered warning image');
  bubbleRender.at(-1)(null);
  assert.equal(run('patrickCmds.at(-1).cmd'), 'bubble', 'publish the rendered warning before telling the native window to show it');
  assert.match(run('patrickCmds.at(-1).lines[0].text'), /soon.*还有/);
  assert.equal(run('Object.keys(state.reviewNoticeKeys).length'), 2);
  const keys = run('JSON.stringify(state.reviewNoticeKeys)');
  run('reviewMaintenanceTick()');
  assert.equal(run('JSON.stringify(state.reviewNoticeKeys)'), keys, 'deduplicated across maintenance passes');
  assert.equal(run("readReviewState(testDb, 1).cet4.words['late|逾期'].events.length"), 1);
  assert.equal(db.prepare("SELECT value_json FROM user_state WHERE namespace='learningActivity'").get(), undefined, 'automatic policy is not practice');
  // The saved notice keys survive companion restart (loadState reads this file).
  const onDisk = JSON.parse(fs.readFileSync(path.join(temp, 'state.json'), 'utf8'));
  assert.equal(Object.keys(onDisk.reviewNoticeKeys).length, 2);
  run(`clearQuizCard(); sentenceWinChild = {}; state.reviewNoticeKeys = {}; reviewMaintenanceTick()`);
  assert.equal(run('Object.keys(state.reviewNoticeKeys).length'), 0, 'defer notifications during sentence writing');
  run('sentenceWinChild = null; reviewMaintenanceTick()');
  assert.equal(run('Object.keys(state.reviewNoticeKeys).length'), 2);
  db.close();
});

test('first-pass practice creates a next-review time and word log while the workspace is closed', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE user_state(user_id INTEGER, namespace TEXT, value_json TEXT, revision INTEGER, updated_at INTEGER); CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT)');
  ctx.testDb = db;
  run(`const firstPassEvent = {action:'learn', activityId:'first-pass-log', userId:1, library:'cet4', at:Date.now(), word:{word:'schedule',meaning:'排期'}};
    persistLearningActivity(firstPassEvent);`);
  const item = run("readReviewState(testDb, 1).cet4.words['schedule|排期']");
  assert.equal(item.stage, 0);
  assert.equal(item.due, run('firstPassEvent.at + 20*60000'));
  assert.equal(run('firstPassEvent.srsApplied'), true);
  run('persistLearningActivity(firstPassEvent)');
  const value = JSON.parse(db.prepare("SELECT value_json FROM user_state WHERE namespace='learningActivity'").get().value_json);
  const entries = Object.values(value.days).flatMap(Object.values);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].word.word, 'schedule');
  assert.equal(entries[0].nextDue, item.due);
  assert.equal(run("readReviewState(testDb, 1).cet4.words['schedule|排期'].events.length"), 1);
  db.close();
});

if (process.argv[2] === '--fixtures') {
  const output = path.resolve(process.argv[3]);
  fs.mkdirSync(output, { recursive: true });
  const samples = [
    { name: 'normal', word: 'commute', phonetic: '/kəˈmjuːt/', category: 'review', roundInfo: { stage: 0, total: 8, nextIn: '1 小时' } },
    { name: 'long-word', word: 'pneumonoultramicroscopicsilicovolcanoconiosis', phonetic: '/ˌnjuːmənoʊˌʌltrəˌmaɪkrəˌskɒpɪkˌsɪlɪkoʊvɒlˌkeɪnoʊˈkoʊsɪs/', category: 'review', roundInfo: { stage: 7, total: 8, nextIn: null } },
    { name: 'japanese', word: 'コンピューター', phonetic: 'コンピューター', category: 'fresh' },
    { name: 'collapsed', word: 'disproportionate', phonetic: '/ˌdɪsprəˈpɔːrʃənət/', category: 'review', roundInfo: { stage: 0, total: 8, nextIn: '1 小时' }, long: true },
    { name: 'expanded', word: 'disproportionate', phonetic: '/ˌdɪsprəˈpɔːrʃənət/', category: 'review', roundInfo: { stage: 0, total: 8, nextIn: '1 小时' }, long: true, expand: true },
  ];
  for (const sample of samples) {
    ctx.sample = { pickedIndex: -1, ...sample };
    ctx.options = [sample.long ? 'adj. 不成比例的；与实际情况相比过大或过小，需要结合具体语境理解。'.repeat(80) : 'n. 通勤；上下班的往返路程', 'v. 交换；改变；减轻', 'n. 社区；团体；共同体', 'adj. 一致的；连贯的；前后一致的'];
    const out = run('buildQuizSVG(sample, options, false)');
    fs.writeFileSync(path.join(output, sample.name + '.svg'), out.svg);
    fs.writeFileSync(path.join(output, sample.name + '.json'), JSON.stringify(out.geom));
  }
  fs.writeFileSync(path.join(output, 'patrick.jxa.js'), run('buildPatrickJXA({ W:190, H:206, words:[], keys:[], frameNames:{} })'));
}

fs.rmSync(temp, { recursive: true, force: true });
for (const job of renders) {
  if (job[0] !== 'sips') continue;
  for (const filename of [job[1][3], job[1].at(-1)]) { try { fs.unlinkSync(filename); } catch {} }
}
try { fs.unlinkSync(path.join(os.tmpdir(), `dw_status_bubble-${process.pid}.png`)); } catch {}
console.log(`${passed} passed; ${failed} failed`);
if (failed) process.exitCode = 1;
