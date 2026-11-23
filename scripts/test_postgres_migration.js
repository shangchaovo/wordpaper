#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');
const { createAccountCipher } = require('../lib/ai-model');
const { openStorage } = require('../lib/storage');
const { freePort, startMockProvider, startApp, stopApp, startFlow, callback, cookieValue } = require('./test_oauth');

const schemaDir = path.resolve(__dirname, '../supabase/migrations');
const sourceKey = crypto.randomBytes(32);
const destinationKey = crypto.randomBytes(32);

function seed(directory, name, option = {}) {
  fs.mkdirSync(directory);
  const store = openStorage(directory);
  const salt = crypto.randomBytes(16);
  const password = 'private fixture password';
  const derived = crypto.scryptSync(password, salt, 64);
  const hash = 'scrypt$16384$8$1$' + salt.toString('base64url') + '$' + derived.toString('base64url');
  const user = store.createUser('fixture_' + name, 'fixture_' + name, hash);
  store.putState(user.id,'reminders',[{id: name, text:'fixture',done:false}],0);
  store.setMeta('feature:betaPatrickVoice','1');
  store.setMeta('upstream_pairing','must stay local');
  store.close();
  const file = path.join(directory, 'wordpaper.sqlite');
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO auth_identities VALUES (?,?,?,?,?,?,?,?)').run('google-desktop', 'google-subject-' + name, user.id, null,1,null,1,1);
  const encrypted = createAccountCipher('', sourceKey).encrypt(String(user.id),'example-key');
  db.prepare('INSERT INTO user_models VALUES (?,?,?,?,?,?)').run(user.id,'https://example.test','openai','example',encrypted,123);
  if (option.duplicate) {
    db.exec("INSERT INTO users(username,username_key,password_hash,role,created_at) VALUES ('other','other','','user',1)");
    db.prepare('INSERT INTO auth_identities VALUES (?,?,?,?,?,?,?,?)').run('google','google-subject-' + name,2,null,1,null,2,2);
  }
  db.close();
  return file;
}

async function verifyLogins(url, dataDir) {
  const port = await freePort();
  const mock = await startMockProvider(port, []);
  let app;
  try {
    app = await startApp(await freePort(), dataDir, 'http://127.0.0.1:' + port, {
      WORDPAPER_DATABASE_URL: url.href,
      WORDPAPER_MODEL_KEY_BASE64: destinationKey.toString('base64'),
    });
    const login = await fetch(app.base + '/api/auth/login', {method:'POST',headers:{
      'Content-Type':'application/json',Origin:app.base
    },body:JSON.stringify({username:'fixture_a',password:'private fixture password'})});
    assert.equal(login.status,200);
    assert.equal((await login.json()).user.id,1);
    const flow = await startFlow(app.base,'google','/');
    const result = await callback(app.base,'google',flow,'google-code-a');
    assert.equal(result.status,302);
    const cookie = cookieValue(result,'wp_session');
    assert.ok(cookie);
    const headers = {Cookie:cookie};
    const session = await (await fetch(app.base + '/api/session',{headers})).json();
    assert.equal(session.user.id,1);
    const view = await (await fetch(app.base + '/api/state',{headers})).json();
    assert.equal(view.state.reminders[0].id,'a');
    assert.equal(view.revisions.reminders,1);
    console.log('PASS original scrypt credentials and Google provider fixture recover same migrated ID and state');
  } finally {
    if (app) await stopApp(app.child);
    await new Promise(resolve => mock.close(resolve));
  }
}

