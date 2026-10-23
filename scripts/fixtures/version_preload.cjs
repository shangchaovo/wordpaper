// Explicit test-only preload: update tests never depend on GitHub's current HEAD.
const { EventEmitter } = require('events');
const https = require('https');
const fs = require('fs');
const path = require('path');
const original = https.get;
https.get = function (url, opts, callback) {
  if (!String(url).endsWith('/VERSION')) return original.apply(this, arguments);
  const cb = typeof opts === 'function' ? opts : callback;
  const req = new EventEmitter(); req.destroy = () => {};
  process.nextTick(() => {
    const res = new EventEmitter(); res.statusCode = 200; res.resume = () => {};
    cb(res);
    res.emit('data', fs.readFileSync(path.resolve(__dirname, '../../VERSION'), 'utf8'));
    res.emit('end');
  });
  return req;
};
