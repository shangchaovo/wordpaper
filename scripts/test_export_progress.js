#!/usr/bin/env node
'use strict';

/* test_export_progress.js — 背单词情况导出(/api/export/progress):
 *   - 未登录 401
 *   - CSV:带 BOM、表头正确、含学习记录行、字段转义(释义里带逗号/引号)
 *   - JSON:只含 review 数据 + 统计字段,不夹带账号/settings
 *   - 账号隔离:A 导出的不含 B 的单词
 * 自包含:临时数据目录 + 空闲端口。 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function waitForServer(base) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('test server did not start');
}

function makeClient(base) {
  let cookie = '';
  let csrf = '';
  async function req(url, options = {}) {
    const headers = Object.assign({ Origin: base }, options.headers || {});
    if (cookie) headers.Cookie = cookie;
    if (csrf && options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrf;
    if (options.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + url, Object.assign({}, options, { headers }));
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (data && data.csrfToken) csrf = data.csrfToken;
    else if (data && data.session && data.session.csrfToken) csrf = data.session.csrfToken;
    return { status: r.status, data, text, headers: r.headers };
  }
  return { req, cookieForTest: () => cookie };
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-export-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', WORDPAPER_MODE: 'local',
      WORDPAPER_DATA_DIR: temp, WORDPAPER_COMPANION_ENABLED: '0', NODE_ENV: 'test',
    }),
  });
  try {
    await waitForServer(base);

    // -- 未登录 → 401
    const anon = await fetch(base + '/api/export/progress?format=csv');
    assert.equal(anon.status, 401, 'anonymous must get 401');

    // -- 注册 A,写入复习数据(释义含逗号与双引号,验证 CSV 转义)
    const a = makeClient(base);
    const reg = await a.req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'exporter', password: 'exportpass123' }) });
    assert.equal(reg.status, 201, JSON.stringify(reg.data));
    // CSRF token 由 /api/session 下发(登录/注册响应里没有)
    const sess = await a.req('/api/session');
    assert.ok(sess.data.csrfToken, 'session must expose csrfToken');
    const review = {
      cet4: {
        cursor: 0,
        groups: {},
        words: {
          'amuse|v. 消遣, 娱乐': {
            word: { word: 'amuse', phonetic: "/ə'mju:z/", pos: 'v.', meaning: 'v. 消遣, 娱乐 "使人发笑"' },
            learnedAt: 1700000000000, stage: 2, due: 1700003600000,
            learnedCount: 1, reviewCount: 2, successCount: 2, failCount: 0,
            events: [{ at: 1700000000000, type: 'learn' }, { at: 1700003600000, type: 'review-pass' }],
          },
          'wry|adj. 扭曲的': {
            word: { word: 'wry', pos: 'adj.', meaning: 'adj. 扭曲的' },
            learnedAt: 1700000000000, stage: 8, due: null,
            learnedCount: 1, reviewCount: 8, successCount: 8, failCount: 1,
            events: [],
          },
        },
      },
    };
    const put = await a.req('/api/state/review', { method: 'PUT', body: JSON.stringify({ value: review, expectedRevision: 0 }) });
    assert.ok(put.status === 200 || put.status === 201, 'state put: ' + put.status + ' ' + put.text.slice(0, 120));

    // -- CSV
    // 用 arrayBuffer 读原始字节:fetch 的 text() 会自动吞掉 BOM,验不出真实内容
    const csvRaw = await fetch(base + '/api/export/progress?format=csv', { headers: { Cookie: a.cookieForTest() } });
    const csvBytes = Buffer.from(await csvRaw.arrayBuffer());
    assert.equal(csvBytes[0], 0xEF, 'first BOM byte');
    assert.equal(csvBytes[1], 0xBB, 'second BOM byte');
    assert.equal(csvBytes[2], 0xBF, 'third BOM byte');
    const csvRes = await a.req('/api/export/progress?format=csv');
    assert.equal(csvRes.status, 200);
    assert.ok(/text\/csv/.test(csvRes.headers.get('content-type') || ''), 'csv content-type');
    assert.ok(/attachment; filename="wordpaper-progress-/.test(csvRes.headers.get('content-disposition') || ''), 'csv attachment filename');
    const csv = csvRes.text;
    assert.ok(csv.includes('词库,单词,音标,词性,释义'), 'header row');
    assert.ok(csv.includes('cet4,amuse'), 'word row present');
    assert.ok(csv.includes('"v. 消遣, 娱乐 ""使人发笑"""'), 'comma+quote must be RFC4180 escaped, got: ' + csv.split('\n')[1]);
    assert.ok(csv.includes('wry'), 'second word present');
    // 已记牢映射为「是」
    const wryLine = csv.split(/\r?\n/).find(l => l.includes('wry'));
    assert.ok(wryLine && wryLine.includes('是'), 'mastered must render as 是: ' + wryLine);

    // -- JSON
    const jsonRes = await a.req('/api/export/progress?format=json');
    assert.equal(jsonRes.status, 200);
    const j = jsonRes.data;
    assert.equal(j.format, 'wordpaper-progress');
    assert.equal(j.total, 2, 'total words');
    assert.equal(j.mastered, 1, 'mastered count');
    assert.equal(j.learning, 1, 'learning count');
    assert.ok(Array.isArray(j.words) && j.words.length === 2);
    const amuse = j.words.find(w => w.word === 'amuse');
    assert.equal(amuse.stage, 2);
    assert.equal(amuse.reviewCount, 2);
    assert.ok(amuse.due && amuse.due.startsWith('20'), 'due must be ISO string');
    // 不夹带账号敏感字段
    assert.ok(!('password' in j) && !('settings' in j), 'must not leak settings/credentials');
    assert.equal(j.username, 'exporter');

    // -- 账号隔离:另一个账号导出为空
    const b = makeClient(base);
    await b.req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'otheruser', password: 'otherpass123' }) });
    const bJson = await b.req('/api/export/progress?format=json');
    assert.equal(bJson.data.total, 0, 'account B must not see account A progress');

    // ── 导入:round-trip / 合并语义 / 格式兼容 / 账号隔离 ──────────────
    const csrf = sess.data.csrfToken;
    const postImport = (payload, dryRun) => a.req('/api/import/progress', {
      method: 'POST', headers: { 'X-CSRF-Token': csrf },
      body: JSON.stringify({ payload, dryRun }),
    });

    // 1) 未登录 → 401
    const anonImport = await fetch(base + '/api/import/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(anonImport.status, 401, 'anonymous import must 401');

    // 2) 无法识别的文件 → 400
    const garbage = await postImport({ hello: 'world' });
    assert.equal(garbage.status, 400, 'unrecognized payload must 400');

    // 3) dryRun 不落库
    const jsonExport = (await a.req('/api/export/progress?format=json')).data;
    const before = (await a.req('/api/export/progress?format=json')).data.total;
    const dry = await postImport(jsonExport, true);
    assert.equal(dry.status, 200);
    assert.equal(dry.data.dryRun, true);
    assert.equal(dry.data.imported, 2, 'dry run reports what would be merged');
    const afterDry = (await a.req('/api/export/progress?format=json')).data.total;
    assert.equal(afterDry, before, 'dry run must not write');

    // 4) 真导入(同一份数据:全部是「合并」,数量不变)
    const real = await postImport(jsonExport, false);
    assert.equal(real.status, 200, JSON.stringify(real.data));
    assert.equal(real.data.imported, 2);
    assert.equal(real.data.added, 0, 're-importing the same data adds nothing');
    const afterReal = (await a.req('/api/export/progress?format=json')).data.total;
    assert.equal(afterReal, 2, 'total unchanged after idempotent import');

    // 5) 合并语义:导入一条 stage 更高的同词 → 升级,且 due 取更早
    const bumped = {
      cet4: { words: { 'amuse|v. 消遣, 娱乐': {
        word: { word: 'amuse', pos: 'v.', meaning: 'v. 消遣, 娱乐' },
        learnedAt: 1600000000000, stage: 5, due: 1600000600000,
        learnedCount: 1, reviewCount: 5, successCount: 5, failCount: 1,
        events: [{ at: 1600000000000, type: 'learn' }],
      } } },
    };
    const up = await postImport(bumped, false);
    assert.equal(up.data.upgraded, 1, 'higher stage wins, got: ' + JSON.stringify(up.data));
    const j2 = (await a.req('/api/export/progress?format=json')).data;
    const amuse2 = j2.words.find(w => w.word === 'amuse');
    assert.equal(amuse2.stage, 5, 'stage upgraded');
    assert.equal(amuse2.failCount, 1, 'counters merged (max)');

    // 6) 兼容完整备份格式 { format:'wordpaper-backup', state:{ review } }
    const backup = { format: 'wordpaper-backup', schemaVersion: 1, state: { review: {
      gre: { words: { 'hawk|n. 鹰': {
        word: { word: 'hawk', pos: 'n.', meaning: 'n. 鹰' },
        learnedAt: 1700000000000, stage: 1, due: 1700000600000,
        learnedCount: 1, reviewCount: 1, successCount: 1, failCount: 0, events: [],
      } } },
    } } };
    const fromBackup = await postImport(backup, false);
    assert.equal(fromBackup.data.added, 1, 'backup format accepted');
    const j3 = (await a.req('/api/export/progress?format=json')).data;
    assert.ok(j3.words.some(w => w.word === 'hawk' && w.library === 'gre'), 'backup word landed');

    // 7) 账号隔离:另一个账号导入不影响 A;A 的数据也不会进 B
    const bReg = makeClient(base);
    await bReg.req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'importer2', password: 'importpass123' }) });
    const bSess = await bReg.req('/api/session');
    const bImport = await bReg.req('/api/import/progress', {
      method: 'POST', headers: { 'X-CSRF-Token': bSess.data.csrfToken },
      body: JSON.stringify({ payload: jsonExport, dryRun: false }),
    });
    assert.equal(bImport.status, 200);
    const bTotal = (await bReg.req('/api/export/progress?format=json')).data.total;
    assert.equal(bTotal, 2, 'account B sees only its own imported words');
    const aTotal = (await a.req('/api/export/progress?format=json')).data.total;
    assert.equal(aTotal, 3, 'account A unaffected by B import');

    console.log('PASS progress export+import (auth, CSV BOM+escaping, JSON shape, account isolation, round-trip, merge semantics, backup format)');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e.message || e); process.exit(1); });