async function run() {
  const base = new URL(process.env.WORDPAPER_TEST_DATABASE_URL);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(base.hostname), 'loopback disposable test cluster required');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'wordpaper-pg-migration-'));
  const id = 'wp_migration_' + crypto.randomBytes(8).toString('hex');
  const admin = new Client({connectionString:base.href});
  const databases = [];
  const clients = [];
  async function database(name) {
    await admin.query('CREATE DATABASE ' + name);
    databases.push(name);
    const url = new URL(base);
    url.pathname = '/' + name;
    const client = new Client({connectionString:url.href});
    await client.connect();
    clients.push(client);
    return {url, client};
  }
  function migrate(mode, file, instance, url, expectError, extraEnv) {
    const child = spawnSync(process.execPath,[path.join(__dirname,'migrate_wordpaper_postgres.js'),mode,file], {
      encoding:'utf8',
      env:{...process.env,WORDPAPER_SOURCE_INSTANCE:instance,WORDPAPER_DATABASE_URL:url.href,
        WORDPAPER_MODEL_KEY_BASE64:destinationKey.toString('base64'),
        WORDPAPER_SOURCE_MODEL_KEY_BASE64:sourceKey.toString('base64'),...extraEnv},
    });
    if (expectError) { assert.notEqual(child.status,0); assert.match(child.stderr,expectError); return; }
    assert.equal(child.status,0,child.stderr);
    return JSON.parse(child.stdout);
  }
  try {
    await admin.connect();
    const {url,client} = await database(id);
    for (const file of fs.readdirSync(schemaDir).filter(f => f.endsWith('.sql')).sort()) {
      await client.query(fs.readFileSync(path.join(schemaDir,file),'utf8'));
    }
    const a = seed(path.join(dir,'a'),'a');
    const b = seed(path.join(dir,'b'),'b');
    const duplicate = seed(path.join(dir,'duplicate'),'a',{duplicate:true});
    const collision = seed(path.join(dir,'collision'),'a');
    migrate('dry-run',duplicate,'old',url,/Google 归属冲突/);
    assert.equal(migrate('inventory',duplicate,'old',url).counts.users,2);
    const decision = path.join(dir,'owners.json');
    fs.writeFileSync(decision, JSON.stringify({sourceInstance:'old', googleOwners:[{
      issuerSubjectHash:crypto.createHash('sha256').update('https://accounts.google.com\0google-subject-a').digest('hex'),sourceIds:[1,2],ownerId:1
    }]}));
    migrate('import',duplicate,'old',url,/无法使用原凭据登录/,{WORDPAPER_MIGRATION_DECISIONS:decision});
    assert.equal(migrate('dry-run',a,'one',url).accounts['1'].reminders.items,1);
    const first = migrate('import',a,'one',url);
    assert.deepEqual(first.accountMapping,{'1':'1'});
    assert.equal(migrate('import',a,'one',url).previouslyImported,true);
    assert.deepEqual(migrate('verify',a,'one',url).checksums,first.checksums);
    const second = migrate('import',b,'two',url);
    assert.deepEqual(second.accountMapping,{'1':'2'});
    const canonical = await client.query('SELECT provider,user_id FROM wordpaper.auth_identities ORDER BY user_id');
    assert.deepEqual(canonical.rows,[{provider:'google',user_id:'1'},{provider:'google',user_id:'2'}]);
    const encrypted = (await client.query('SELECT key_cipher FROM wordpaper.user_models WHERE user_id=2')).rows[0].key_cipher;
    assert.equal(createAccountCipher('',destinationKey).decrypt('2',encrypted),'example-key');
    assert.equal((await client.query('SELECT count(*) AS n FROM wordpaper.app_meta')).rows[0].n,'1');
    assert.equal((await client.query('SELECT count(*) AS n FROM wordpaper.sessions')).rows[0].n,'0');
    migrate('import',collision,'three',url,/23505/);
    assert.equal((await client.query('SELECT count(*) AS n FROM wordpaper.migration_receipts')).rows[0].n,'2');
    assert.equal((await client.query('SELECT count(*) AS n FROM wordpaper.users')).rows[0].n,'2');
    assert.equal((await client.query("INSERT INTO wordpaper.users(username,username_key,password_hash,created_at) VALUES ('new','new','',0) RETURNING id")).rows[0].id,'3');

    if (process.env.WORDPAPER_TEST_PG_BACKUP === '1') {
      const restored = await database(id + '_restore');
      await require('./test_background_backup').testBackup({ dir, url, restored, client });
      assert.deepEqual(migrate('verify',a,'one',restored.url).checksums,first.checksums);
      assert.deepEqual(migrate('verify',b,'two',restored.url).checksums,second.checksums);
      console.log('PASS pg_dump and pg_restore, both sources verified in freshly restored schema');
    }
    await verifyLogins(url,path.join(dir,'public-api'));
    await client.query("DELETE FROM wordpaper.user_state WHERE user_id=2 AND namespace='reminders'");
    migrate('import',b,'two',url,/目标缺少已导入记录/);
    assert.equal((await client.query("SELECT 1 FROM wordpaper.user_state WHERE user_id=2 AND namespace='reminders'")).rowCount,0);
    const changed = new DatabaseSync(a);
    changed.exec("UPDATE user_state SET revision=revision+1");
    changed.close();
    migrate('import',a,'one',url,/另一份快照/);
    console.log('PASS ownership preflight, collision rollback, repeat import, mapped credentials, revisions and deletion protection');
  } finally {
    for (const client of clients) await client.end();
    for (const name of databases) await admin.query('DROP DATABASE ' + name);
    await admin.end();
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

run().catch(error => {console.error(error);process.exitCode=1;});
