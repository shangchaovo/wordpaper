'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { freePort, startApp, stopApp, cookieValue } = require('./test_oauth');
const { SAMPLE } = require('../lib/speech');
const { createSpeechStore, defaults } = require('../lib/speech-provider');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-speech-account-'));
  const audio = Buffer.from('ID3 test fixture');
  let seen;
  const provider = http.createServer(async (req, res) => {
    const blocks = [];
    for await (const block of req) blocks.push(block);
    const payload = JSON.parse(Buffer.concat(blocks));
    seen = { url: req.url, auth: req.headers.authorization, payload };
    if (payload.model === 'quota-test') {
      res.writeHead(429);
      return res.end(JSON.stringify({error:{code:'insufficient_quota',message:'private provider debug'}}));
    }
    res.end(payload.model === 'invalid-audio' ? '<html>bad gateway</html>' : audio);
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const endpoint = 'http://127.0.0.1:' + provider.address().port + '/v1';
  let app, db;
  try {
    const port = await freePort();
    const opts = { WORDPAPER_MODE: 'local', WORDPAPER_COMPANION_PORT: String(await freePort()), WORDPAPER_COMPANION_ENABLED: '0' };
    app = await startApp(port, dir, endpoint, opts);
    async function register(name) {
      const res = await fetch(app.base + '/api/auth/register', { method: 'POST',
        headers: { Origin: app.base, 'Content-Type': 'application/json' }, body: JSON.stringify({username:name,password:'speech-test-password'}) });
      assert.equal(res.status, 201);
      return { ...(await res.json()), cookie: cookieValue(res, 'wp_session') };
    }
    function speech(user, method = 'GET', body, preview = false, extra = {}) {
      return fetch(app.base + '/api/account/speech' + (preview ? '/preview' : ''), {
        method, headers: { Origin: app.base, Cookie: user?.cookie || '', 'X-CSRF-Token': user?.csrfToken || '', 'Content-Type': 'application/json', ...extra },
        body: body && JSON.stringify(body),
      });
    }
    const a = await register('speaker-a'), b = await register('speaker-b');
    assert.equal((await speech()).status, 401);
    assert.deepEqual(await (await speech(a)).json(), {configured:false,...defaults});
    const config = {baseUrl:endpoint+'/audio/speech',model:'custom-voice-model',voice:'narrator',apiKey:'test-secret-A'};
    assert.equal((await speech(a,'PUT',config,false,{'X-CSRF-Token':''})).status,403);
    const save = await speech(a,'PUT',config);
    assert.equal(save.status,200);
    const summary = await save.json();
    assert.equal(summary.baseUrl,endpoint);
    assert.equal(summary.configured,true);
    assert.ok(!JSON.stringify(summary).includes(config.apiKey));
    assert.equal((await (await speech(b)).json()).configured,false);
    const reuse = {...config,apiKey:''};
    assert.equal((await speech(b,'POST',reuse,true)).status,400);
    assert.equal((await speech(a,'POST',{...reuse,baseUrl:endpoint+'/other'},true)).status,400);
    const preview = await speech(a,'POST',reuse,true);
    assert.equal(preview.status,200); assert.equal(preview.headers.get('content-type'),'audio/mpeg');
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()),audio);
    assert.deepEqual(seen,{url:'/v1/audio/speech',auth:'Bearer '+config.apiKey,payload:{model:config.model,voice:config.voice,input:SAMPLE,response_format:'mp3'}});
    for (const [model, message] of [['quota-test','额度不足'],['invalid-audio','MP3']]) {
      const response=await speech(a,'POST',{...reuse,model},true);
      assert.equal(response.status,502);
      const body=await response.text(); assert.ok(body.includes(message)); assert.ok(!body.includes('private provider debug'));
    }
    db = new DatabaseSync(path.join(dir, 'wordpaper.sqlite'));
    const store = createSpeechStore(db, dir);
    assert.ok(!db.prepare('SELECT key_cipher FROM user_speech WHERE user_id=?').get(a.user.id).key_cipher.includes(config.apiKey));
    assert.equal(store.get(a.user.id).apiKey, config.apiKey);
    await stopApp(app.child); app=null; app=await startApp(port,dir,endpoint,opts);
    assert.equal((await (await speech(a)).json()).model,config.model);
    assert.equal((await (await speech(a,'DELETE')).json()).configured,false);
    assert.equal(store.get(a.user.id),null);
    console.log('PASS speech account API, A/B isolation, encrypted secret, restart, custom preview, provider errors and unlink');
  } finally {
    if (app) await stopApp(app.child);
    if (db) db.close();
    provider.closeAllConnections(); provider.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
run().catch(error => { console.error(error); process.exitCode=1; });
