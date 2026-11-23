'use strict';

const { execFile } = require('node:child_process');
const { systemProxyArgs } = require('./updater');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const MAX_RESPONSE_BYTES = 128 * 1024;

async function localGoogleProviderJson(url, options) {
  const args = [
    '--disable', '--silent', '--show-error', '--proto', '=https', '--connect-timeout', '6',
    '--max-time', '12', '--max-filesize', String(MAX_RESPONSE_BYTES), '--write-out', '\n%{http_code}',
  ];
  let input;
  if (url === TOKEN_URL && options.method === 'POST' && typeof options.body === 'string') {
    args.push('--header', 'Content-Type: application/x-www-form-urlencoded', '--data-binary', '@-');
    input = options.body;
  } else if (url === USERINFO_URL && /^Bearer [^\r\n]+$/.test(options.headers?.Authorization || '')) {
    args.push('--header', '@-');
    input = `Authorization: ${options.headers.Authorization}\n`;
  } else {
    throw new Error('Unsupported Google Desktop request');
  }

  // Finder applications may lack terminal proxy variables. Use the macOS
  // HTTPS/SOCKS proxy and keep Google tokens and the form out of process args.
  args.push('--header', 'Accept: application/json', ...await systemProxyArgs(), url);
  const raw = await new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/curl', args, {
      encoding: 'utf8', timeout: 14_000, maxBuffer: MAX_RESPONSE_BYTES + 16,
    }, (error, stdout) => {
      if (error) reject(new Error('Could not reach Google from this Mac'));
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  const separator = raw.lastIndexOf('\n');
  const status = Number(raw.slice(separator + 1));
  if (separator < 0 || status < 200 || status >= 300 || !Number.isInteger(status)) {
    throw new Error(`Google returned HTTP ${Number.isInteger(status) ? status : 0}`);
  }
  return JSON.parse(raw.slice(0, separator));
}

module.exports = { localGoogleProviderJson };
