'use strict';
/* 渲染小词灵小窗 PNG,检查新版图标按钮。 */
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
    try { const r = await fetch(base + '/status.json'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('companion did not start');
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-petshot-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'companion.js')], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: Object.assign({}, process.env, {
      WORDPAPER_TEST_MODE: '1', WORDPAPER_PORT: String(port),
      WORDPAPER_COMPANION_DATA_DIR: temp,
      WORDPAPER_STATE_PATH: path.join(temp, 'state.json'),
      WORDPAPER_CONFIG_PATH: path.join(temp, 'config.json'),
      WORDPAPER_CUSTOM_WORDS_PATH: path.join(temp, 'custom-words.json'),
    }),
  });
  const theme = process.argv[2] || 'editorial';
  try {
    await waitForServer(base);
    let r = await fetch(base + '/pet-sync.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        library: 'ielts', wordsPerGroup: 6, petWallpaperSync: false, knownWords: [], uiTheme: theme,
        reminders: [{ text: '背单词 30 分钟', time: '08:00' }, { text: '喝水 8 杯' }],
      }),
    });
    if (r.status !== 200) throw new Error('pet-sync failed: ' + r.status);
    const petPng = path.join(os.tmpdir(), `dw_pet-${child.pid}.png`);
    try { fs.unlinkSync(petPng); } catch {}
    r = await fetch(base + '/pet-render.php?w=330&h=520');
    if (!r.ok) throw new Error('pet-render failed');
    for (let i = 0; i < 60 && !fs.existsSync(petPng); i++) await sleep(50);
    if (!fs.existsSync(petPng)) throw new Error('dw_pet.png not written');
    fs.copyFileSync(petPng, `/tmp/wp_pet_${theme}.png`);
    console.log('saved /tmp/wp_pet_' + theme + '.png');
  } finally {
    child.kill('SIGKILL');
  }
})().catch(e => { console.error(e.message || e); process.exit(1); });
