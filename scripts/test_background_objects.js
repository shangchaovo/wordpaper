'use strict';

const assert = require('node:assert/strict');
const { createBackgroundObjects } = require('../lib/background-objects');

async function main() {
  const stored = new Map();
  const key = 'sb_secret_test';
  let writes = 0;
  const request = async (path, options) => {
    assert.equal(options.headers.apikey, key);
    assert.equal(options.headers.Authorization, undefined);
    const url = new URL(path);
    if (url.pathname.includes('/bucket/')) return Response.json({ public: false });
    const objectPath = url.pathname.replace(/^\/storage\/v1\/object\/(authenticated\/)?/, '');
    if (options.method === 'POST') {
      writes += 1;
      stored.set(objectPath, Buffer.from(options.body));
      return new Response(null, { status: 201 });
    }
    return new Response(stored.get(objectPath), { status: stored.has(objectPath) ? 200 : 404 });
  };
  const config = { origin: 'https://test.supabase.co', key, request };
  const images = createBackgroundObjects(config);
  const source = { bgImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6B8AAAAASUVORK5CYII=', theme: 'sand' };
  const saved = await images.write(1, source);
  assert.match(saved.bgImage, /^wp-image:v1:png:[a-f0-9]{64}$/);
  assert.deepEqual(await images.expand(1, saved), source);
  await images.write(1, { ...source, theme: 'forest' }, saved);
  assert.equal(writes, 1);
  await assert.rejects(images.expand(2, saved), { status: 503 });
  await images.write(2, source);
  assert.equal(stored.size, 2);
  assert.deepEqual(await images.expand(2, saved), source);
  await assert.rejects(images.write(2, saved), { status: 400 });
  const legacy = { bgImage: 'data:image/bmp;base64,AA==' };
  assert.equal(await images.expand(1, legacy), legacy);
  assert.equal(await images.write(1, legacy), legacy);
  const unsafe = createBackgroundObjects({ ...config, request: async () => Response.json({ public: true }) });
  await assert.rejects(unsafe.write(1, source), { status: 503 });
  const offline = createBackgroundObjects({ ...config, request: async () => { throw new Error('offline'); } });
  await assert.rejects(offline.write(1, source), { status: 503 });
  for (const path of stored.keys()) stored.set(path, Buffer.from('damaged'));
  await assert.rejects(images.expand(2, saved), { status: 503 });
  console.log('PASS private per-account images, checksums, idempotent writes, offline failure and legacy payloads');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
