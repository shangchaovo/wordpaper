'use strict';

// Real pg_dump and pg_restore, a separate HTTPS Storage fixture for each
// environment, and the same content-addressed paths the public API uses.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { execFile } = require('node:child_process');
const exec = require('node:util').promisify(execFile);

async function testBackup({ dir, url, restored, client }) {
  const cert = path.join(dir,'store.crt'), key = path.join(dir,'store.key');
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,
    '-out',cert,'-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);
  const image = Buffer.from('immutable fixture bytes');
  const digest = crypto.createHash('sha256').update(image).digest('hex');
  const ref = 'wp-image:v1:png:' + digest;
  const filename = '3/' + digest + '.png';
  const fixtures = {sb_secret_source:new Map([[filename,image]]),sb_secret_target:new Map()};
  const server = https.createServer({cert:fs.readFileSync(cert),key:fs.readFileSync(key)},async (req,res) => {
    const files = fixtures[req.headers.apikey];
    if (!files) { res.writeHead(403);res.end();return; }
    if (req.method === 'GET' && req.url === '/storage/v1/bucket/wordpaper-backgrounds') {
      res.end(JSON.stringify({public:false}));return;
    }
    const match = /^\/storage\/v1\/object\/(authenticated\/)?wordpaper-backgrounds\/(.+)$/.exec(req.url);
    if (!match) {res.writeHead(404);res.end();return;}
    if (req.method === 'GET' && match[1] && files.has(match[2])) {res.end(files.get(match[2]));return;}
    if (req.method === 'POST' && !match[1] && !files.has(match[2])) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      files.set(match[2],Buffer.concat(chunks));
      res.writeHead(201);res.end();return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  async function archive(mode, dest, token) {
    const env = {...process.env,PGHOST:dest.hostname,PGPORT:dest.port,PGDATABASE:dest.pathname.slice(1),
      PGUSER:decodeURIComponent(dest.username),PGPASSWORD:decodeURIComponent(dest.password),
      WORDPAPER_STORAGE_ORIGIN:'https://127.0.0.1:' + server.address().port,
      SSL_CERT_FILE:cert,WORDPAPER_STORAGE_SECRET:token, NO_PROXY:'127.0.0.1',no_proxy:'127.0.0.1'};
    await exec('python3',[path.join(__dirname,'postgres_backup.py'),mode,path.join(dir,'archive')],{env});
  }
  try {
    await client.query("INSERT INTO wordpaper.user_state VALUES(3,'settings',$1,7,8)",[JSON.stringify({bgImage:ref})]);
    await archive('backup',url,'sb_secret_source');
    const manifestFile = path.join(dir,'archive','manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile));
    assert.deepEqual(manifest.objects,[{ownerId:'3',ref,bytes:image.length}]);
    const copy = path.join(dir,'archive','objects',filename);
    fs.writeFileSync(copy,'corruption');
    await assert.rejects(archive('restore',restored.url,'sb_secret_target'),/manifest size|checksum/);
    assert.equal(fixtures.sb_secret_target.size,0);
    fs.writeFileSync(copy,image);
    fs.writeFileSync(manifestFile, JSON.stringify({...manifest,objects:[]}));
    await assert.rejects(archive('restore',restored.url,'sb_secret_target'),/references could not be verified/);
    assert.equal((await restored.client.query("SELECT to_regnamespace('wordpaper') AS s")).rows[0].s,null);
    fs.writeFileSync(manifestFile,JSON.stringify(manifest));
    await archive('restore',restored.url,'sb_secret_target');
    assert.ok(image.equals(fixtures.sb_secret_target.get(filename)));
    const settings = (await restored.client.query("SELECT value_json FROM wordpaper.user_state WHERE user_id=3 AND namespace='settings'")).rows;
    assert.equal(JSON.parse(settings[0].value_json).bgImage,ref);
    console.log('PASS snapshot-matched private object backup, corruption and omission rollback, clean DB and bucket restore');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = { testBackup };
