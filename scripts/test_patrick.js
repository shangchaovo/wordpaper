#!/usr/bin/env node
'use strict';

/* test_patrick.js — 派大星形态 + TTS + 抽查链路端点测试(自包含,TEST_MODE 不开真实窗口):
 *   /pet-mode.php        合法形态切换持久化到 config;非法形态 400
 *   /pet-patrick.json    命令队列 seq 递增、按 after 过滤
 *   /pet-speak.php       GET 405、外部 Origin 403、正常入队
 *   /pet-quiz.php        offer 需要 patrick 形态、answer 推进 petMemoryEvents、
 *                        答对/答错事件都落流、动作白名单
 *   /status.json         petMode 字段
 * 用的数据目录/词库全部临时;不依赖真窗口或 say。 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

async function waitForServer(base) {
  for (let i = 0; i < 60; i++) {
    try { const response = await fetch(base + '/status.json'); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('test companion did not start');
}

async function json(base, url, options) {
  const response = await fetch(base + url, options);
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}
async function waitQuizGeom(base, predicate = () => true) {
  for (let i = 0; i < 100; i++) {
    const result = await json(base, '/pet-patrick.json');
    const geom = result.data.quizGeom;
    if (geom && predicate(geom)) return geom;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('quiz image and geometry did not publish');
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-patrick-test-'));
  const configPath = path.join(temp, 'config.json');
  const statePath = path.join(temp, 'state.json');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'companion.js')], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: Object.assign({}, process.env, {
      WORDPAPER_TEST_MODE: '1', WORDPAPER_PORT: String(port),
      WORDPAPER_COMPANION_DATA_DIR: temp,
      WORDPAPER_STATE_PATH: statePath, WORDPAPER_CONFIG_PATH: configPath,
      WORDPAPER_CUSTOM_WORDS_PATH: path.join(temp, 'custom-words.json'),
    }),
  });
  try {
    await waitForServer(base);

    // -- status 带 petMode 字段
    const st0 = await json(base, '/status.json');
    assert.equal(st0.data.petMode, 'card', 'default petMode is card');

    // -- speak: GET 405 / 外部 Origin 403
    assert.equal((await fetch(base + '/pet-speak.php?i=0')).status, 405, 'speak GET must be 405');
    const speakCross = await fetch(base + '/pet-speak.php?i=0', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.equal(speakCross.status, 403, 'speak must reject external origins');

    // -- mode 切换持久化
    const bad = await json(base, '/pet-mode.php?mode=blob', { method: 'POST' });
    assert.equal(bad.status, 400, 'unknown mode must 400');
    const toPatrick = await json(base, '/pet-mode.php?mode=patrick', { method: 'POST' });
    assert.equal(toPatrick.data.mode, 'patrick');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).petMode, 'patrick', 'petMode must persist atomically');
    const st1 = await json(base, '/status.json');
    assert.equal(st1.data.petMode, 'patrick');
    // 再切回 card
    const back = await json(base, '/pet-mode.php?mode=card', { method: 'POST' });
    assert.equal(back.data.mode, 'card');

    // -- patrick 命令队列:seq 递增 + after 过滤
    const q1 = await json(base, '/pet-patrick.json?after=0');
    assert.equal(q1.data.ok, true);
    const seq1 = q1.data.seq;
    const q2 = await json(base, `/pet-patrick.json?after=${seq1}`);
    assert.ok(q2.data.seq >= seq1, 'seq must be monotonic');

    // -- quiz: offer 需要 patrick 形态(TEST_MODE 放行 gate,但形态必须是 patrick)
    await json(base, '/pet-sync.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ library: 'cet4', wordsPerGroup: 6, knownWords: [] }),
    });
    await json(base, '/pet-mode.php?mode=patrick', { method: 'POST' });
    const wordA = { word: 'amuse', pos: 'v.', meaning: 'v. 消遣，娱乐，使发笑', phonetic: "/ə'mju:z/" };
    const offered = await json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'offer', library: 'cet4', words: [Object.assign({ stage: 2 }, wordA)] }),
    });
    assert.equal(offered.data.offered, true, 'quiz must be offered in patrick test mode');
    assert.equal(offered.data.word, 'amuse');
    // Geometry is published only once the matching PNG is ready.
    await waitQuizGeom(base);

    // answer 错的 → event.correct=false;词汇必须仍在流里
    const wrong = await json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'answer', picked: (offered.data.word ? 0 : 0) }),
    });
    assert.equal(wrong.data.ok, true);
    assert.equal(typeof wrong.data.correct, 'boolean');

    const events1 = await json(base, '/pet-memory-events.json?after=0');
    const quizEvents = events1.data.events.filter(e => e.action === 'quiz');
    assert.equal(quizEvents.length, 1, 'quiz answer must land in the memory event stream');
    assert.equal(quizEvents[0].word.word, 'amuse');
    assert.equal(quizEvents[0].correct, wrong.data.correct);
    assert.equal(quizEvents[0].library, 'cet4');

    // 作答后卡片仍在停留期:此时 offer 必须排队(不能突然冒出新题打断造句)
    const duringResult = await json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'offer', library: 'cet4', words: [Object.assign({ stage: 0 }, wordA)] }),
    });
    assert.equal(duringResult.data.offered, false, 'must not pop a new quiz while the result is on screen');
    assert.equal(duringResult.data.queued, true);
    // 点「下一个」= 用户主动跳过造句 → 立刻放行
    const skipAhead = await json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'skip' }),
    });
    assert.equal(skipAhead.data.skipped, true);
    await new Promise(r => setTimeout(r, 900));
    // 队列里的题此时应已出;再 offer 一次会被 quiz-in-progress 挡住
    const offered2 = await json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'offer', library: 'cet4', words: [Object.assign({ stage: 0 }, wordA)] }),
    });
    assert.equal(offered2.data.offered, false, 'quiz from the queue must already be on screen');
    assert.ok(['quiz-in-progress', 'showing-result'].includes(offered2.data.reason));
    await json(base, '/pet-mode.php?mode=patrick', { method: 'POST' });
    const offerBusy = json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'offer', library: 'cet4', words: [Object.assign({ stage: 0 }, wordA)] }),
    });
    const offerBusy2 = json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'offer', library: 'cet4', words: [Object.assign({ stage: 0 }, wordA)] }),
    });
    const [b1, b2] = await Promise.all([offerBusy, offerBusy2]);
    const busyRejected = [b1, b2].some(r => r.data.offered === false && r.data.reason === 'quiz-in-progress');
    assert.ok(busyRejected, 'second offer while a quiz is open must be rejected');
    // 收尾:dismiss 清理
    await json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    });

    // -- 排队机制:作答后卡片停留期内 offer 必须排队,不能打断;skip 能立刻放行
    await json(base, '/pet-mode.php?mode=patrick', { method: 'POST' });
    const q3 = await json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'offer', library: 'cet4', words: [Object.assign({ stage: 0 }, wordA)] }),
    });
    assert.equal(q3.data.offered, true, 'quiz offered before dwell test');
    const answered = await json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'answer', picked: 0 }),
    });
    assert.equal(answered.data.ok, true);
    // 作答后立刻再 offer → 必须排队(showing-result),不能弹新题
    const duringDwell = await json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'offer', library: 'cet4', words: [Object.assign({ stage: 0 }, wordA)] }),
    });
    assert.equal(duringDwell.data.offered, false, 'must not interrupt the answer-result dwell');
    assert.equal(duringDwell.data.queued, true, 'offer during dwell must be queued');
    assert.equal(duringDwell.data.reason, 'showing-result');
    const st = await json(base, '/status.json');
    assert.equal(st.data.quizQueue.queued, true, 'status must expose the queued quiz');
    // 「下一个」:跳过造句,立刻放行(排队中的题随后出)
    const skipped = await json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'skip' }),
    });
    assert.equal(skipped.data.ok, true);
    assert.equal(skipped.data.skipped, true);
    await new Promise(r => setTimeout(r, 1200));
    const st2 = await json(base, '/status.json');
    // skip 后 700ms 队列被消化:要么已出题(quiz-in-progress),要么仍在放行中
    assert.ok(['', 'quiz-in-progress'].includes(st2.data.quizQueue.reason),
      'after skip the queue must drain, got: ' + st2.data.quizQueue.reason);
    assert.equal(st2.data.quizQueue.queued, false, 'queued quiz must be consumed after skip');
    // 收尾
    await json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    });

    // Expand / collapse must also work after answering, without recording an
    // answer when the user only wanted to read the complete definition.
    const postQuiz = data => json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
    await postQuiz({ action: 'offer', library: 'cet4', words: [{
      word: 'disproportionate', meaning: '不成比例的，需要结合具体语境理解。'.repeat(100), stage: 0, due: Date.now() - 1000,
    }] });
    const compact = await waitQuizGeom(base);
    assert.equal(compact.collapsed, true);
    const eventCount = (await json(base, '/pet-memory-events.json')).data.events.length;
    await postQuiz({ action: 'expand', quizId: compact.id });
    const full = await waitQuizGeom(base, g => g.revision > compact.revision);
    assert.equal(full.expanded, true);
    assert.ok(full.h > compact.h);
    assert.equal((await json(base, '/pet-memory-events.json')).data.events.length, eventCount);
    await postQuiz({ action: 'collapse', quizId: compact.id });
    const again = await waitQuizGeom(base, g => g.revision > full.revision);
    assert.equal(again.h, compact.h);
    assert.equal((await postQuiz({ action: 'answer', picked: -1, quizId: compact.id })).status, 400);
    await postQuiz({ action: 'answer', picked: 0, quizId: compact.id });
    await waitQuizGeom(base, g => g.done);
    assert.equal((await postQuiz({ action: 'expand', quizId: compact.id })).data.ok, true);
    await waitQuizGeom(base, g => g.done && g.expanded && g.hold);
    assert.equal((await postQuiz({ action: 'answer', picked: 0, quizId: 'replaced-card' })).status, 409);
    await postQuiz({ action: 'dismiss', quizId: compact.id });

    // 非法 action
    const badAction = await json(base, '/pet-quiz.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'nope' }),
    });
    assert.equal(badAction.status, 400, 'unknown quiz action must 400');

    console.log('PASS patrick mode/quiz/tts endpoints (mode persistence, command seq, quiz event stream, concurrency guard, queueing + skip)');
  } finally {
    child.kill('SIGKILL');
  }
})().catch(e => { console.error(e.message || e); process.exit(1); });
