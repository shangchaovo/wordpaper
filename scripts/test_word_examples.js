'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { openStorage } = require('../lib/storage');
const ai = require('../lib/ai-model');
const { createExampleService, parseExample, entryKey } = require('../lib/word-examples');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-examples-'));
const word = { word: 'serendipity', meaning: '意外发现美好事物的运气', pos: 'n.' };
const example = { en: 'Finding this lovely little cafe was a moment of serendipity.', zh: '发现这家可爱的小咖啡馆是一次美好的意外。' };
const secondExample={en:'Our serendipity led us to a beautiful hidden garden.',zh:'我们的意外好运让我们发现了一座美丽的隐秘花园。'};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const storage = openStorage(temp);
  const a = storage.createUser('example-a', 'example-a', 'unused');
  const b = storage.createUser('example-b', 'example-b', 'unused');
  storage.close();
  const openDb = () => new DatabaseSync(path.join(temp, 'wordpaper.sqlite'));
  let calls = 0, mode = 'valid', clock = Date.now();
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, 'auto/deepseek-v4.1-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_tokens, 400);
    calls++; await wait(30);
    if (mode === 'limited') { res.writeHead(429); return res.end('{}'); }
    res.end(JSON.stringify({ choices: [{ message: { content: mode === 'invalid' ? '{"en":"Unrelated text.","zh":"无关内容"}' : JSON.stringify(mode==='additional'?secondExample:example) } }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const config = { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, protocol: 'openai', model: 'auto/deepseek-v4.1-flash', apiKey: 'test-example-key' };
  const complete = (messages, options) => ai.complete(config, messages, { ...options, allowPrivate: true });
  const service = createExampleService({ openDb, complete, now: () => clock });
  try {
    const first = service.ensure(a.id, 'custom', word);
    assert.strictEqual(service.ensure(a.id, 'custom', { ...word }), first);
    assert.equal((await first).en, example.en); assert.equal(calls, 1);
    assert.equal((await service.ensure(a.id, 'custom', word)).source, 'ai'); assert.equal(calls, 1);
    const offline = createExampleService({ openDb, complete: () => { throw new Error('offline'); } });
    assert.equal((await offline.ensure(a.id, 'custom', word)).en, example.en);
    assert.equal(offline.get(b.id, 'custom', word), null);
    assert.equal(offline.get(a.id, 'ielts', word), null);
    assert.equal(offline.get(a.id, 'custom', { ...word, meaning: '不同词义' }), null);
    console.log('PASS real HTTP completion, duplicate collapse, disk reuse after service restart/offline, account/library/meaning isolation');

    mode = 'invalid';
    const other = { ...word, meaning: '新的词义' };
    await assert.rejects(service.ensure(a.id, 'custom', other), e => e.code === 'invalid_example');
    assert.equal(service.get(a.id, 'custom', other), null);
    const failedCalls = calls;
    await assert.rejects(service.ensure(a.id, 'custom', other)); assert.equal(calls, failedCalls);
    clock += 31000; mode = 'limited';
    await assert.rejects(service.ensure(a.id, 'custom', other), e => e.code === 'rate_limited');
    clock += 31000; mode = 'valid';
    assert.equal((await service.ensure(a.id, 'custom', other)).en, example.en);
    for (const invalid of [ { en: 'The cart is ready to leave.', zh: '车准备走了。' }, { en: 'Art is <script>unsafe</script>.', zh: '艺术。' }, { en: 'Art is something we all enjoy.', zh: '' } ]) {
      assert.throws(() => parseExample(JSON.stringify(invalid), { word: 'art' }));
    }
    await assert.rejects(service.ensure(a.id, 'fr', { word: 'bonjour' }), e => e.code === 'unsupported_example');
    await assert.rejects(service.ensure(null, 'custom', word), e => e.code === 'account_required');
    assert.notEqual(entryKey(word), entryKey({ ...word, pos: 'v.' }));
    console.log('PASS invalid output never saved, rate-limit cooldown and later retry, exact target and bilingual validation');

    // Existing object caches remain readable, and extra examples append durably.
    const legacy=openDb();legacy.prepare('UPDATE user_word_examples SET example_json=? WHERE user_id=? AND library=? AND entry_key=?').run(JSON.stringify({...example,source:'ai'}),a.id,'custom',entryKey(word));legacy.close();
    mode='additional';
    assert.equal((await service.ensure(a.id,'custom',word,{additional:true,avoid:[example.en]})).en,secondExample.en);
    assert.deepEqual(offline.list(a.id,'custom',word).map(value=>value.en),[example.en,secondExample.en]);
    const beforeDuplicate=calls;
    await assert.rejects(service.ensure(a.id,'custom',word,{additional:true}),e=>e.code==='duplicate_example');
    assert.equal(calls,beforeDuplicate+1);assert.equal(offline.list(a.id,'custom',word).length,2);
    console.log('PASS legacy cache migration, additional examples append without overwrite, offline replay and duplicate rejection');

    // Real companion speech state machine, with controlled native rendering/audio.
    const requireRoot = createRequire(path.join(root, 'companion.js'));
    const renders = [], audio = [], requests = [];
    const ctx = vm.createContext({ console, Buffer, URL, __dirname: root,
      process: { pid: process.pid, platform: process.platform, env: {
        WORDPAPER_TEST_MODE: '1', WORDPAPER_DATA_DIR: temp, WORDPAPER_COMPANION_DATA_DIR: temp,
        WORDPAPER_CONFIG_PATH: path.join(temp, 'config.json'), WORDPAPER_STATE_PATH: path.join(temp, 'state.json'),
      } },
      require: name => name === 'child_process' ? { execFile: (...args) => { renders.push(args); return { kill() {} }; } } : requireRoot(name),
      setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
      prepare: (text, voiceId, cb) => { audio.push(text); cb(null, { file: '/tmp/test-example.wav', cues: [] }); },
      request: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })),
    });
    const source = fs.readFileSync(process.env.WORDPAPER_EXAMPLES_COMPANION_SOURCE || path.join(root, 'companion.js'), 'utf8');
    vm.runInContext(source.slice(0, source.indexOf('const server = http.createServer(')), ctx);
    const run = code => vm.runInContext(code, ctx);
    run(`CFG.srsUserId=${a.id}; CFG.library='custom'; patrickVisible=false;
      speechAudio.prepare=prepare; generatedExamples.ensure=request; examplesCache.custom={};
      displayedQuiz=patrickQuizState={id:'example-quiz',library:'custom',srsUserId:${a.id},pickedIndex:-1,
        word:{word:'sonder',meaning:'意识到每个人都有复杂的人生'}};`);
    function raster() {
      const args = renders.at(-1);
      fs.writeFileSync(args[1][args[1].indexOf('--out') + 1], 'png'); args[3](null);
    }
    function ack() { return run('startSpeakCardAudio(speakCardState.id,speakCardState.renderVersion)'); }
    function wordDone() { return run('completeSpeakPart(speakCardState.id,0,false)'); }
    function begin() { const result = run("patrickSpeakWord(0,'example-quiz')"); raster(); ack(); return result; }
    const result = begin(); assert.equal(result.examplePending, true);
    wordDone(); assert.equal(run('speakCardState.wordFinished'), true);
    const generated = { en: 'A quiet train ride filled me with sonder.', zh: '一次安静的火车旅程让我意识到每个人的人生都很复杂。', source: 'ai' };
    requests[0].resolve(generated); await wait(0);
    assert.equal(run("patrickCmds.some(c=>c.phase==='example')"), false);
    raster();
    assert.equal(run("startSpeakCardAudio(speakCardState.id,1)"), false, 'old image ACK cannot read unseen example');
    assert.equal(ack(), true);
    assert.equal(run("patrickCmds.at(-1).phase"), 'example');
    assert.equal(audio.at(-1), generated.en);
    assert.equal(run('completeSpeakPart(speakCardState.id,1,false)'), true);
    assert.equal(run('speakCardState'), null);
    console.log('PASS loading card, word first, waits for generated image ACK, English-only audio and completion');

    begin(); const old = requests.at(-1); begin(); const latest = requests.at(-1);
    const beforeRenders = renders.length;
    old.resolve(generated); await wait(0); assert.equal(renders.length, beforeRenders);
    latest.resolve(generated); await wait(0); raster(); ack();
    assert.equal(run('speakCardState.part'), 0, 'generation before word finishes must not interrupt it');
    wordDone(); assert.equal(run('speakCardState.part'), 1);
    begin(); const switched = requests.at(-1);
    run(`CFG.srsUserId=${b.id}`); switched.resolve(generated); await wait(0);
    assert.equal(run('speakCardState'), null);
    run(`CFG.srsUserId=${a.id}`);
    begin(); wordDone(); requests.at(-1).reject(ai.failure('model_not_configured', '请先绑定模型接口。', 409));
    await wait(0); assert.match(run('speakCardState.exampleError'), /绑定/); raster(); ack();
    assert.match(run('speakCardState.exampleError'),/绑定/);
    assert.ok(run('patrickCmds.at(-2).generateButton || patrickCmds.at(-1).generateButton'));
    run("displayedQuiz=patrickQuizState=null; CFG.srsUserId=" + a.id);
    ctx.savedWord = word;
    assert.equal(run("exampleForWord('custom',savedWord).en"), example.en);
    assert.equal(run("examplesForWord('custom',{...savedWord,example:'I prefer my own example.'})[0].en"), 'I prefer my own example.');
    assert.equal(run("examplesForWord('custom',{...savedWord,example:'I prefer my own example.'}).length"),3);

    run("displayedQuiz=patrickQuizState={id:'choice-quiz',library:'custom',srsUserId:"+a.id+",pickedIndex:-1,exampleIndex:0,word:{word:'sonder',meaning:'人生复杂',examples:['A quiet moment of sonder. 人生复杂的一刻。','She felt sonder on the train. 她在火车上感受到人生复杂。']}};");
    let beforeRequests=requests.length;
    run("patrickSpeakWord(0,'choice-quiz',{exampleDelta:1})");
    assert.equal(requests.length,beforeRequests);
    let choice=run("patrickSpeakWord(0,'choice-quiz',{exampleDelta:1})");
    assert.equal(choice.exampleChoice,true);assert.equal(requests.length,beforeRequests);
    raster();ack();assert.ok(run('patrickCmds.at(-2).generateButton || patrickCmds.at(-1).generateButton'));
    run("patrickSpeakWord(0,'choice-quiz',{exampleDelta:-1})");assert.equal(run('speakCardState.exampleIndex'),1);
    run("patrickSpeakWord(0,'choice-quiz',{exampleDelta:1})");
    run("patrickSpeakWord(0,'choice-quiz',{generate:true})");
    assert.equal(requests.length,beforeRequests+1);assert.equal(requests.at(-1).args[3].additional,true);
    requests.at(-1).resolve(generated);await wait(0);raster();ack();
    assert.equal(run('speakCardState.exampleCount'),3);assert.equal(run('speakCardState.exampleIndex'),2);
    assert.equal(run('displayedQuiz.exampleIndex'),2);
    console.log('PASS dictionary navigation reaches a stable AI choice, back does not generate, explicit generation appends');
    console.log('PASS replay/navigation/account-switch races, safe failure, original examples take priority and generated examples reuse in companion');

    const cleanup = openStorage(temp); cleanup.deleteUser(a.id); cleanup.close();
    const check = openDb();
    assert.equal(check.prepare('SELECT count(*) AS n FROM user_word_examples WHERE user_id=?').get(a.id).n, 0); check.close();
    console.log('PASS account deletion cascades saved examples');
  } finally {
    await new Promise(resolve => mock.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
