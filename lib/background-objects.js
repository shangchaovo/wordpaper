'use strict';

const { createHash } = require('node:crypto');

const REF = /^wp-image:v1:(png|jpeg|webp|gif):([a-f0-9]{64})$/;
const DATA = /^data:image\/(png|jpeg|webp|gif);base64,/i;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = () => Object.assign(new Error('背景图片存储暂时不可用，请稍后重试。'), { status: 503 });

function createBackgroundObjects({ origin, key, bucket = 'wordpaper-backgrounds', request = fetch }) {
  if (!origin && !key) return null;
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== origin || !key ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(bucket)) throw new Error('请检查 WordPaper 私有图片存储配置。');
  const base = origin + '/storage/v1';
  const headers = { apikey: key };
  if (!key.startsWith('sb_secret_')) headers.Authorization = 'Bearer ' + key;
  async function call(path, options = {}) {
    try {
      return await request(base + path, { ...options, headers: { ...headers, ...options.headers },
        redirect: 'error', signal: AbortSignal.timeout(20000) });
    } catch { throw unavailable(); }
  }
  let checkedAt = 0;
  async function privateBucket() {
    if (Date.now() - checkedAt < 60000) return;
    const response = await call('/bucket/' + bucket);
    if (!response.ok || (await response.json()).public !== false) throw unavailable();
    checkedAt = Date.now();
  }
  function details(userId, ref) {
    const match = REF.exec(ref);
    if (!Number.isSafeInteger(userId) || userId < 1 || !match) throw new Error('图片引用无效');
    return { mime: 'image/' + match[1], digest: match[2], path: bucket + '/' + userId + '/' + match[2] + '.' + match[1] };
  }
  async function read(userId, ref) {
    await privateBucket();
    const file = details(userId, ref);
    const response = await call('/object/authenticated/' + file.path);
    if (!response.ok) throw unavailable();
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha(bytes) !== file.digest) throw unavailable();
    return 'data:' + file.mime + ';base64,' + bytes.toString('base64');
  }
  async function write(userId, settings, current) {
    const input = settings?.bgImage;
    if (!input || typeof input !== 'string') return settings;
    if (input.startsWith('wp-image:')) throw Object.assign(new Error('请通过本账号上传背景图片。'), { status: 400 });
    const prefix = DATA.exec(input);
    if (!prefix) return settings; // Other legacy image formats remain inline.
    const data = input.slice(prefix[0].length);
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.toString('base64') !== data) throw Object.assign(new Error('图片编码无效'), { status: 400 });
    const ref = 'wp-image:v1:' + prefix[1].toLowerCase() + ':' + sha(bytes);
    if (current?.bgImage !== ref) {
      await privateBucket();
      const file = details(userId, ref);
      // Duplicate uploads, including concurrent uploads, store identical immutable bytes.
      const response = await call('/object/' + file.path, { method: 'POST', headers: {
        'Content-Type': file.mime, 'x-upsert': 'true' }, body: bytes });
      if (!response.ok) throw unavailable();
    }
    return { ...settings, bgImage: ref };
  }
  async function expand(userId, settings) {
    if (!REF.test(settings?.bgImage)) return settings;
    return { ...settings, bgImage: await read(userId, settings.bgImage) };
  }
  return { write, expand, read, privateBucket };
}

module.exports = { createBackgroundObjects };
