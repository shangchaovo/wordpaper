const os = require('os');
if (process.env.WP_AUDIT_HOME) os.homedir = () => process.env.WP_AUDIT_HOME;
const https = require('https');
const { EventEmitter } = require('events');
const original = https.get;
https.get = function(url, options, callback) {
  if (String(url).endsWith('/VERSION')) {
    const cb = typeof options === 'function' ? options : callback;
    const req = new EventEmitter();
    req.destroy = () => {};
    process.nextTick(() => {
      const res = new EventEmitter(); res.statusCode = 200; res.resume = () => {};
      cb(res); res.emit('data', process.env.WP_AUDIT_LATEST || '2.4.5'); res.emit('end');
    });
    return req;
  }
  return original.apply(this, arguments);
};
if (process.env.WP_AUDIT_FAIL_UPDATE === '1') {
  require('/Users/xieshangchao/daily-wallpaper/lib/updater.js').applyUpdate = async () => { throw new Error('AUDIT: simulated download failure before any installation'); };
}
