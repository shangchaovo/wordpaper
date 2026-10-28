#!/usr/bin/env node
/* companion.js — WordPaper · 桌面伴侣 (zero dependencies, macOS).
 *
 * Double-click or `node companion.js` and you get, all on localhost:
 *   1. The wallpaper website itself (so OCR + "set wallpaper" buttons work).
 *   2. A scheduler that renders today's wallpaper onto one stable PNG and sets
 *      it as the macOS desktop. Later refreshes overwrite that file in place
 *      so 系统设置 → 墙纸 → 你的照片 does not gain a card per refresh.
 *   3. An always-on-top floating "pet" mini-window showing today's word/reminders.
 *
 * No npm install, no packages. Uses only Node's stdlib + macOS built-ins
 * (osascript/System Events, Apple Vision OCR via JXA, and a native floating
 * window through the `osascript`-driven WebKit bridge). Safe to copy to any Mac.
 *
 * Config: companion-config.json (auto-created on first run).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');
const wallpaperFiles = require('./lib/wallpaper_files');

const ROOT = __dirname;
const DEFAULT_PORT = 8771;
const isMac = process.platform === 'darwin';
const RUNTIME_ROOT = path.resolve(process.env.WORDPAPER_COMPANION_DATA_DIR || (isMac
  ? path.join(os.homedir(), 'Library', 'Application Support', 'WordPaper', 'companion')
  : path.join(os.homedir(), '.wordpaper', 'companion')));
fs.mkdirSync(RUNTIME_ROOT, { recursive: true, mode: 0o700 });

/* Runtime state must survive code updates and moving/re-extracting the app.
 * Copy the old in-repository files once, but keep the originals for rollback. */
function migratedRuntimePath(name) {
  const target = path.join(RUNTIME_ROOT, name);
  const legacy = path.join(ROOT, name);
  if (!fs.existsSync(target) && fs.existsSync(legacy) && legacy !== target) {
    try { fs.copyFileSync(legacy, target, fs.constants.COPYFILE_EXCL); } catch {}
  }
  return target;
}

const CUSTOM_WORDS_PATH = process.env.WORDPAPER_CUSTOM_WORDS_PATH || migratedRuntimePath('custom-words.json');
const PET_CLOSED_PATH = migratedRuntimePath('pet-closed');
const PET_POSITION_PATH = migratedRuntimePath('pet-position.json');

/* 独立版(App)检测与内置版本号:菜单栏「检查更新 / 一键更新 / 退出」的闸门。
 * APP_MODE = 进程确实长在某个 WordPaper.app bundle 里(开发目录跑时为 false)。 */
let BUNDLED_VERSION = '';
try { BUNDLED_VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch {}
const APP_MODE = (() => { try { return fs.realpathSync(ROOT).includes('WordPaper.app'); } catch { return false; } })();

/* ---------------- config ---------------- */
const CONFIG_PATH = process.env.WORDPAPER_CONFIG_PATH || migratedRuntimePath('companion-config.json');
function loadConfig() {
  const dflt = {
    port: DEFAULT_PORT,
    // which wallpaper to push to the real desktop
    autoSetWallpaper: true,
    // 开机自启总开关(桌面端, Wallpaper-Engine 式):登录服务拉起 server 后自动派生伴侣。
    // 改 false 后 companion 不再自动启动(无需动 launchd),手动「启用伴侣」仍可用。
    autoStart: true,
    intervalMinutes: 30,          // how often the real desktop wallpaper changes
    size: 'desktop-1920x1080',    // match your screen
    theme: 'cream',
    layout: 'group',              // 唯一版式(大字海报已移除);旧配置里的 'poster' 自动按 group 渲染
    // 版面位置(与网页端 anchorWords/offWords 同步;小词灵翻页/点词重渲壁纸时保持)
    anchorWords: 'center',        // 'top'|'center'|'bottom' 单词块锚点
    anchorReminders: 'bottom',    // 'top'|'center'|'bottom' 提醒块锚点
    offWords: { x: 0, y: 0 },     // 单词块分数偏移(相对 W/H)
    offReminders: { x: 0, y: 0 }, // 提醒块分数偏移
    library: 'ielts',
    wordsPerGroup: 6,
    bgPattern: 'soft',
    showReminders: true,
    uiTheme: 'editorial',          // 'anime' | 'editorial' | 'liquid' | 'darkliquid'（网页外观与小词灵同步）
    // floating pet window
    petEnabled: true,
    petMode: 'card',              // 'card' 词卡 | 'patrick' 派大星桌面漫游
    petRoam: true,                // 派大星是否自由走动(false = 原地待机)
    petRoamInterval: 11,          // 派大星平均每隔多少秒决定一次散步(3–60)
    quizIntervalSec: 300,         // 自主抽查间隔(秒,最小 60):派大星自己读库出题
    quizAutoStart: true,          // 是否开启"伴侣自主抽查"(不依赖浏览器)
    petCorner: 'top-right',       // 'top-right'|'top-left'|'bottom-right'|'bottom-left'
    petWordsPerPage: 6,           // 小词灵连续词槽；与壁纸每组数量相互独立
    petTransition: 'dissolve-pop', // 换词特效: dissolve(溶解)|pop(Q弹)|dissolve-pop|none
    petWallpaperSync: true,        // 壁纸/预览与小词灵当前页词同步（网页推送为准）
    reminders: [],                // optional: hard-code reminders for wallpaper
    // 换壁纸快捷键仍可选；小词灵本身点击词卡只记录记忆，不再换词。
    advanceByClick: true,
    hotkeyEnabled: false,         // global hotkey (needs Input Monitoring; off by default)
    hotkey: 'ctrl+alt+w',         // format: ctrl/alt/shift/cmd + '+' + a-z or 'space'
    hotkeyBack: 'ctrl+alt+shift+w', // back (undo last advance)
  };
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return Object.assign(dflt, c);
  } catch {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(dflt, null, 2));
    return dflt;
  }
}
const CFG = loadConfig();

/* ── 内测功能开关(管理员在网页「管理」卡片里设置,存 app_meta)──────────
 * 伴侣只读不写;数据库不存在/没有 node:sqlite 时全部按默认(开启)处理,
 * 保证独立版在没登录过的情况下也能正常跑。 */
let featureCache = { at: 0, flags: {} };
function featureFlags() {
  const now = Date.now();
  if (now - featureCache.at < 15000) return featureCache.flags;   // 15s 缓存
  featureCache.at = now;
  const flags = {};
  try {
    const dbPath = path.join(process.env.WORDPAPER_DATA_DIR || path.join(os.homedir(), '.wordpaper'), 'wordpaper.sqlite');
    if (process.env.WORDPAPER_TEST_MODE === '1' && !process.env.WORDPAPER_DATA_DIR) return flags;
    if (fs.existsSync(dbPath)) {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare("SELECT key, value FROM app_meta WHERE key LIKE 'feature:%'").all();
        rows.forEach(r => { flags[String(r.key).slice(8)] = r.value === '1'; });
      } finally { try { db.close(); } catch {} }
    }
  } catch { /* 旧 Node 无 node:sqlite / 库被锁 → 用默认 */ }
  featureCache.flags = flags;
  return flags;
}
/* 未设置过 = 默认开启(内测功能默认可用,管理员显式关闭才停)。 */
function featureOn(key) {
  const flags = featureFlags();
  return Object.prototype.hasOwnProperty.call(flags, key) ? flags[key] === true : true;
}
if (process.env.WORDPAPER_WEB_ORIGIN && (!nativeAppPath() || process.env.WORDPAPER_NATIVE_UI === '1')) {
  try {
    const origin = new URL(process.env.WORDPAPER_WEB_ORIGIN);
    if (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(origin.hostname)) CFG.webOrigin = origin.origin;
  } catch {}
}
const PET_UI_THEMES = new Set(['anime', 'editorial', 'liquid', 'darkliquid']);
if (!PET_UI_THEMES.has(CFG.uiTheme)) CFG.uiTheme = 'editorial';
if (process.env.WORDPAPER_PORT) CFG.port = Math.max(1, Number(process.env.WORDPAPER_PORT) || DEFAULT_PORT);
if (process.env.WORDPAPER_TEST_MODE === '1') { CFG.autoSetWallpaper = false; CFG.petEnabled = false; CFG.hotkeyEnabled = false; }
function saveConfig() {
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
  try { fs.writeFileSync(tmp, JSON.stringify(CFG, null, 2)); fs.renameSync(tmp, CONFIG_PATH); return true; }
  catch { try { fs.unlinkSync(tmp); } catch {} return false; }
}

/* Manual-advance state: each "next" (pet click or global hotkey) bumps the
 * counter, which is mixed into the pick seed so the wallpaper + pet jump to a
 * new word group right away (the auto interval still rotates by bucket). */
const STATE_PATH = process.env.WORDPAPER_STATE_PATH || migratedRuntimePath('companion-state.json');
const STATE_DEFAULTS = { bump: 0, petMemoryEvents: [], petMemorySeq: 0, petMemoryStreamId: '', petLearnedByLibrary: {}, petDecksByLibrary: {}, petKnownByLibrary: {}, petWordEpoch: 0, wallpaperCachePath: '', patrickSize: null, sentenceNotes: [], sentenceNoteSeq: 0 };
let state = Object.assign({}, STATE_DEFAULTS);
try { state = Object.assign({}, STATE_DEFAULTS, JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))); } catch {}
if (!Array.isArray(state.petMemoryEvents)) state.petMemoryEvents = [];
if (!state.petLearnedByLibrary || typeof state.petLearnedByLibrary !== 'object') state.petLearnedByLibrary = {};
if (!state.petDecksByLibrary || typeof state.petDecksByLibrary !== 'object') state.petDecksByLibrary = {};
if (!state.petKnownByLibrary || typeof state.petKnownByLibrary !== 'object') state.petKnownByLibrary = {};
state.petWordEpoch = Math.max(0, Number(state.petWordEpoch) || 0);
if (!Array.isArray(state.sentenceNotes)) state.sentenceNotes = [];
state.sentenceNoteSeq = Math.max(0, Number(state.sentenceNoteSeq) || 0);
if (typeof state.wallpaperCachePath !== 'string') state.wallpaperCachePath = '';
function makeStreamId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
if (!state.petMemoryStreamId) state.petMemoryStreamId = makeStreamId();
function saveState() {
  const tmp = `${STATE_PATH}.tmp-${process.pid}`;
  try { fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, STATE_PATH); }
  catch { try { fs.unlinkSync(tmp); } catch {} }
}
// 移除 PushPlus 后立即丢弃遗留的通知凭据，避免继续保存在本机状态中。
let migratedState = false;
if (state.notification) { delete state.notification; migratedState = true; }
function petWordKey(word) { return String((word && word.word) || '') + '|' + String((word && word.meaning) || ''); }
/* 词义带词根词性(记忆本里存的 meaning 常已含 'v. ')——拼接时避免 'v. v. …' 重复。 */
function withPos(word) {
  const meaning = String((word && word.meaning) || '');
  const pos = String((word && word.pos) || '');
  if (!pos) return meaning;
  const bare = pos.replace(/\.\s*$/, '').trim();       // 'v.' → 'v'
  if (meaning.startsWith(pos) || meaning.startsWith(bare + '.')) return meaning;
  return pos + ' ' + meaning;
}
function screeningKey(word) { return String((word && word.word) || '') + '\u0000' + String((word && word.phonetic) || ''); }

// 迁移旧版全局状态到按词库隔离的结构；历史事件/排期中有完整 word 时可恢复快照。
if (state.petGroup && state.petGroup.library) { state.petDecksByLibrary[state.petGroup.library] = { library: state.petGroup.library, index: 0, drawSeq: Number(state.petGroup.round) || 1, pages: [state.petGroup] }; migratedState = true; }
Object.keys(state.petGroupsByLibrary || {}).forEach(library => {
  if (!state.petDecksByLibrary[library]) state.petDecksByLibrary[library] = { library, index: 0, drawSeq: Number(state.petGroupsByLibrary[library].round) || 1, pages: [state.petGroupsByLibrary[library]] };
  migratedState = true;
});
const legacyWords = {};
(state.petMemoryEvents || []).forEach(event => { if (event && event.word) legacyWords[petWordKey(event.word)] = { word: event.word, at: event.at || Date.now() }; });
Object.keys(state.petReviewSchedule || {}).forEach(key => {
  const item = state.petReviewSchedule[key]; if (item && item.word) legacyWords[key] = { word: item.word, at: item.learnedAt || item.lastSeenAt || Date.now() };
});
Object.keys(state.petRemembered || {}).forEach(key => {
  const record = legacyWords[key]; if (!record) return;
  const lib = ((state.petMemoryEvents || []).find(event => event && event.word && petWordKey(event.word) === key) || {}).library || CFG.library;
  if (!state.petLearnedByLibrary[lib]) state.petLearnedByLibrary[lib] = {};
  if (!state.petLearnedByLibrary[lib][key]) state.petLearnedByLibrary[lib][key] = record;
  migratedState = true;
});
if ('petGroup' in state) { delete state.petGroup; migratedState = true; }
if ('petGroupsByLibrary' in state) { delete state.petGroupsByLibrary; migratedState = true; }
if ('petRemembered' in state) { delete state.petRemembered; migratedState = true; }
if ('petReviewSchedule' in state) { delete state.petReviewSchedule; migratedState = true; }
if (migratedState) saveState();

function learnedFor(library) {
  if (!state.petLearnedByLibrary[library]) state.petLearnedByLibrary[library] = {};
  return state.petLearnedByLibrary[library];
}
function knownFor(library) { return new Set(Array.isArray(state.petKnownByLibrary[library]) ? state.petKnownByLibrary[library] : []); }
function uniquePetWords(list) {
  const seen = new Set(), out = [];
  (list || []).forEach(word => { const key = petWordKey(word); if (key && !seen.has(key)) { seen.add(key); out.push(word); } });
  return out;
}
// 壁纸数量与小词灵词槽解耦：壁纸可以显示任意数量，小词灵始终维护连续的
// 6 个学习位置（除非整个候选词库只剩不到 6 个），点击一词就补回一词。
function petSlotCount() {
  const requested = Math.max(1, Math.min(36, Number(CFG.petWordsPerPage) || 6));
  return requested > 1 && requested % 2 ? Math.min(36, requested + 1) : requested;
}

/* 小词灵采用可翻页的连续首轮队列：点掉一词就补一词；上一页/下一页只切换
 * 尚未完成首轮的词，不会推进艾宾浩斯阶段。 */
function availablePetWords(library) {
  const learned = learnedFor(library), known = knownFor(library);
  return uniquePetWords(loadWords(library)).filter(word => !learned[petWordKey(word)] && !known.has(screeningKey(word)));
}
function deckFor(library) {
  let deck = state.petDecksByLibrary[library];
  if (!deck || !Array.isArray(deck.pages)) deck = state.petDecksByLibrary[library] = { library, index: 0, drawSeq: 0, pages: [] };
  deck.library = library;
  deck.index = Math.max(0, Math.min(Number(deck.index) || 0, Math.max(0, deck.pages.length - 1)));
  deck.drawSeq = Math.max(0, Number(deck.drawSeq) || 0);
  return deck;
}
function drawPetWords(library, deck, count, excluded) {
  const candidates = availablePetWords(library).filter(word => !excluded.has(petWordKey(word)));
  if (!candidates.length || count <= 0) return [];
  deck.drawSeq += 1;
  return pickForDate(candidates, count, `pet-deck:${dateKey(new Date())}:${deck.drawSeq}`, 'random');
}
function refillPetPage(library, deck, page) {
  const learned = learnedFor(library), known = knownFor(library), count = petSlotCount();
  const availableKeys = new Set(uniquePetWords(loadWords(library)).map(petWordKey));
  page.words = uniquePetWords(page.words).filter(word => availableKeys.has(petWordKey(word)) && !learned[petWordKey(word)] && !known.has(screeningKey(word)));
  const current = new Set(page.words.map(petWordKey));
  const acrossPages = new Set();
  deck.pages.forEach(other => (other.words || []).forEach(word => acrossPages.add(petWordKey(word))));
  let added = drawPetWords(library, deck, count - page.words.length, acrossPages);
  if (added.length < count - page.words.length) {
    added = added.concat(drawPetWords(library, deck, count - page.words.length - added.length, new Set([...current, ...added.map(petWordKey)])));
  }
  page.words = uniquePetWords(page.words.concat(added)).slice(0, count);
  page.exhausted = page.words.length === 0 && availablePetWords(library).length === 0;
  return page;
}
function newPetPage(library, deck, excludeAllPages) {
  const excluded = new Set();
  if (excludeAllPages) deck.pages.forEach(page => (page.words || []).forEach(word => excluded.add(petWordKey(word))));
  const count = petSlotCount();
  let words = drawPetWords(library, deck, count, excluded);
  if (!words.length) words = drawPetWords(library, deck, count, new Set());
  return { library, id: `${Date.now().toString(36)}-${deck.drawSeq}`, words, exhausted: words.length === 0 };
}
function ensurePetDeck(library) {
  const lib = library || CFG.library, deck = deckFor(lib);
  if (!deck.pages.length) deck.pages.push(newPetPage(lib, deck, false));
  deck.index = Math.max(0, Math.min(deck.index, deck.pages.length - 1));
  refillPetPage(lib, deck, deck.pages[deck.index]);
  saveState();
  return deck;
}
function currentPetPage(library) { const deck = ensurePetDeck(library); return deck.pages[deck.index]; }
function petFirstPassWords() { return currentPetPage(CFG.library).words.slice(); }
/* 小词灵当前页词的「代际」计数器：点词/翻页/补位导致当前页词变化就 +1。网页按
 * epoch 轮询比对，发现变化就拉取当前页词对齐预览；这是翻页（不产生记忆事件）
 * 也能被网页感知的关键。 */
function bumpPetWordEpoch() { state.petWordEpoch = Math.max(0, Number(state.petWordEpoch) || 0) + 1; scheduleStatusBubble(); }
function navigatePetPage(direction) {
  const library = CFG.library, deck = ensurePetDeck(library), dir = direction < 0 ? -1 : 1;
  if (dir < 0) deck.index = Math.max(0, deck.index - 1);
  else if (deck.index < deck.pages.length - 1) deck.index += 1;
  else {
    deck.pages.push(newPetPage(library, deck, true));
    deck.index = deck.pages.length - 1;
    if (deck.pages.length > 24) { deck.pages.shift(); deck.index -= 1; }
  }
  refillPetPage(library, deck, deck.pages[deck.index]);
  bumpPetWordEpoch();
  saveState();
  return { page: deck.index + 1, words: deck.pages[deck.index].words.length, exhausted: deck.pages[deck.index].exhausted };
}
function completePetFirstPass(word) {
  const library = CFG.library, deck = ensurePetDeck(library), page = deck.pages[deck.index], key = petWordKey(word), now = Date.now();
  const index = page.words.findIndex(item => petWordKey(item) === key);
  if (index < 0 || learnedFor(library)[key]) return { page, duplicate: true };
  learnedFor(library)[key] = { word, at: now };
  // 原位替换:只把被点槽位换成一个新词,其余词位置完全不动(用户要求:点哪个换哪个,
  // 旁边词不跟着变)。先抽一个候选,放进被点槽位;抽不到(词库见底)才退化为移除顺移。
  const inUse = new Set();
  deck.pages.forEach(p => (p.words || []).forEach(w => inUse.add(petWordKey(w))));
  const candidate = drawPetWords(library, deck, 1, inUse)[0];
  if (candidate) page.words[index] = candidate;
  else { page.words.splice(index, 1); refillPetPage(library, deck, page); }
  page.exhausted = page.words.length === 0 && availablePetWords(library).length === 0;
  state.petMemorySeq = Math.max(0, Number(state.petMemorySeq) || 0) + 1;
  const event = { id: state.petMemorySeq, at: now, library, word, action: 'learn', firstPass: true, page: deck.index + 1, refilled: Boolean(candidate) };
  notePatrickStudy(now);
  state.petMemoryEvents.push(event);
  state.petMemoryEvents = state.petMemoryEvents.slice(-160);
  bumpPetWordEpoch();
  saveState();
  return { page, deck, duplicate: false, event };
}
function learnedSnapshot() {
  const out = [];
  Object.keys(state.petLearnedByLibrary).forEach(library => {
    Object.keys(state.petLearnedByLibrary[library] || {}).forEach(key => {
      const record = state.petLearnedByLibrary[library][key];
      if (record && record.word) out.push({ library, word: record.word, at: record.at || 0 });
    });
  });
  return out;
}
function bumpDelta(d) {
  state.bump = (((state.bump + d) % 1000000) + 1000000) % 1000000;
  saveState();
}
function bumpNext() { bumpDelta(1); }
function bumpPrev() { bumpDelta(-1); }
/* Same seed for wallpaper & pet so both show the same group. When bump is 0 the
 * seed is byte-identical to the old behaviour, so first-run is unchanged. */
function todaySeed() {
  return dateKey(new Date()) + '#' + rotationBucket() + (state.bump ? '#bump' + state.bump : '');
}
/* Parse 'ctrl+alt+w'-style hotkey into { keyCode, mask, label }. */
const KEYCODES = { a:0,b:11,c:8,d:2,e:14,f:3,g:5,h:4,i:34,j:38,k:40,l:37,m:46,n:45,o:31,p:35,q:12,r:15,s:1,t:17,u:32,v:9,w:13,x:7,y:16,z:6, space:49 };
function parseHotkey(spec) {
  const parts = String(spec).split('+').map(s => s.trim().toLowerCase());
  const key = parts.pop();
  const keyCode = KEYCODES[key];
  if (keyCode == null) return null;
  let mask = 0;
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') mask |= 1;                 // control
    else if (p === 'alt' || p === 'option' || p === 'opt') mask |= 2; // option
    else if (p === 'shift') mask |= 4;                              // shift
    else if (p === 'cmd' || p === 'command' || p === 'meta') mask |= 8; // command
    else return null;
  }
  return { keyCode, mask, label: spec };
}

/* ---------------- word data ---------------- */
function loadWords(library) {
  if (library === 'custom') {
    try { const words = JSON.parse(fs.readFileSync(CUSTOM_WORDS_PATH, 'utf8')); return Array.isArray(words) ? words : []; }
    catch { return []; }
  }
  const f = path.join(ROOT, 'data', `words_${library}.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

function saveCustomWords(words) {
  const clean = (Array.isArray(words) ? words : []).filter(word => word && typeof word === 'object' && String(word.word || '').trim()).slice(0, 10000).map(word => ({
    word: String(word.word || '').trim(), phonetic: String(word.phonetic || ''), pos: String(word.pos || ''),
    meaning: String(word.meaning || ''), example: String(word.example || ''),
  }));
  const tmp = `${CUSTOM_WORDS_PATH}.tmp-${process.pid}`;
  try { fs.writeFileSync(tmp, JSON.stringify(clean, null, 2)); fs.renameSync(tmp, CUSTOM_WORDS_PATH); return clean; }
  catch { try { fs.unlinkSync(tmp); } catch {} return null; }
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dateKey(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function pickForDate(list, count, dateStr, order) {
  if (!list || !list.length) return [];
  const n = Math.max(1, Math.min(count, list.length));
  const seed = hash(dateStr + '|' + order);
  if (order === 'random') {
    const rand = rng(seed);
    const idx = list.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return idx.slice(0, n).map(i => list[i]);
  }
  const dayIndex = Math.floor(new Date(dateStr + 'T00:00:00').getTime() / 86400000);
  const start = (dayIndex * n + (seed % 7)) % list.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[(start + i) % list.length]);
  return out;
}

const SIZES = {
  'desktop-1920x1080': [1920, 1080],
  'desktop-2560x1440': [2560, 1440],
  'desktop-3840x2160': [3840, 2160],
};

/* Build the settings object render.js expects, from config. */
function normOff(o) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return { x: num(o && o.x), y: num(o && o.y) };
}
function normAnchor(v, dflt) { return v === 'top' || v === 'bottom' ? v : (v === 'center' ? 'center' : dflt); }
function buildSettings() {
  return {
    layout: CFG.layout, bgPattern: CFG.bgPattern, fontScale: 1, fontWeight: 700,
    letterSpacing: 0, lineHeight: 1, anchorWords: normAnchor(CFG.anchorWords, 'center'), anchorReminders: normAnchor(CFG.anchorReminders, 'bottom'),
    offWords: normOff(CFG.offWords), offReminders: normOff(CFG.offReminders),
    showPhonetic: true, showExample: true, showDate: true, showReminders: CFG.showReminders,
    showClock: true, custom: { enabled: false, title: '', footer: '' },
  };
}
const THEMES = {
  cream: { bg: '#fdf6ec', bg2: '#f7e8d4', ink: '#4a3b2e', sub: '#a08a73', accent: '#e8834a', accentSoft: '#fbe0c8', line: 'rgba(74,59,46,0.12)', patternInk: '#d9b48f' },
  mint: { bg: '#eafaf1', bg2: '#d3f2e0', ink: '#1f4536', sub: '#6f9a87', accent: '#2fae7d', accentSoft: '#c0ecd8', line: 'rgba(31,69,54,0.12)', patternInk: '#9ed9bd' },
  sky: { bg: '#e8f4fd', bg2: '#d3e9fb', ink: '#1e3a52', sub: '#6f8ba3', accent: '#3b8fd9', accentSoft: '#c2e0f7', line: 'rgba(30,58,82,0.12)', patternInk: '#a4cdec' },
  sakura: { bg: '#fff1f5', bg2: '#fde3ea', ink: '#57222f', sub: '#ae7d8b', accent: '#f1789b', accentSoft: '#fad3de', line: 'rgba(87,34,47,0.10)', patternInk: '#f3b6c7' },
  liquid: { bg: '#f8fbff', bg2: '#dce7f0', ink: '#223242', sub: '#6a7f92', accent: '#7299b8', accentSoft: '#dbe8f2', line: 'rgba(53,79,101,0.12)', patternInk: '#bfd2e0', liquid: true },
  pearl: { bg: '#ffffff', bg2: '#fafafc', ink: '#2b2b30', sub: '#9a9aa2', accent: '#8e8e93', accentSoft: '#f4f4f6', line: 'rgba(43,43,48,0.10)', patternInk: '#e8e8ec' },
  night: { bg: '#151a2e', bg2: '#1f2745', ink: '#eef1f8', sub: '#8b95b3', accent: '#7aa2f7', accentSoft: '#2a3358', line: 'rgba(238,241,248,0.14)', patternInk: '#3a4670' },
  forest: { bg: '#12211c', bg2: '#1c332a', ink: '#e8f0ea', sub: '#8fae9f', accent: '#5ec99a', accentSoft: '#234534', line: 'rgba(232,240,234,0.12)', patternInk: '#2e5040' },
  darkliquid: { bg: '#0b0e17', bg2: '#131a2c', ink: '#f2f5fc', sub: '#93a0bd', accent: '#7aa2f7', accentSoft: 'rgba(122,162,247,0.16)', line: 'rgba(242,245,252,0.16)', patternInk: '#2c3a5e', liquid: true, dark: true },
};

/* Render the wallpaper to a PNG file WITHOUT any dependency, by drawing SVG
 * and rasterizing with macOS's built-in `sips`/`qlmanage`. This mirrors
 * render.js's GROUP layout closely enough for a desktop wallpaper. */
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function buildSVG(opts) {
  const { width: W, height: H, layout, theme, words, reminders, settings, dateStr } = opts;
  const t = theme;
  const margin = Math.round(W * 0.06);
  const parts = [];
  const darkBg = !!t.dark;
  parts.push(`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${t.bg}"/><stop offset="${t.liquid ? (darkBg ? '.52' : '.36') : '1'}" stop-color="${t.liquid ? (darkBg ? (t.bg2 || '#131a2c') : '#edf5fa') : (t.bg2 || t.bg)}"/><stop offset="1" stop-color="${darkBg ? '#0a0d15' : (t.bg2 || t.bg)}"/></linearGradient>
    <radialGradient id="blob" cx="0.85" cy="0.12" r="0.6">
    <stop offset="0" stop-color="${t.accentSoft}" stop-opacity="0.6"/><stop offset="1" stop-color="${t.accentSoft}" stop-opacity="0"/></radialGradient>
    <radialGradient id="liquidSky" cx="0.9" cy="0.12" r="0.52"><stop offset="0" stop-color="${darkBg ? '#4a6db4' : '#a9d2e8'}" stop-opacity="${darkBg ? '.34' : '.48'}"/><stop offset="1" stop-color="${darkBg ? '#131a2c' : '#dceaf3'}" stop-opacity="0"/></radialGradient>
    <radialGradient id="liquidPearl" cx="0.16" cy="0.92" r="0.48"><stop offset="0" stop-color="${darkBg ? '#6474b4' : '#dcd9f0'}" stop-opacity="${darkBg ? '.22' : '.36'}"/><stop offset="1" stop-color="${darkBg ? '#0b0e17' : '#eef5fa'}" stop-opacity="0"/></radialGradient></defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#g)"/>`);
  if (t.liquid) {
    parts.push(`<rect width="${W}" height="${H}" fill="url(#liquidSky)"/><rect width="${W}" height="${H}" fill="url(#liquidPearl)"/>`);
    parts.push(`<rect x="${Math.round(W * .008)}" y="${Math.round(H * .008)}" width="${Math.round(W * .984)}" height="${Math.round(H * .984)}" rx="${Math.round(Math.min(W,H) * .025)}" fill="none" stroke="${darkBg ? '#a9c0f2' : '#ffffff'}" stroke-opacity="${darkBg ? '.38' : '.7'}" stroke-width="${Math.max(2,Math.round(Math.min(W,H)*.003))}"/>`);
  } else if (settings.bgPattern !== 'none') parts.push(`<rect width="${W}" height="${H}" fill="url(#blob)"/>`);
  const fam = 'Yuanti SC, YouYuan, 幼圆, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif';
  const text = (x, y, s, size, fill, weight, anchor) =>
    `<text x="${x}" y="${y}" font-family="${fam}" font-size="${size}" fill="${fill}" font-weight="${weight || 400}"${anchor ? ` text-anchor="${anchor}"` : ''}>${esc(s)}</text>`;

  // Mirror render.js renderGroup(): adaptive rows. When rows are tall enough we
  // stack word over meaning; when short (landscape / many words) we lay the row
  // out on a single line — index · word · phonetic · meaning — with divider rules.
  const n = Math.max(1, words.length);
  const hasRem = settings.showReminders && reminders && reminders.length;

  // ---- 定位:镜像 render.js 的 anchorY/blockTopFor,让网页里拖的锚点+偏移
  // 真正作用到桌面壁纸(小词灵翻页/点词重渲时布局不再回默认)。 ----
  const topBand = Math.round(margin * 1.1);
  const bottomBand = H - Math.round(margin * 1.1);
  const anchorY = (anchor, aTop, aBottom, bH) => {
    const span = Math.max(0, aBottom - aTop - bH);
    if (anchor === 'top') return aTop;
    if (anchor === 'bottom') return aBottom - bH;
    return aTop + Math.round(span * 0.5); // center
  };
  const blockTopFor = (anchor, offY, aTop, aBottom, bH) => {
    const base = anchorY(anchor, aTop, aBottom, bH);
    const y = base + Math.round((offY || 0) * H);
    const pad = Math.round(H * 0.03);
    return Math.max(pad - bH, Math.min(H - pad, y));
  };

  // 提醒块:先估高度并按自身锚点+偏移定位,单词带据此避让(与 render.js 一致)。
  const remFs = Math.round(W * 0.020);
  const remLh = Math.round(remFs * 1.8);
  const remH = hasRem ? (Math.round(remLh * 1.15) + Math.min(reminders.length, 6) * remLh) : 0;
  const remAnchor = settings.anchorReminders || 'bottom';
  const remTop = hasRem ? blockTopFor(remAnchor, settings.offReminders && settings.offReminders.y, topBand, bottomBand, remH) : 0;

  // 单词块:行高按内容定(镜像 render.js 单列),整块按锚点+偏移摆放。
  let wordsTop = topBand, wordsBottom = bottomBand;
  if (remH && remAnchor === 'top') wordsTop = Math.max(wordsTop, remTop + remH + Math.round(H * 0.02));
  if (remH && remAnchor === 'bottom') wordsBottom = Math.min(wordsBottom, remTop - Math.round(H * 0.02));
  const avail = Math.max(1, wordsBottom - wordsTop);
  let wordFs = Math.max(Math.round(W * 0.018), Math.round(W * 0.052));
  let rowH = Math.round(wordFs * 3.0);
  const maxFillRowH = Math.floor(avail / n);
  if (rowH > maxFillRowH && maxFillRowH > 0) { rowH = maxFillRowH; wordFs = Math.max(Math.round(W * 0.018), Math.min(wordFs, Math.round(rowH * 0.48))); }
  const blockH = rowH * n;
  const blockTop = blockTopFor(settings.anchorWords || 'center', settings.offWords && settings.offWords.y, wordsTop, wordsBottom, blockH);
  const xNudge = Math.round(((settings.offWords && settings.offWords.x) || 0) * W);
  const stacked = rowH >= wordFs * 2.4;
  const gap = Math.round(W * 0.014);
  // rough proportional width estimates (latin ~0.55em, CJK ~1em, phonetic slimmer)
  const estW = (s, fs) => {
    let u = 0;
    for (const ch of String(s)) u += /[　-鿿豈-﫿]/.test(ch) ? 1 : (ch === ' ' ? 0.3 : 0.55);
    return u * fs;
  };
  const fit = (x, y, s, fs, fill, weight, maxW) => {
    const nat = estW(s, fs);
    const tl = nat > maxW ? ` textLength="${Math.round(maxW)}" lengthAdjust="spacingAndGlyphs"` : '';
    return `<text x="${x}" y="${y}" font-family="${fam}" font-size="${fs}" fill="${fill}" font-weight="${weight}"${tl}>${esc(s)}</text>`;
  };
  words.forEach((w, i) => {
    const rowY = blockTop + i * rowH;
    const midY = rowY + rowH / 2;
    // 词义本身就是信息层级的起点；不再为每一项占用编号空间。
    const ix = margin + xNudge;
    const meaning = (w.pos ? w.pos + ' ' : '') + (w.meaning || '');
    if (stacked) {
      parts.push(text(ix, midY - rowH * 0.16 + wordFs * 0.36, w.word, wordFs, t.ink, 700));
      const ww = estW(w.word, wordFs);
      if (w.phonetic) parts.push(fit(ix + ww + W * 0.015, midY - rowH * 0.16 + wordFs * 0.36, w.phonetic, wordFs * 0.48, t.sub, 400, W - ix - ww - margin - W * 0.015));
      parts.push(fit(ix, midY + rowH * 0.22 + wordFs * 0.18, meaning, wordFs * 0.54, t.sub, 400, W - ix - margin));
    } else {
      const baseY = midY + wordFs * 0.36;
      parts.push(fit(ix, baseY, w.word, wordFs, t.ink, 700, W * 0.42));
      let tx = ix + Math.min(estW(w.word, wordFs), W * 0.42) + gap;
      if (w.phonetic) {
        parts.push(fit(tx, baseY, w.phonetic, wordFs * 0.48, t.sub, 400, W * 0.2));
        tx += Math.min(estW(w.phonetic, wordFs * 0.48), W * 0.2) + gap;
      }
      parts.push(fit(tx, baseY, meaning, wordFs * 0.5, t.sub, 400, W - tx - margin));
    }
    if (i < n - 1) parts.push(`<line x1="${margin + xNudge}" y1="${rowY + rowH}" x2="${W - margin + xNudge}" y2="${rowY + rowH}" stroke="${t.line || 'rgba(128,128,128,0.18)'}" stroke-width="1"/>`);
  });

  if (hasRem) {
    const fs = remFs;
    const remX = margin + Math.round(((settings.offReminders && settings.offReminders.x) || 0) * W);
    let y = remTop + remLh;                       // 「今日提醒」表头基线
    parts.push(text(remX, y, '今日提醒', fs, t.accent, 600));
    reminders.slice(0, 6).forEach(r => {
      y += remLh;
      parts.push(`<rect x="${remX}" y="${y - fs * 0.7}" width="${fs * 0.9}" height="${fs * 0.9}" fill="none" stroke="${t.sub}" stroke-width="${Math.max(1, W * 0.0012)}"/>`);
      parts.push(text(remX + fs * 1.5, y, r.text + (r.time ? ' · ' + r.time : ''), fs, t.ink, 400));
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;
}

/* sips writes a unique SVG/PNG pair per raster. Keep them only long enough for
 * an in-flight render (and the layout test that reads the SVG) to finish. */
function forgetTemp(file) {
  if (!file) return;
  const timer = setTimeout(() => { try { fs.unlinkSync(file); } catch {} }, 8000);
  if (timer.unref) timer.unref();
}
function sweepRasterTemps() {
  const dir = os.tmpdir();
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    const stamped = /^dw_\d+_\d+\.(svg|png)$/.test(name) || /^dw_\d+_\d+\.svg\.png$/.test(name);
    const ocr = name === 'dw_ocr.png';
    if (!stamped && !ocr) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > (ocr ? 10 * 60 * 1000 : 60 * 1000)) fs.unlinkSync(full);
    } catch {}
  }
}
/* sips is one machine-wide rasterizer. Pet clicks and wallpaper pushes both
 * call this; a queue keeps those jobs from overlapping. */
const rasterJobs = [];
let rasterBusy = false;
function rasterizeSVG(svg, outPng, W, H, cb) {
  rasterJobs.push({ svg, outPng, W, H, cb });
  pumpRaster();
}
function pumpRaster() {
  if (rasterBusy) return;
  const job = rasterJobs.shift();
  if (!job) return;
  rasterBusy = true;
  rasterizeSVGNow(job.svg, job.outPng, job.W, job.H, (err, png) => {
    rasterBusy = false;
    try { if (job.cb) job.cb(err, png); } catch {}
    pumpRaster();
  });
}
function placeRaster(from, outPng) {
  try {
    // Keep the destination inode. Replacing the file (rename / atomic write)
    // makes macOS treat the next desktop set as a brand-new picture.
    wallpaperFiles.writeBufferInPlace(fs, outPng, fs.readFileSync(from));
  } catch (err) { return err; }
  try { fs.unlinkSync(from); } catch { /* temp already gone */ }
  return null;
}
function rasterizeSVGNow(svg, outPng, W, H, cb) {
  const tag = Date.now() + '_' + Math.floor(Math.random() * 1e6);
  const tmpSvg = path.join(os.tmpdir(), 'dw_' + tag + '.svg');
  fs.writeFileSync(tmpSvg, svg);
  // sips rasterizes SVG -> PNG at the SVG's own dimensions (macOS built-in).
  // (qlmanage would letterbox to a square thumbnail, so we don't use it.)
  const tmpPng = path.join(os.tmpdir(), 'dw_' + tag + '.png');
  const finish = (err, png) => {
    forgetTemp(tmpSvg);
    forgetTemp(tmpPng);
    cb(err, png);
  };
  execFile('sips', ['-s', 'format', 'png', tmpSvg, '--out', tmpPng], { timeout: 20000 }, (err) => {
    if (err || !fs.existsSync(tmpPng)) {
      // fallback: try qlmanage
      return execFile('qlmanage', ['-t', '-s', String(W), '-o', os.tmpdir(), tmpSvg], { timeout: 20000 }, (e2) => {
        const produced = path.join(os.tmpdir(), 'dw_' + tag + '.svg.png');
        if (e2 || !fs.existsSync(produced)) return finish(new Error('rasterize failed'), null);
        const placeErr = placeRaster(produced, outPng);
        forgetTemp(produced);
        if (placeErr) return finish(placeErr, null);
        finish(null, outPng);
      });
    }
    const placeErr = placeRaster(tmpPng, outPng);
    if (placeErr) return finish(placeErr, null);
    finish(null, outPng);
  });
}

/* ---------------- floating "pet" window (zero-dep, JXA + WKWebView) ----------------
 * A real always-on-top mini panel showing today's words + reminders, rendered as
 * HTML in a borderless-ish WKWebView. No install, no focus stealing (Accessory
 * policy), lives on every Space. Respawned on a timer to refresh its content;
 * killed on companion exit. */
const PET_FOOTER_H = 78;
const PET_BTN = { w: 110, h: 34, bottomPad: 10, gap: 8, count: 3 };
// SVG 与 JXA 共用同一套几何，避免视觉元素与鼠标热区错位。
const PET_FRAME = { padX: 14, padY: 12, headerH: 54, bodyBottomGap: 7 };
// 视觉为圆形小把手，热区略大，避免旧版直角三角形既突兀又难抓。
const PET_RESIZE = { pad: 9, size: 36 };
// 六个连续词槽在最小尺寸下仍需要完整展示中文，因此不再允许缩到无法学习的细条。
const MIN_PET_W = 280, MIN_PET_H = 360, MAX_PET = 520;   // 宠物可拉伸的尺寸范围 (pt)

/* 形状 → 排列模式：竖版窄条=逐行堆叠；横版宽条=每词一列；方形=两列网格。 */
function petMode(W, H) {
  const r = W / H;
  if (r >= 1.32) return 'wide';
  if (r <= 0.72) return 'tall';
  return 'square';
}
/* 文字等比缩放：相对默认卡（320×428）的几何平均比例，放大卡片字也跟着放大。
 * clamp 到 0.74–1.65，让放大有辨识度但不会变成遮挡桌面的巨型卡片。 */
function petScale(W, H) {
  const s = Math.sqrt((W / 320) * (H / 428));
  return Math.max(0.74, Math.min(1.65, s));
}

/* 四套界面主题共用同一套几何与命中区域，只替换材质。Liquid 的外壳会
 * 露出下方原生 NSGlassEffectView；词卡仍保持较实的承载面，确保细字可读。 */
const PET_SKINS = {
  editorial: {
    font: 'Avenir Next, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif',
    shell: '#172731', shell2: '#233945', shellLine: '#49606c', shellOpacity: .965,
    top1: '#223744', top2: '#1b2e39', top3: '#263e49', topOpacity: 1,
    card: '#f5f0e7', card2: '#ebe4d9', cardStroke: '#d5cec2', cardOpacity: 1,
    ink: '#27343b', sub: '#686159', phonetic: '#59615f',
    moss: '#648f7d', rust: '#b96e55', rustStrong: '#914d3b', gold: '#c7a56b', mist: '#dce4e2',
    title: '#f5f0e7', titleSub: '#aebdc3', empty: '#f3eee5', emptySub: '#9eafb5', footerSub: '#9eafb5', reminder: '#d8e0df',
    avatarOuter: '#14232d', avatarStroke: '#c7a56b', avatarFace: '#1d303b', avatarInk: '#e8dfd0', avatarAccent: '#c7a56b',
    closeFill: '#324955', closeStroke: '#607580', closeInk: '#edf1ef',
    prevFill: '#2c414c', prevStroke: '#617783', prevInk: '#f6f0e8', memoryFill: '#496f63', memoryStroke: '#7da190', memoryInk: '#f6f0e8', nextFill: '#914d3b', nextStroke: '#c98a72', nextInk: '#f6f0e8',
    handleFill: '#f5f0e7', handleStroke: '#c7a56b', handleInk: '#233945', shellShadow: '#071116', shellShadowOpacity: .34, cardShadow: '#071116', cardShadowOpacity: .2,
  },
  anime: {
    font: 'Yuanti SC, YouYuan, PingFang SC, Hiragino Sans GB, sans-serif',
    shell: '#f8f2ff', shell2: '#e9f7ff', shellLine: '#c3a8e8', shellOpacity: .985,
    top1: '#fff3fa', top2: '#f0eaff', top3: '#d9f5ed', topOpacity: .97,
    card: '#fffdfd', card2: '#f8f0ff', cardStroke: '#e2cdec', cardOpacity: 1,
    ink: '#40335f', sub: '#7c709d', phonetic: '#9b79ad',
    moss: '#65cdb1', rust: '#ff82b2', rustStrong: '#a777e8', gold: '#f3d76b', mist: '#edf9ff',
    title: '#40335f', titleSub: '#806f9e', empty: '#51416f', emptySub: '#8e7ca9', footerSub: '#8b77a5', reminder: '#5d4b7c',
    avatarOuter: '#5b4586', avatarStroke: '#f3d76b', avatarFace: '#6d55a0', avatarInk: '#fff6fb', avatarAccent: '#f3d76b',
    closeFill: '#fffafd', closeStroke: '#d5c2ed', closeInk: '#7a63a6',
    prevFill: '#f4eeff', prevStroke: '#cbb4ec', prevInk: '#7153a7', memoryFill: '#e4f7ff', memoryStroke: '#9fcef1', memoryInk: '#386888', nextFill: '#ff82b2', nextStroke: '#d967a1', nextInk: '#fffdfd',
    handleFill: '#fffdfd', handleStroke: '#b9a0df', handleInk: '#7658aa', shellShadow: '#8063ad', shellShadowOpacity: .18, cardShadow: '#8e6bb6', cardShadowOpacity: .14,
  },
  liquid: {
    font: '-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif',
    shell: '#fbfbfd', shell2: '#ececf1', shellLine: '#ffffff', shellOpacity: .36,
    top1: '#ffffff', top2: '#f7f4f7', top3: '#f1f5f2', topOpacity: .44,
    card: '#ffffff', card2: '#f4f4f7', cardStroke: '#ffffff', cardOpacity: .84,
    ink: '#1d1d1f', sub: '#626269', phonetic: '#6e6e73',
    moss: '#248a53', rust: '#636366', rustStrong: '#007aff', gold: '#ffffff', mist: '#ffffff',
    title: '#1d1d1f', titleSub: '#66666e', empty: '#2c2c2e', emptySub: '#6e6e73', footerSub: '#6e6e73', reminder: '#48484a',
    avatarOuter: '#ffffff', avatarStroke: '#d8d8de', avatarFace: '#f7f7fa', avatarInk: '#48484a', avatarAccent: '#248a53',
    closeFill: '#ffffff', closeStroke: '#ffffff', closeInk: '#3a3a3c',
    prevFill: '#fafafd', prevStroke: '#ffffff', prevInk: '#3a3a3c', memoryFill: '#f2f2f7', memoryStroke: '#d8d8de', memoryInk: '#3a3a3c', nextFill: '#007aff', nextStroke: '#84bdff', nextInk: '#ffffff',
    handleFill: '#fafafd', handleStroke: '#ffffff', handleInk: '#3a3a3c', shellShadow: '#000000', shellShadowOpacity: .13, cardShadow: '#000000', cardShadowOpacity: .09,
    liquid: true,
  },
  darkliquid: {
    font: '-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, sans-serif',
    shell: '#121726', shell2: '#0c101c', shellLine: '#7d97cf', shellOpacity: .82,
    top1: '#1c2438', top2: '#151c2e', top3: '#1a2338', topOpacity: .96,
    card: '#1a2236', card2: '#131a2c', cardStroke: '#55709f', cardOpacity: .92,
    ink: '#e8edf8', sub: '#93a0bd', phonetic: '#8b98b8',
    moss: '#5ec99a', rust: '#e08e8e', rustStrong: '#7aa2f7', gold: '#a9c0f2', mist: '#2a3450',
    title: '#eef2fb', titleSub: '#97a2bd', empty: '#dbe2f2', emptySub: '#8b98b8', footerSub: '#7d89a8', reminder: '#c6d2ee',
    avatarOuter: '#232e4a', avatarStroke: '#7aa2f7', avatarFace: '#2b3757', avatarInk: '#dbe4f6', avatarAccent: '#7aa2f7',
    closeFill: '#202a44', closeStroke: '#56698f', closeInk: '#c6d2ee',
    prevFill: '#222c48', prevStroke: '#56698f', prevInk: '#dbe2f2', memoryFill: '#1f3a56', memoryStroke: '#4a7db4', memoryInk: '#dbe2f2', nextFill: '#5e7fd0', nextStroke: '#8fb0f5', nextInk: '#0d1117',
    handleFill: '#232e4a', handleStroke: '#7aa2f7', handleInk: '#c6d2ee', shellShadow: '#000000', shellShadowOpacity: .5, cardShadow: '#000000', cardShadowOpacity: .35,
    liquid: true, dark: true,
  },
};
function petSkin(name) { return PET_SKINS[PET_UI_THEMES.has(name) ? name : 'editorial']; }

/* ---------------- Patrick 派大星形态(桌面漫游宠物) ----------------
 * 形态二：无边框透明小窗,派大星精灵图 + 20fps 状态机动画,在桌面自由散步。
 * 交互: 悬停=停下挥手+语音气泡(单词+释义+例句); 点击=跳跃+本地 TTS 朗读;
 *       拖动=手动摆放; 点词区(气泡上的词)=记首轮(与卡片形态一致)。
 * 形态切换: 卡片头部 ⭐ 按钮 / 派大星右键菜单 → 互转,尺寸互相独立保存。 */
const PATRICK_SHEET = path.join(ROOT, 'assets', 'patrick', 'sheet.png');
const PATRICK_SHEET_FLIP = path.join(ROOT, 'assets', 'patrick', 'sheet_flip.png');
// 6x4 网格,与 scripts/build_patrick_sheet.py 的 FRAME_MAP 一一对应。
const PATRICK_CELL = { w: 192, h: 208, cols: 6, rows: 4 };
// slot: 0 idle0  1 idle1  2 blink  3 lookL  4 lookR  5 wave0
//       6..13 walk 循环      14 wave1  15 happy0 16 happy1
//       17 sad0 18 sad1 19 think0 20 angry0 21 front0
// 精灵图里 8 个"行走"帧其实是两组朝向:slot 6–9 朝右、slot 10–13 朝左
// (逐帧眼睛/眉毛重心实测 Δ=+16 / -16)。必须按朝向选组,否则走两步就"掉头"。
const PATRICK_FRAME = { idle0: 0, idle1: 1, blink: 2, lookL: 3, lookR: 4, wave0: 5,
  walkR0: 6, walkL0: 10, wave1: 14, happy0: 15, happy1: 16, sad0: 17, sad1: 18, think0: 19, angry0: 20, front0: 21 };
const PET_MODES = new Set(['card', 'patrick']);
const PATRICK_DEFAULT = { w: 190, h: 206 };   // 派大星显示尺寸(pt, 2x 位图清晰;太小看不清表情)
const PATRICK_MIN = 90, PATRICK_MAX = 420;
/* 语音:优先 edge-tts(微软神经语音,接近真人),不可用时回退系统 say。
 * 按用户要求**只朗读英文**(单词与英文例句),中文释义不出声。 */
const PATRICK_TTS = {
  engine: 'edge',                       // 'edge' | 'say'
  // edge-tts 可执行文件:优先 App 内自带,其次仓库里的 venv(同机)。
  // venv 的 shebang 是绝对路径,复制到别处会失效,所以按顺序探测真实可用的那个。
  edgeBin: (() => {
    const candidates = [
      path.join(ROOT, '.venv-tts', 'bin', 'edge-tts'),
      path.join(os.homedir(), 'daily-wallpaper', '.venv-tts', 'bin', 'edge-tts'),
    ];
    return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || candidates[0];
  })(),
  edgeVoice: process.env.WORDPAPER_TTS_VOICE || 'en-US-AriaNeural',
  edgeRate: process.env.WORDPAPER_TTS_RATE || '+0%',
  fallbackVoice: 'Samantha',
  fallbackRate: 165,
};
/* 答题音效:用 macOS 内置音效(零依赖、无需打包音频)。
 * 对 = Glass(清脆上扬) + Hero(短促胜利感);错 = Basso(低沉) + Sosumi(经典"错误"音)。 */
const QUIZ_SFX = {
  correct: ['/System/Library/Sounds/Glass.aiff', '/System/Library/Sounds/Hero.aiff'],
  wrong: ['/System/Library/Sounds/Basso.aiff', '/System/Library/Sounds/Sosumi.aiff'],
};
function playSfx(kind, cb) {
  const files = QUIZ_SFX[kind] || [];
  if (!files.length || !isMac) return cb && cb();
  const playOne = (i) => {
    if (i >= files.length) return cb && cb();
    execFile('/usr/bin/afplay', [files[i]], { timeout: 8000 }, () => playOne(i + 1));
  };
  playOne(0);
}

/* 本地 TTS 串行队列:词(英文,略慢)+释义(中文)。say 是本机合成,离线可用;
 * 一次朗读 = 词 → 短停 → 释义/例句,经 -w /tmp 文件播放避免 say 阻塞前台。 */
const ttsQueue = [];
let ttsBusy = false;
let ttsProc = null;            // 正在跑的 afplay / edge-tts 子进程(可被 ttsStopNow 掐断)
let ttsGen = 0;                // 代际:每次掐断 +1,旧的异步回调看到代际变了就自我作废
/* 朗读一段英文:edge-tts 合成 mp3 → afplay 播放。失败回退 macOS say。
 * 只用于英文(单词/例句);中文释义不朗读。
 * opts.gen:调用时的代际;播放前若代际已变(用户掐断了)就丢弃,绝不播旧内容。 */
function ttsSpeak(text, cb, opts) {
  const safe = String(text || '').trim();
  if (!safe || !isMac) return cb && cb(new Error('empty text'));
  const myGen = opts && typeof opts.gen === 'number' ? opts.gen : ttsGen;
  speechAudio.prepare(safe, selectedVoice().id, (err, audio) => {
    if (myGen !== ttsGen) return;
    if (err) return cb && cb(err);
    const child = execFile('/usr/bin/afplay', [audio.file], {timeout:120000}, error => {
      if (ttsProc === child) ttsProc = null;
      if (myGen === ttsGen && cb) cb(error);
    });
    ttsProc = child;
    if (opts && opts.onStart) opts.onStart();
  });
}
/* 立刻掐断:停掉正在播的那一条 + 清空队列 + 换代际(排队中的合成/播放全部作废)。
 * 抽查卡弹出、切词、提问时用——用户要"只有按钮上这个词的声音",旧声音必须先死。 */
function ttsStopNow(reason = 'cancelled') {
  finishSpeakCard(reason);
  ttsGen++;
  ttsQueue.length = 0;
  const child = ttsProc;
  ttsProc = null;
  if (child) { try { child.kill('SIGKILL'); } catch {} }
  ttsBusy = false;
}
/* 朗读音频缓存:同一个词第二次考、或卡片上屏那一刻要立刻出声时,
 * 现场跑 edge-tts 要 300–800ms,音画就对不上了。出题时先**预合成**到缓存,
 * 卡片滑入动画一结束直接 afplay,声音和卡片同时出现。 */
const TTS_CACHE_DIR = path.join(RUNTIME_ROOT, 'tts-cache');
const speechModule = require('./lib/speech');
const mouthModule = require('./lib/patrick-mouth');
function selectedVoice() {
  return speechModule.voiceById(CFG.speechVoice)
    || speechModule.VOICES.find(v => v.voice === process.env.WORDPAPER_TTS_VOICE)
    || speechModule.VOICES[0];
}
const speechAudio = speechModule.createSpeechService({
  cacheDir:TTS_CACHE_DIR, edgeBin:PATRICK_TTS.edgeBin, execFile,
  rate:PATRICK_TTS.edgeRate, fallbackVoice:PATRICK_TTS.fallbackVoice, fallbackRate:PATRICK_TTS.fallbackRate,
});
function ttsPrewarm(text, cb) {
  speechAudio.prepare(String(text || '').trim(), selectedVoice().id, (err,audio) => cb && cb(err,audio && audio.file));
}

/* 切词/提问时同时结束当前播放与气泡,避免队列换代后完成回调失效而悬挂。 */
function ttsClear() {
  ttsStopNow();
}
/* 当前桌面上**看得见**的文本:小词灵这一页的 6 个词 + 各自的英文例句。
 * 用户要求:只朗读当前显示的单词;没显示的词(比如抽查里别的到期词)一律不发声,
 * 否则就是"看不见的幽灵单词在念"。 */
function displayedSpeechTexts() {
  const set = new Set();
  const add = (t) => { const v = String(t || '').trim().toLowerCase(); if (v) set.add(v); };
  try {
    petFirstPassWords().forEach(w => {
      if (!w) return;
      add(w.word);
      const ex = exampleForWord(CFG.library, w);
      if (ex && ex.en) add(ex.en);
    });
  } catch {}
  // 卡片上**印着**的字也算「看得见」:抽查卡/朗读卡/回答卡都在屏幕上,
  // 用户能读到,读出来才不突兀(否则就会出现"问我认不认识却不出声")。
  try {
    if (patrickQuizState && patrickQuizState.word) add(patrickQuizState.word.word);
    if (speakCardState && speakCardState.word) add(speakCardState.word.word);
    if (speakCardState && speakCardState.example && speakCardState.example.en) add(speakCardState.example.en);
    if (answerCardState && answerCardState.word) add(answerCardState.word.word);
  } catch {}
  return set;
}
function ttsTextIsDisplayed(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  const allowed = displayedSpeechTexts();
  if (allowed.has(t)) return true;
  for (const a of allowed) { if (a && (t.includes(a) || a.includes(t))) return true; }
  return false;
}
function ttsEnqueue(items, opts) {
  // opts.allow: 调用方明确声明「这几个字正显示在屏幕卡片上」。
  const extra = new Set(((opts && opts.allow) || []).map(t => String(t || '').trim().toLowerCase()).filter(Boolean));
  // ── 抽查硬锁 ──
  // 抽查卡在屏(= patrickQuizState 存在)期间,**只有卡上被考的那个词**可以发声。
  // 只有用户点击当前题目所创建的朗读会话,可以额外读它自己的例句。
  // 普通 allow 不能绕过这道锁,旧会话或其它题目的例句仍会被丢弃。
  const lockWord = patrickQuizState && patrickQuizState.word
    ? String(patrickQuizState.word.word || '').trim().toLowerCase() : '';
  items.forEach(item => {
    if (!item || !item.text) return;
    const t = String(item.text || '').trim().toLowerCase();
    if (lockWord) {
      const speech = speakCardState;
      const currentExample = speech && speech.id === opts?.speechId && speech.quizId === patrickQuizState.id
        && t === String(speech.example?.en || '').trim().toLowerCase();
      if (t !== lockWord && !currentExample) {
        console.error('[companion] TTS 丢弃(抽查中只读考题词):', String(item.text).slice(0, 40));
        return;
      }
      ttsQueue.push(item);
      return;
    }
    if (!extra.has(t) && !ttsTextIsDisplayed(item.text)) {
      console.error('[companion] TTS 丢弃非当前页文本:', String(item.text).slice(0, 40));
      return;
    }
    ttsQueue.push(item);
  });
  if (ttsQueue.length > 24) ttsQueue.splice(0, ttsQueue.length - 24);   // 疯狂连点只保留最近
  pumpTts();
}
function pumpTts() {
  // 守卫:派大星窗口不在(被关/崩溃)时丢弃队列,避免"看不见人却在说话"。
  if (!patrickVisible && !petVisible) { ttsQueue.length = 0; finishSpeakCard('cancelled'); return; }
  if (ttsBusy || !ttsQueue.length) return;
  ttsBusy = true;
  const item = ttsQueue.shift();
  const gen = ttsGen;
  ttsSpeak(item.text, (err) => {
    if (gen !== ttsGen) return;   // 这一代已被掐断:别把新的队列当成自己的继续泵
    ttsBusy = false;
    if (item.after) { try { item.after(err); } catch {} }
    pumpTts();
  }, { gen, onStart: () => { if (gen === ttsGen && item.onStart) item.onStart(); } });
}

/* 词→例句:优先读预生成 data/examples_<lib>.json(离线词典缓存);custom 词库
 * 词条自带 example 字段。返回 {en, zh} 或 null。 */
const examplesCache = {};
function examplesForLibrary(library) {
  if (examplesCache[library]) return examplesCache[library];
  let data = null;
  try { data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `examples_${library}.json`), 'utf8')); } catch {}
  examplesCache[library] = data || {};
  return examplesCache[library];
}
function exampleForWord(library, word) {
  if (word && word.example) return { en: String(word.example), zh: '' };
  const lib = examplesForLibrary(library);
  const hit = lib[word && word.word] || lib[(word && word.word || '').toLowerCase()];
  if (!hit || !hit.length) return null;
  const s = String(hit[0]);
  // "to be amused at or by sth 被某事物逗乐" → 英文段 + 中文段(第一个 CJK 字符处切)
  const m = s.match(/^(.*?[a-zA-Z'”’\)\]])\s*([\u4e00-\u9fff].*)$/);
  return m ? { en: m[1].trim(), zh: m[2].trim() } : { en: s, zh: '' };
}

/* 派大星漫游窗状态(伴侣进程侧):TTS 播放中的高亮、当前悬停词由 JXA 窗口本地
 * 管理;这里只保存 config 与尺寸/位置持久化路径。 */
const PATRICK_POS_PATH = path.join(RUNTIME_ROOT, 'patrick-position.json');
const patrickIdle = require('./lib/patrick-idle');

function buildPatrickJXA(opts) {
  const meta = {
    cell: PATRICK_CELL, frame: PATRICK_FRAME,
    W: opts.W, H: opts.H, port: CFG.port, ownerPid: process.pid,
    frameNames: opts.frameNames,
    sheetPath: PATRICK_SHEET, sheetFlipPath: PATRICK_SHEET_FLIP,
    posFile: PATRICK_POS_PATH, closeFile: PET_CLOSED_PATH,
    idleFile: path.join(RUNTIME_ROOT, 'patrick-idle.json'),
    idleMasksPath: path.join(ROOT, 'assets', 'patrick', 'skin-masks.json'),
    words: opts.words,
    statusUrl: 'http://127.0.0.1:' + CFG.port + '/pet-word-status.json',
    statusBubblePng: path.join(os.tmpdir(), `dw_status_bubble-${process.pid}.png`),
    speakUrl: 'http://127.0.0.1:' + CFG.port + '/pet-speak.php',
    speakShownUrl: 'http://127.0.0.1:' + CFG.port + '/pet-speak-shown.php',
    speakFinishedUrl: 'http://127.0.0.1:' + CFG.port + '/pet-speak-finished.php',
    morphUrl: 'http://127.0.0.1:' + CFG.port + '/pet-mode.php?mode=card',
    quizPng: CARD_PNG.quiz,
    quizW: PET_QUIZ_W, quizH: PET_QUIZ_H,
    quizBtnTop: QUIZ_BTN_TOP, quizBtnBottom: QUIZ_BTN_BOTTOM, quizBtnSkipX1: QUIZ_BTN_SKIP_X1,
    speakPng: CARD_PNG.speak,
    answerPng: CARD_PNG.answer,
    answerW: ANSWER_CARD_W, answerH: ANSWER_CARD_H,
    keys: opts.keys,
    roam: CFG.petRoam !== false && featureOn('betaCompanionRoam'),
    dark: opts.dark === true,
    exampleLines: opts.exampleLines || [],
  };
  return `ObjC.import('Cocoa');
ObjC.import('AVFoundation');
ObjC.import('stdlib');
ObjC.bindFunction('getppid', ['int', []]);
function run(argv){
  var M = ${JSON.stringify(meta)};
  var CELL = M.cell, FR = M.frameNames;
  var W = M.W, H = M.H;
  var OWNER_PPID = String($.getppid());   // 启动时取一次(2s 心跳里不再走 bridge)
  var sheet = $.NSImage.alloc.initWithContentsOfFile(M.sheetPath);
  if (!sheet || sheet.isNil()) { return; }
  // 睡眠唤醒的瞬间 NSScreen.mainScreen 可能是 nil(实测:凌晨 2:45-6:30 崩溃循环,
  // 报 undefined is not an object evaluating screen.origin),这里给兜底屏。
  var mainScreen = $.NSScreen.mainScreen;
  var screen = (mainScreen && mainScreen.frame) ? mainScreen.frame : $.NSMakeRect(0, 0, 1512, 982);
  var x = screen.origin.x + screen.size.width - W - 42, y = screen.origin.y + screen.size.height * 0.30;
  try {
    var savedTxt = $.NSString.stringWithContentsOfFileEncodingError(M.posFile, $.NSUTF8StringEncoding, $());
    var saved = JSON.parse((savedTxt && savedTxt.js) || '{}');
    if (typeof saved.x === 'number') { x = saved.x; y = saved.y; }
  } catch (e) {}
  x = Math.max(screen.origin.x + 4, Math.min(x, screen.origin.x + screen.size.width - W - 4));
  y = Math.max(screen.origin.y + 4, Math.min(y, screen.origin.y + screen.size.height - H - 4));
  var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(x, y, W, H), $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
  win.opaque = false; win.backgroundColor = $.NSColor.clearColor;
  win.level = $.NSFloatingWindowLevel;
  win.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorIgnoresCycle;
  win.hasShadow = false;

  // 状态机: idle / walk(走向目标) / hover(挥手) / jump / drag / quiz。
  // 动画统一走 animSeq 帧序列;50ms tick 驱动全部逻辑。
  var st = {
    mode: 'idle', frame: FR.idle0, facing: 1,
    target: null, targetY: null,
    animSeq: null, animSeqIdx: 0, animSeqFrame: 0, animSeqOnce: false, animLast: 0, animTickMs: 140, animThen: null,
    blinkAt: Date.now() + 1500 + Math.random() * 3000,
    idleHoldUntil: 0, walkSpeed: 1.2,
    hover: false, quiz: false,
    speakIndex: -1,     // 点击轮换朗读 6 个词;-1 表示还没读过(首次点读第 0 个)
    fx: null,           // 答题特效: {kind:'correct'|'wrong', start, dur}
    fxParticles: [],    // 答对时的小星星
    shakeUntil: 0,      // 答错时的抖动结束时间
  };
  var bubble = null;      // {lines:[{text,size,color}], until}
  var quizWin = null;     // 抽查卡子窗(点选项作答)
  var quizGripView = null;   // 子窗的绘图视图(mtime 轮询重绘目标)
  var quizScrollView = null;
  var cardKind = '';         // 'quiz' | 'answer' —— 朗读气泡有自己的窗口
  var lastQuizGeom = null;   // 伴侣按内容算的命中区 {w,h,optTop,optH,optCount,btnTop,btnBottom}
  var downState = null;
  var darkSkin = M.dark === true;
  function reduceMotion(){
    try { return !!$.NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion; } catch (e) { return false; }
  }

  var createIdleClock = ${patrickIdle.createIdleClock.toString()};
  ${fs.readFileSync(path.join(ROOT, 'lib', 'patrick-idle-native.js'), 'utf8')}

  function setFrame(){ win.setFrameDisplay($.NSMakeRect(x, y, W, H), true); }
  setFrame();
  // 镜像 sheet 的列序是反的:slot c 的画面在镜像图上的 (cols-1-c) 列。
  // 帧序号 → 图上的 (col,row)。左右朝向各有自己的帧组,不再靠整图镜像。
  function drawSprite(idx, R){
    var srcW = CELL.w, srcH = CELL.h, cols = CELL.cols;
    var col = idx % cols, row = Math.floor(idx / cols);
    var sy = sheet.size.height - (row + 1) * srcH;   // 源图上而下 → Cocoa 下而上
    sheet.drawInRectFromRectOperationFraction(R, $.NSMakeRect(col * srcW, sy, srcW, srcH), $.NSCompositeSourceOver, 1);
  }
  // Prepare small masks from the original ink pixels once. This preserves the
  // cheek texture and avoids painting a rectangular pink patch over the face.
  var mouthFaces=${JSON.stringify(mouthModule.FRAMES)}, mouthMasks={};
  function prepareMouthMasks(){
    try {
      var bitmap=$.NSBitmapImageRep.imageRepWithData(sheet.TIFFRepresentation);
      Object.keys(mouthFaces).forEach(function(key){
        var face=mouthFaces[key],idx=Number(key),ox=(idx%CELL.cols)*CELL.w,oy=Math.floor(idx/CELL.cols)*CELL.h;
        var mask=$.NSBezierPath.bezierPath;
        for(var py=face.y;py<face.y+face.h;py++){
          var run=-1;
          for(var px=face.x;px<=face.x+face.w;px++){
            var ink=false;
            if(px<face.x+face.w){
              var color=bitmap.colorAtXY(ox+px,oy+py);
              ink=color.redComponent<.97 && color.greenComponent<.64 && color.blueComponent<.61;
            }
            if(ink && run<0)run=px;
            if(!ink && run>=0){mask.appendBezierPathWithRect($.NSMakeRect(run-.12,CELL.h-py-1.12,px-run+.24,1.24));run=-1;}
          }
        }
        mouthMasks[key]=mask;
      });
    }catch(e){mouthMasks={};}
  }
  prepareMouthMasks();
  function pixelMouthOval(x,y,w,h){
    var shape=$.NSBezierPath.bezierPath;
    for(var row=0;row<h;row+=2){
      var ny=(row+1-h/2)/(h/2),span=Math.max(2,Math.round(w*Math.sqrt(Math.max(0,1-ny*ny))/4)*2);
      shape.appendBezierPathWithRect($.NSMakeRect(x+w/2-span,y+row,span*2,Math.min(2,h-row)));
    }
    return shape;
  }
  function drawSpeechMouth(idx,R){
    if(!speakMouth || speakMouth.open<.025 || reduceMotion())return;
    var face=mouthFaces[idx],mask=mouthMasks[idx];
    if(!face || !mask)return;
    $.NSGraphicsContext.saveGraphicsState;
    var tr=$.NSAffineTransform.transform;
    tr.translateXByYBy(R.origin.x,R.origin.y);tr.scaleXByYBy(R.size.width/CELL.w,R.size.height/CELL.h);tr.concat;
    rgba(248/255,151/255,140/255,1).setFill;mask.fill;
    var open=speakMouth.open,round=speakMouth.round;
    var w=Math.round((40-22*round+open*4)/2)*2,h=Math.max(4,Math.round((3+open*(15+5*round))/2)*2);
    var left=Math.round(face.cx-w/2),bottom=CELL.h-Math.round(face.cy+open*2+h/2);
    // A stepped oval keeps the original pixel linework, with a soft inner tongue.
    var lip=pixelMouthOval(left,bottom,w,h);
    rgba(.055,.025,.035,1).setFill;lip.fill;
    if(h>=8){
      rgba(.29,.105,.15,1).setFill;
      pixelMouthOval(left+3,bottom+2,w-6,h-4).fill;
      rgba(.89,.43,.49,1).setFill;
      var tw=Math.max(6,Math.round(w*.52/2)*2);
      pixelMouthOval(Math.round(face.cx-tw/2),bottom+2,tw,Math.min(6,h-4)).fill;
    }
    $.NSGraphicsContext.restoreGraphicsState;
  }
  /* 答题特效:
   * correct → 一圈扩散的绿色光环 + 8 颗向上飘的小星星(0.9s)
   * wrong   → 红色圆环闪一下(配合 shakeUntil 的窗口抖动) */
  function drawFx(R){
    if (!st.fx) return;
    var age = (Date.now() - st.fx.start) / st.fx.dur;
    if (age >= 1) { st.fx = null; st.fxParticles = []; return; }
    var cx = R.origin.x + R.size.width / 2;
    var cy = R.origin.y + R.size.height / 2;
    var ease = 1 - Math.pow(1 - age, 3);
    if (st.fx.kind === 'correct') {
      var ringR = 24 + ease * 70;
      var alpha = (1 - age) * 0.85;
      $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.30, 0.78, 0.49, alpha).setStroke;
      var ring = $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(cx - ringR, cy - ringR, ringR * 2, ringR * 2));
      ring.lineWidth = 3.5 * (1 - age) + 1;
      ring.stroke;
      // 小星星:8 颗,从中心向外+向上飘
      for (var i = 0; i < st.fxParticles.length; i++) {
        var p = st.fxParticles[i];
        var px = cx + p.dx * ease * 1.6;
        var py = cy + p.dy * ease * 1.6 + ease * ease * 18;   // 越飘越向上
        var a2 = (1 - age) * p.alpha;
        var sz = p.size * (1 - age * 0.45);
        $.NSColor.colorWithSRGBRedGreenBlueAlpha(p.r, p.g, p.b, a2).setFill;
        var star = $.NSBezierPath.bezierPath;
        for (var k = 0; k < 5; k++) {
          var outer = k * 2 * Math.PI / 5 - Math.PI / 2;
          var inner = outer + Math.PI / 5;
          var ox = px + Math.cos(outer) * sz, oy = py + Math.sin(outer) * sz;
          var ix = px + Math.cos(inner) * sz * 0.45, iy = py + Math.sin(inner) * sz * 0.45;
          if (k === 0) star.moveToPoint($.NSMakePoint(ox, oy)); else star.lineToPoint($.NSMakePoint(ox, oy));
          star.lineToPoint($.NSMakePoint(ix, iy));
        }
        star.closePath;
        star.fill;
      }
    } else {
      var rr = 30 + ease * 46;
      var a3 = (1 - age) * 0.75;
      $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.89, 0.34, 0.30, a3).setStroke;
      var bad = $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(cx - rr, cy - rr, rr * 2, rr * 2));
      bad.lineWidth = 4 * (1 - age) + 1.5;
      bad.stroke;
    }
  }
  function rgba(r, g, b, a){ return $.NSColor.colorWithSRGBRedGreenBlueAlpha(r, g, b, a); }
  var INK = darkSkin ? rgba(0.91, 0.93, 0.97, 1) : rgba(0.16, 0.20, 0.25, 1);
  var SUB = darkSkin ? rgba(0.58, 0.63, 0.74, 1) : rgba(0.36, 0.42, 0.49, 1);
  var BG  = darkSkin ? rgba(0.06, 0.09, 0.15, 0.95) : rgba(0.99, 0.98, 0.95, 0.96);
  function fontAt(size, bold){
    var f = $.NSFont.fontWithNameSize(bold ? 'PingFangSC-Semibold' : 'PingFangSC-Regular', size);
    if (f && !f.isNil()) return f;
    return $.NSFont.systemFontOfSizeWeight(size, bold ? 0.5 : 0);
  }
  /* ── 气泡:独立悬浮窗,不画在派大星窗口里 ──────────────────────
   * 旧实现画在 win 的 drawRect 里,但派大星窗口只有 W×H(默认 190×206),
   * 气泡宽可达 340、锚在窗口顶往上延伸 → **几乎全部落在窗口外被裁剪**,
   * 用户看到的"气泡不出现"就是这个。改为独立 borderless 子窗,跟随派大星。 */
  var bubbleWin = null;
  function layoutBubbleWin(){
    if (!bubbleWin || !bubble) return;
    var f = win.frame;
    var bw = bubbleW || 280, bh = bubbleH || 120;
    var bx = Math.round(f.origin.x + (f.size.width - bw) / 2);
    var by = Math.round(f.origin.y + f.size.height + 6);   // 派大星头顶上方(Cocoa y 向上)
    bubbleWin.setFrameOrigin($.NSMakePoint(bx, by));
  }
  /* 气泡 = 伴侣渲染的 statusBubble.png(SVG 设计卡,与抽查卡同一套视觉)。
   * 窗口尺寸随 PNG 像素/2(2x 渲染);PNG 被 mtime 轮询发现更新后自动重绘。 */
  var bubblePng = M.statusBubblePng;
  var bubbleImg = null, bubbleMtime = 0, bubbleW = 0, bubbleH = 0;
  /* 气泡窗**在启动时就建好**(隐藏),绘制/悬停时只 orderFront + 贴图。
   * 之前是懒创建并在 drawRect 期间 orderFrontRegardless —— AppKit 在绘制期改窗口
   * 状态会直接 SIGTRAP(AppKit _crashOnException),派大星一启动就崩。 */
  var bubbleViewRef = null;
  (function buildBubbleWin(){
    var BName = 'DWBubbleView' + Date.now();
    ObjC.registerSubclass({ name: BName, superclass: 'NSView', methods: {
      'drawRect:': function(rect){
        try {
          if (bubbleImg && !bubbleImg.isNil() && bubbleW > 0 && bubbleH > 0) {
            bubbleImg.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, bubbleW, bubbleH), $.NSZeroRect, $.NSCompositeSourceOver, 1);
          }
        } catch (e) {}
      },
    }});
    bubbleWin = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
      $.NSMakeRect(0, 0, 280, 120),
      $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
    bubbleWin.opaque = false; bubbleWin.backgroundColor = $.NSColor.clearColor;
    bubbleWin.level = $.NSFloatingWindowLevel + 1;
    bubbleWin.hasShadow = true;
    bubbleWin.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorIgnoresCycle;
    bubbleViewRef = $[BName].alloc.initWithFrame($.NSMakeRect(0, 0, 280, 120));
    bubbleWin.contentView.addSubview(bubbleViewRef);
  })();
  function drawBubble(){
    if (!bubble) { if (bubbleWin) bubbleWin.orderOut($()); return; }
    if (!bubbleWin) return;
    bubbleWin.orderFrontRegardless;
    layoutBubbleWin();
  }
  function reloadBubblePng(){
    var img = $.NSImage.alloc.initWithContentsOfFile(bubblePng);
    if (!img || img.isNil()) return;
    bubbleImg = img;
    var w2 = img.size.width / 2, h2 = img.size.height / 2;
    var resized = Math.abs(w2 - bubbleW) > 0.5 || Math.abs(h2 - bubbleH) > 0.5;
    bubbleW = w2; bubbleH = h2;
    if (!bubbleWin || !bubbleViewRef) return;
    if (resized) {
      var wasVisible = bubbleWin.isVisible;
      if (wasVisible) bubbleWin.orderOut($());   // 改尺寸前先撤,避免绘制期改 frame
      bubbleViewRef.setFrame($.NSMakeRect(0, 0, bubbleW, bubbleH));
      bubbleWin.setFrameDisplay($.NSMakeRect(0, 0, bubbleW, bubbleH), false);
      if (wasVisible) { bubbleWin.orderFrontRegardless; layoutBubbleWin(); }
    }
    bubbleViewRef.setNeedsDisplay(true);
  }
  reloadBubblePng();
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(2, true, function(){
    try {
      var at = $.NSFileManager.defaultManager.attributesOfItemAtPathError(bubblePng, $());
      if (!at) return;
      var d = at.objectForKey($.NSFileModificationDate);
      var mt = d ? d.timeIntervalSince1970 : 0;
      if (mt > bubbleMtime + 0.05) { bubbleMtime = mt; reloadBubblePng(); if (bubble) drawBubble(); }
    } catch (e) {}
  });

  var GripClass = ObjC.registerSubclass({ name: 'DWPatrickGrip', superclass: 'NSView', methods: {
    'mouseDownCanMoveWindow': function(){ return false; },
    'drawRect:': function(rect){
      // 不 fill 背景:窗口 backgroundColor=clear、视图不画底色即保持透明。
      var f = win.frame;
      // 答错:整窗轻微左右抖动(用平移整个绘制内容模拟)
      var shakeX = 0;
      if (st.shakeUntil && Date.now() < st.shakeUntil) {
        var sp = (st.shakeUntil - Date.now()) / 420;
        shakeX = Math.sin(Date.now() / 28) * 7 * sp;
      }
      if (st.listenTap && !reduceMotion()) {
        var lp = (Date.now() - st.listenTap) / 560;
        if (lp < 1) shakeX += Math.sin(lp * Math.PI * 6) * 5 * Math.pow(1 - lp, 2);
      }
      // 点击开窗时的「蓄力→弹起」:整幅精灵缩放 + 下沉/上浮。
      // 用变换套在 sprite 与特效上(气泡不动,否则文字会跟着抖)。
      var sx = 1, sy = 1, dy = 0;
      if (typeof idleState !== 'undefined' && idleState.phase === 2 && idleState.eligible && st.mode === 'idle' && !reduceMotion()) {
        var stomp = Date.now() % 9000;
        if (stomp < 600) dy = Math.abs(Math.sin(stomp / 600 * Math.PI * 2)) * 5;
      }
      if (st.clickFx) {
        var cp = (Date.now() - st.clickFx.start) / st.clickFx.dur;
        if (cp >= 1) { st.clickFx = null; }
        else {
          if (cp < 0.21) {
            // 0–90ms 蓄力:压扁 + 下沉
            var q = cp / 0.21;
            var qe = 1 - Math.pow(1 - q, 2);
            sx = 1 + 0.06 * qe; sy = 1 - 0.06 * qe; dy = -6 * qe;
          } else {
            // 90ms 之后:回弹过冲,恢复原状
            var r = (cp - 0.21) / 0.79;
            var re = Math.pow(1 - r, 2);
            sx = 1 - 0.05 * re; sy = 1 + 0.05 * re; dy = 3 * re - 3 * re * (1 - r);
          }
        }
      }
      var R = $.NSMakeRect(
        shakeX + f.size.width * (1 - sx) / 2,
        dy + f.size.height * (1 - sy) / 2,
        f.size.width * sx, f.size.height * sy);
      // 朗读时声音包络驱动起伏,慢节拍驱动摆动;只变换精灵,文字卡保持稳定。
      var motion = speakMotion && speakMotion.amount > 0.01 && !reduceMotion();
      if (motion) {
        var m=speakMotion, t=(Date.now()-m.started)/1000, a=m.amount;
        var breath=Math.sin(t*3.8), nod=Math.max(0,Math.sin(t*7.2))*m.level;
        var scaleX=1-a*(0.035+breath*0.008+nod*0.013);
        var scaleY=1-a*(0.035-breath*0.011-nod*0.014);
        R=$.NSMakeRect(shakeX+f.size.width*(1-scaleX)/2+a*Math.sin(t*3.1)*2,
          f.size.height*(1-scaleY)/2+a*(breath*1.8+nod*3),f.size.width*scaleX,f.size.height*scaleY);
        $.NSGraphicsContext.saveGraphicsState;
        var tr=$.NSAffineTransform.transform;
        tr.translateXByYBy(f.size.width/2,f.size.height*0.15);
        tr.rotateByDegrees(a*(Math.sin(t*3.1)*1.7+Math.sin(t*6.2)*m.level*0.7));
        tr.translateXByYBy(-f.size.width/2,-f.size.height*0.15); tr.concat;
      }
      if (typeof idleState !== 'undefined' && idleState.phase === 2 && idleState.eligible) {
        R = $.NSMakeRect(R.origin.x + R.size.width*.04, R.origin.y, R.size.width*.92, R.size.height*.88);
      }
      drawSprite(st.frame, R);
      if (typeof drawIdleMood === 'function') drawIdleMood(st.frame, R);
      drawSpeechMouth(st.frame, R);
      drawFx(R);
      if (motion) $.NSGraphicsContext.restoreGraphicsState;
      drawBubble();
    },
    'acceptsFirstMouse:': function(){ return true; },
    'mouseDown:': function(e){
      // 拖动必须用**屏幕坐标** NSEvent.mouseLocation:e.locationInWindow 是窗口局部坐标,
      // 窗口一移动局部坐标就变,会形成负反馈 → 拖动跟不上鼠标(卡片形态同款坑)。
      var m = $.NSEvent.mouseLocation;
      downState = { sx: m.x, sy: m.y, gx: x, gy: y, t: Date.now(), moved: false };
    },
    'mouseDragged:': function(e){
      if (!downState) return;
      var m = $.NSEvent.mouseLocation;
      var dx = m.x - downState.sx, dy = m.y - downState.sy;
      if (!downState.moved && Math.abs(dx) + Math.abs(dy) > 4) {
        downState.moved = true;
        st.mode = 'drag'; bubble = null; st.target = null; st.animSeq = null; st.frame = FR.idle0;
      }
      if (downState.moved) {
        // 拖动只移动窗口,内容不变 —— 用 setFrameOrigin(不触发重绘),setFrame:display:YES
        // 每次鼠标事件都同步重画整窗,是"拖动卡顿"的根因。
        x = Math.max(screen.origin.x, Math.min(downState.gx + dx, screen.origin.x + screen.size.width - W));
        y = Math.max(screen.origin.y, Math.min(downState.gy + dy, screen.origin.y + screen.size.height - H));
        win.setFrameOrigin($.NSMakePoint(x, y));
        syncQuizWinPosition();   // 抽查卡跟着一起走
        syncSpeakWinPosition();
        if (bubbleWin) layoutBubbleWin();   // 气泡跟随
      }
    },
    'mouseUp:': function(e){
      if (!downState) return;
      var wasDrag = downState.moved, dt = Date.now() - downState.t;
      downState = null;
      if (wasDrag) { savePos(); st.mode = 'idle'; st.idleHoldUntil = Date.now() + 2200; st.blinkAt = Date.now() + 900; return; }
      if (dt < 600) handleClick();
    },
    'mouseEntered:': function(e){ st.hover = true; },
    'mouseExited:': function(e){ st.hover = false; },
  }});
  var grip = $.DWPatrickGrip.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
  grip.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;
  win.contentView.addSubview(grip);
  var track = $.NSTrackingArea.alloc.initWithRectOptionsOwnerUserInfo(
    $.NSMakeRect(0, 0, W, H),
    $.NSTrackingMouseEnteredAndExited | $.NSTrackingActiveAlways | $.NSTrackingAssumeInside,
    grip, $());
  grip.addTrackingArea(track);
  win.orderFrontRegardless;   // 无焦点窗口必须显式上屏,否则进程活着但窗口永不可见

  function savePos(){
    $.NSString.stringWithString(JSON.stringify({ x: x, y: y })).writeToFileAtomicallyEncodingError(M.posFile, true, $.NSUTF8StringEncoding, $());
  }
  function playSeq(seq, ms, once, then){
    if (!seq) { st.animSeq = null; st.animThen = null; return; }
    st.animSeq = seq; st.animSeqIdx = 0; st.animSeqFrame = seq[0];
    st.animTickMs = ms || 140; st.animLast = Date.now(); st.animSeqOnce = !!once; st.animThen = then || null;
  }
  function postUrl(u, body){
    var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString(u));
    req.setHTTPMethod('POST');
    if (body) {
      req.setHTTPBody($.NSString.stringWithString(body).dataUsingEncoding($.NSUTF8StringEncoding));
      req.setValueForHTTPHeaderField('application/json', 'Content-Type');
    }
    $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){});
  }
  /* ── 词状态:新词 vs 艾宾浩斯倒计时 ─────────────────────────
   * 每 60s 拉 /pet-word-status.json 缓存;悬停气泡据此区分:
   *   🆕 还没背第一遍(桌面新词)
   *   ⏳ 艾宾浩斯倒计时(已进记忆本,第 N 轮,还差多久考)
   *   ❗ 到期该复习
   * 悬停气泡同时把两类词都列出来(各自最多 3 个),一眼看清"接下来该干嘛"。 */
  var wordStatus = [];          // [{word,kind,stage,dueInMs}]
  var statusLastAt = 0;
  function fmtDue(ms) {
    var min = Math.round(ms / 60000);
    if (min < 60) return min + ' 分钟';
    var h = Math.floor(min / 60), m = min % 60;
    if (h < 24) return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
    return Math.round(h / 24) + ' 天';
  }
  function statusLines(){
    if (!wordStatus.length) return null;
    var fresh = [], timing = [], dueNow = [];
    wordStatus.forEach(function (it) {
      if (it.kind === 'new') fresh.push(it.word);
      else if (it.kind === 'due') dueNow.push(it.word);
      else if (it.kind === 'countdown') timing.push(it);
    });
    if (!fresh.length && !timing.length && !dueNow.length) return null;
    var lines = [];
    if (dueNow.length) lines.push({ text: '❗ 该复习了：' + dueNow.slice(0, 3).join('、'), size: 11, bold: true });
    if (timing.length) {
      timing.slice(0, 3).forEach(function (it) {
        lines.push({ text: '⏳ ' + it.word + ' · 第 ' + ((it.stage || 0) + 1) + ' 轮 · ' + fmtDue(it.dueInMs) + '后考', size: 10.5, color: 'sub' });
      });
    }
    if (fresh.length) lines.push({ text: '🆕 还没背：' + fresh.slice(0, 3).join('、'), size: 11 });
    lines.push({ text: '摸摸我抽查 · 点击开对话', size: 9, color: 'sub' });
    return lines;
  }
  function showHoverBubble(){
    if (!M.words || !M.words.length) return;
    // 悬停 = 一眼看清两类词:新词 + 倒计时中的词
    var lines = statusLines();
    if (!lines) lines = wordBubbleLines(st.speakIndex >= 0 ? st.speakIndex : 0, true);
    bubble = { lines: lines, until: Date.now() + 8000 };
    grip.setNeedsDisplay(true);
  }
  function pullWordStatus(){
    var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString(M.statusUrl));
    req.setTimeoutInterval(4);
    $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){
      if (!data) return;
      try {
        var d = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
        if (d && d.ok && d.words) { wordStatus = d.words; statusLastAt = Date.now(); }
      } catch (e) {}
    });
  }
  pullWordStatus();
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(60, true, function(){ pullWordStatus(); });
  /* 点击 = 朗读当前页的**下一个词**(6 个词轮换),而不是永远读第一个。
   * 每次点击:跳跃 + 气泡显示该词 + 语音读 词→释义→例句→例句中译。 */
  /* 双击派大星 → 弹出**非模态**提问窗(不能 runModal:模态会阻塞 50ms 主循环,
   * 派大星会卡住不动)。用一个独立小窗 + NSTextField + 两个按钮。 */
  var askWin = null, askField = null;
  function closeAskWin(){
    if (askWin) { askWin.orderOut($()); askWin = null; askField = null; }
  }
  function openAskWin(prefill){
    closeAskWin();
    var AW = 360, AH = 132;
    var ax = Math.round(x + (W - AW) / 2);
    var ay = Math.round(y - AH - 12);
    var sf = $.NSScreen.mainScreen.frame;
    ax = Math.max(sf.origin.x + 8, Math.min(ax, sf.origin.x + sf.size.width - AW - 8));
    ay = Math.max(sf.origin.y + 8, Math.min(ay, sf.origin.y + sf.size.height - AH - 8));
    var w = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
      $.NSMakeRect(ax, ay, AW, AH),
      $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable,
      $.NSBackingStoreBuffered, false);
    w.title = '问派大星（DeepSeek）';
    w.level = $.NSFloatingWindowLevel + 1;
    w.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces;
    var content = w.contentView;

    var label = $.NSTextField.labelWithString('想了解哪个词？随便问：');
    label.frame = $.NSMakeRect(16, AH - 40, AW - 32, 18);
    label.font = $.NSFont.systemFontOfSize(11.5);
    content.addSubview(label);

    var field = $.NSTextField.alloc.initWithFrame($.NSMakeRect(16, AH - 74, AW - 32, 24));
    field.setStringValue($.NSString.stringWithString(prefill || ''));
    field.setPlaceholderString($.NSString.stringWithString('例如：course 怎么记？有什么搭配？'));
    field.font = $.NSFont.systemFontOfSize(13);
    content.addSubview(field);
    askField = field;

    var btnW = 84, btnH = 26;
    var sendBtn = $.NSButton.alloc.initWithFrame($.NSMakeRect(AW - 16 - btnW, 14, btnW, btnH));
    sendBtn.title = '问它';
    sendBtn.bezelStyle = $.NSBezelStyleRounded;
    sendBtn.keyEquivalent = String.fromCharCode(13);     // 回车发送
    content.addSubview(sendBtn);
    var cancelBtn = $.NSButton.alloc.initWithFrame($.NSMakeRect(AW - 16 - btnW * 2 - 8, 14, btnW, btnH));
    cancelBtn.title = '算了';
    cancelBtn.bezelStyle = $.NSBezelStyleRounded;
    cancelBtn.keyEquivalent = String.fromCharCode(27);   // Esc 关闭
    content.addSubview(cancelBtn);

    // 按钮点击走本地事件监听(不改 ObjC 类);回车/Esc 由 keyEquivalent 处理。
    var clickMonitor = $.NSEvent.addLocalMonitorForEventsMatchingMaskHandler($.NSEventMaskLeftMouseUp, function(ev){
      if (!askWin) return ev;
      var loc = ev.locationInWindow;
      if (ev.window !== askWin) return ev;
      var inSend = loc.x >= AW - 16 - btnW && loc.x <= AW - 16 && loc.y >= 14 && loc.y <= 14 + btnH;
      var inCancel = loc.x >= AW - 16 - btnW * 2 - 8 && loc.x <= AW - 16 - btnW - 8 && loc.y >= 14 && loc.y <= 14 + btnH;
      if (inSend) { submitAsk(); return $(); }
      if (inCancel) { closeAskWin(); return $(); }
      return ev;
    });

    function submitAsk(){
      if (!askField) return;
      var q = ObjC.unwrap(askField.stringValue).trim();
      if (!q) return;
      closeAskWin();
      bubble = { lines: [{ text: '派大星想想…', size: 11 }], until: Date.now() + 20000 };
      grip.setNeedsDisplay(true);
      postUrl('http://127.0.0.1:' + M.port + '/pet-ask.php',
        JSON.stringify({ index: st.speakIndex >= 0 ? st.speakIndex : 0, question: q, clear: true }));
    }
    askWin = w;
    w.makeKeyAndOrderFront($());
    $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
    w.makeFirstResponder(field);
  }

  var lastClickAt = 0;
  /* 有题卡时点击 = 抖动 + 当前词/例句;空闲时保留打开对话的交互。
   * 动效编排(与浮窗的出场动画对齐):
   *   0ms    派大星先做一个「蓄力」下沉(缩放 1.0→0.94,向下 6pt)
   *   90ms   弹起(跳跃弧线)+ 挥手两帧 —— 这是"它把窗口递给你"的感觉
   *   90ms   同时请求伴侣开窗;窗口自己在 260ms 内从派大星身旁弹出来
   * 之前是瞬间切到 jump 帧 + 立刻开窗,两个动作各走各的,显得很突变。 */
  function handleClick(){
    var now = Date.now();
    if (st.quiz && !quizWin && typeof revealIdleQuiz === 'function') { revealIdleQuiz(now); return; }
    if (st.quiz && quizWin && cardKind === 'quiz' && lastQuizGeom) {
      if (now - lastClickAt < 240) return;
      lastClickAt = now;
      stopSpeakAudio();
      st.listenTap = now; st.frame = FR.happy0; st.animSeq = null;
      bubble = null; speakPendingUntil = now + 5000;
      grip.setNeedsDisplay(true);
      postUrl(M.speakUrl, JSON.stringify({ quizId: lastQuizGeom.id }));
      return;
    }
    if (st.quiz) return;  // 题卡尚未上屏时不切走对话。
    if (now - lastClickAt < 400) return;    // 防连点:一次点击只开一个窗
    lastClickAt = now;
    st.animSeq = null;
    st.clickFx = { start: now, dur: 420 };  // 蓄力→弹起的缩放/位移,在 drawRect 里应用
    // 先蓄力 90ms,再跳 + 挥手并请求开窗
    st.mode = 'idle';
    st.idleHoldUntil = now + 500;
    bubble = null;
    grip.setNeedsDisplay(true);
    $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(0.09, true, function(tm){
      tm.invalidate;
      st.mode = 'jump'; st.jumpStart = Date.now(); st.jumpY0 = y;
      playSeq([FR.wave0, FR.wave1, FR.wave0], 110, true, function(){ st.frame = FR.idle0; grip.setNeedsDisplay(true); });
      bubble = { lines: [{ text: '来，聊聊这个词～', size: 11 }], until: Date.now() + 2200 };
      grip.setNeedsDisplay(true);
      postUrl('http://127.0.0.1:' + M.port + '/pet-chat-window.php?action=toggle', '');
    });
  }
  /* 组装某个词的语音气泡行(词 + 音标 / 释义 / 例句)。 */
  function wordBubbleLines(idx, withHint){
    var w = M.words && M.words[idx];
    if (!w) return [{ text: '这一页还没有词', size: 11 }];
    var lines = [];
    lines.push({ text: (w.pos ? w.pos + ' ' : '') + w.word + (w.phonetic ? '  ' + w.phonetic : ''), size: 12.5, bold: true });
    if (w.meaning) lines.push({ text: w.meaning, size: 11, color: 'sub' });
    var ex = w.example || (M.exampleLines && M.exampleLines[idx]) || '';
    if (ex) {
      var s = String(ex);
      lines.push({ text: s.length > 44 ? s.substring(0, 42) + '…' : s, size: 10, color: 'sub' });
    }
    if (withHint && M.words.length > 1) {
      lines.push({ text: '第 ' + (idx + 1) + '/' + M.words.length + ' 个 · 再点一下读下一个', size: 9.5, color: 'sub' });
    }
    return lines;
  }
  // ---- 抽查卡子窗:quiz.png 存在时跟随派大星显示;选项 A-D 命中 → answer ----
  /* 通用浮动卡子窗(抽查卡 / 朗读卡共用):显示指定 PNG,随派大星移动。 */
  function makeCardWin(qx, qy, pngPath, cardW, cardH){
    var visible = $.NSScreen.mainScreen.visibleFrame;
    var viewportH = Math.min(cardH, visible.size.height - 16);
    // Cocoa y 自下而上:卡片要出现在派大星**下方**(屏幕视觉),底部 y 要减。
    var qRect = $.NSMakeRect(qx, qy - viewportH - 4, cardW, viewportH);
    qRect.origin.x = Math.max(visible.origin.x + 4, Math.min(qRect.origin.x, visible.origin.x + visible.size.width - cardW - 4));
    qRect.origin.y = Math.max(visible.origin.y + 4, Math.min(qRect.origin.y, visible.origin.y + visible.size.height - viewportH - 4));
    var qw = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(qRect, $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
    qw.opaque = false; qw.backgroundColor = $.NSColor.clearColor;
    qw.level = $.NSFloatingWindowLevel + 1;
    qw.hasShadow = true;
    qw.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorIgnoresCycle;
    var QuizName = 'DWQuizGrip' + Date.now();
    ObjC.registerSubclass({ name: QuizName, superclass: 'NSView', methods: {
      'mouseDownCanMoveWindow': function(){ return false; },
      'drawRect:': function(rect){
        var qimg = $.NSImage.alloc.initWithContentsOfFile(pngPath);
        if (qimg && !qimg.isNil()) qimg.drawInRectFromRectOperationFraction(this.bounds, $.NSZeroRect, $.NSCompositeSourceOver, 1);
      },
      'mouseDown:': function(e){
        var p = this.convertPointFromView(e.locationInWindow, $());
        var f = this.bounds;
        if (cardKind !== 'quiz') return;
        var topDown = f.size.height - p.y;          // 换算成「自上而下」的 y
        // 命中区间跟卡走(v2.5.22):每行选项有自己的顶/高(optTops/optHs),
        // 长释义折行后行高互不相同,写死行高会点错行。
        var g = lastQuizGeom || null;
        var btnTop = g ? g.btnTop : M.quizBtnTop;
        var btnBottom = g ? g.btnBottom : M.quizBtnBottom;
        if (!g || p.x < 14 || p.x > g.w - 14) return;
        // 底部两颗按钮(作答后才有意义;没作答时伴侣侧会拒绝)
        if (topDown >= btnTop && topDown <= btnBottom) {
          if (!g.done) return;
          if (p.x <= M.quizBtnSkipX1) skipPost(); else sentencePost();
          return;
        }
        // 展开/收起条(仅超长释义折叠时存在)
        if (g.chipTop != null && topDown >= g.chipTop && topDown <= g.chipBottom) { expandPost(g.expanded ? 'collapse' : 'expand'); return; }
        // 选项行:逐行命中(每行顶/高来自 geom)
        var tops = (g && g.optTops) || null;
        var hts = (g && g.optHs) || null;
        var optCount = g ? (g.optCount || 4) : 4;
        for (var ri = optCount - 1; ri >= 0; ri--) {
          var rTop = tops ? tops[ri] : (72 + ri * 36);
          var rH = hts ? hts[ri] : 36;
          if (topDown >= rTop && topDown < rTop + rH) {
            if (g.collapsedOptions && g.collapsedOptions[ri]) expandPost('expand');
            else if (!g.done) answerPost(ri);
            return;
          }
        }
      },
    }});
    /* 点「释义太长,点击展开」条:请伴侣重渲全显卡片。 */
    function expandPost(action){
      var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + M.port + '/pet-quiz.php'));
      req.setHTTPMethod('POST');
      req.setHTTPBody($.NSString.stringWithString(JSON.stringify({ action: action, quizId: lastQuizGeom.id })).dataUsingEncoding($.NSUTF8StringEncoding));
      req.setValueForHTTPHeaderField('application/json', 'Content-Type');
      $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){});
    }
    function answerPost(idx){
      var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + M.port + '/pet-quiz.php'));
      req.setHTTPMethod('POST');
      req.setHTTPBody($.NSString.stringWithString(JSON.stringify({ action: 'answer', picked: idx, quizId: lastQuizGeom.id })).dataUsingEncoding($.NSUTF8StringEncoding));
      req.setValueForHTTPHeaderField('application/json', 'Content-Type');
      $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){});
    }
    /* 点「下一个」:不出造句窗,直接请伴侣结束这道题(它会按队列/间隔出下一题)。 */
    function skipPost(){
      var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + M.port + '/pet-quiz.php'));
      req.setHTTPMethod('POST');
      req.setHTTPBody($.NSString.stringWithString(JSON.stringify({ action: 'skip', quizId: lastQuizGeom.id })).dataUsingEncoding($.NSUTF8StringEncoding));
      req.setValueForHTTPHeaderField('application/json', 'Content-Type');
      $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){});
    }
    /* 点卡片底部「造个句子」:交给伴侣开造句小窗(没作答时那边会拒绝)。 */
    function sentencePost(){
      var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + M.port + '/pet-sentence-window.php?action=open'));
      req.setHTTPMethod('POST');
      $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){});
    }
    var qgrip = $[QuizName].alloc.initWithFrame($.NSMakeRect(0, 0, cardW, cardH));
    var scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(0, 0, cardW, viewportH));
    scroll.drawsBackground = false;
    scroll.hasVerticalScroller = true;
    scroll.autohidesScrollers = true;
    scroll.scrollerStyle = $.NSScrollerStyleOverlay;
    scroll.documentView = qgrip;
    qw.contentView.addSubview(scroll);
    qgrip.scrollPoint($.NSMakePoint(0, Math.max(0, cardH - viewportH)));
    quizGripView = qgrip;
    quizScrollView = scroll;
    qw.orderFrontRegardless;
    return qw;
  }
  /* 卡高是按内容算的(长释义折行会把卡撑高):geom 变化时把窗口尺寸跟上,
   * 位置重新钳回屏幕内。窗口必须先 orderOut 再改 frame(v2.5.17 纪律)。 */
  function syncQuizWinSize(){
    if (!quizWin || cardKind !== 'quiz' || !lastQuizGeom) return;
    var f0 = quizWin.frame;
    try {
      var ms0 = $.NSScreen.mainScreen;
      var scr0 = ms0.visibleFrame;
      var vh = Math.min(lastQuizGeom.h, scr0.size.height - 16);
      if (Math.round(f0.size.width) === lastQuizGeom.w && Math.round(f0.size.height) === vh && Math.round(quizGripView.frame.size.height) === lastQuizGeom.h) return;
      var oldTop = Math.max(0, quizGripView.frame.size.height - quizScrollView.contentView.bounds.origin.y - quizScrollView.contentView.bounds.size.height);
      quizWin.orderOut($());
      quizWin.setContentSize($.NSMakeSize(lastQuizGeom.w, vh));
      quizScrollView.setFrameSize($.NSMakeSize(lastQuizGeom.w, vh));
      quizGripView.setFrameSize($.NSMakeSize(lastQuizGeom.w, lastQuizGeom.h));
      quizGripView.scrollPoint($.NSMakePoint(0, Math.max(0, lastQuizGeom.h - vh - oldTop)));
      var nx = Math.max(scr0.origin.x + 4, Math.min(f0.origin.x, scr0.origin.x + scr0.size.width - lastQuizGeom.w - 4));
      var ny = Math.max(scr0.origin.y + 4, Math.min(f0.origin.y + f0.size.height - vh, scr0.origin.y + scr0.size.height - vh - 4));
      quizWin.setFrameOrigin($.NSMakePoint(nx, ny));
      quizWin.orderFrontRegardless();
      quizGripView.setNeedsDisplay(true);
    } catch (e) {}
  }
  /* 抽查卡跟随派大星:窗口位置 = 派大星下方居中(带屏幕边界钳制)。
   * 拖动/走路时调用,卡片就不会掉在原地。 */
  /* 卡片位置:优先贴派大星**右侧**(不挡本体),右边放不下就放左边,
   * 都放不下才放到上方/下方。垂直方向与派大星顶部对齐。 */
  function syncQuizWinPosition(){
    if (!quizWin) return;
    var cw = quizWin.frame.size.width, ch = quizWin.frame.size.height;
    var ms = $.NSScreen.mainScreen;
    var f = ms.visibleFrame;
    var gap = 10;
    var qx, qy = Math.round(y + H - ch);      // 顶边与派大星顶边对齐
    if (x + W + gap + cw <= f.origin.x + f.size.width - 4) {
      qx = Math.round(x + W + gap);           // 右侧
    } else if (x - gap - cw >= f.origin.x + 4) {
      qx = Math.round(x - gap - cw);          // 左侧
    } else {
      qx = Math.round(x + (W - cw) / 2);      // 兜底:居中
      qy = Math.round(y - ch - gap);          // 放上方
    }
    qx = Math.max(f.origin.x + 4, Math.min(qx, f.origin.x + f.size.width - cw - 4));
    qy = Math.max(f.origin.y + 4, Math.min(qy, f.origin.y + f.size.height - ch - 4));
    quizWin.setFrameOrigin($.NSMakePoint(qx, qy));
    syncSpeakWinPosition();
  }
  /* 朗读卡:复用同一个子窗,换 PNG 与尺寸。 */
  /* 卡片出场动画:从派大星身侧滑出 + 淡入(180ms easeOut)。
   * JXA 没有 CoreAnimation 的简单入口,用 60fps 定时器手动插值窗口位置与 alpha。 */
  function animateCardIn(targetX, targetY){
    if (!quizWin) return;
    // 与浮窗入场同款:animator 在 ObjC 层插值,不走 16ms 定时器(JXA SIGSEGV 崩点)。
    var startX = targetX + (targetX > x ? 26 : -26);   // 从派大星方向滑出
    var startY = targetY;
    try {
      quizWin.alphaValue = 0.0;
      quizWin.setFrameOrigin($.NSMakePoint(startX, startY));
      quizWin.animator.alphaValue = 1.0;
      quizWin.animator.setFrameOrigin($.NSMakePoint(targetX, targetY));
    } catch (e) {
      quizWin.alphaValue = 1.0;
      quizWin.setFrameOrigin($.NSMakePoint(targetX, targetY));
    }
  }
  // 朗读气泡独立于 quizWin,不会替换题目、改变命中区或推进学习记录。
  var speakWin = null, speakView = null, speakImage = null, speakSession = null;
  var speakPhase = 'preparing', speakCloseAt = 0, speakExitAt = 0, speakAckAt = 0;
  var speakPendingUntil = 0;
  var speakPlayer = null, speakAudioPart = -1, speakCues = [], speakActiveCue = null, speakHighlight = null;
  var speakMotion = {active:false,amount:0,level:0,started:0,last:0};
  var speakMouth={open:0,round:0},speakSample={time:0,cue:null,db:-160,playing:false};
  ${mouthModule.mouthTarget.toString()}
  ${mouthModule.advanceMouth.toString()}
  ${speechModule.cueAtTime.toString()}
  ${speakCardPosition.toString()}
  function screenForPet(){
    try { var s = win.screen; if (s && !s.isNil()) return s.visibleFrame; } catch (e) {}
    return $.NSScreen.mainScreen.visibleFrame;
  }
  function syncSpeakWinPosition(){
    if (!speakWin) return;
    var f = screenForPet(), obstacle = null;
    if (quizWin) {
      var q = quizWin.frame;
      obstacle = { x:q.origin.x, y:q.origin.y, w:q.size.width, h:q.size.height };
    }
    var target = speakCardPosition({ x:x, y:y, w:W, h:H },
      { w:speakWin.frame.size.width, h:speakWin.frame.size.height },
      { x:f.origin.x, y:f.origin.y, w:f.size.width, h:f.size.height }, obstacle);
    speakWin.setFrameOrigin($.NSMakePoint(target.x, target.y));
  }
  ObjC.registerSubclass({ name:'DWPatrickSpeakView', superclass:'NSView', methods:{
    'drawRect:': function(rect){
      if (!speakImage || !speakSession) return;
      speakImage.drawInRectFromRectOperationFraction(this.bounds, $.NSZeroRect, $.NSCompositeSourceOver, 1);
      var h = this.bounds.size.height, playing = speakPhase === 'word' || speakPhase === 'example';
      drawSpeakLines(h);
      var mint = darkSkin ? rgba(0.73,0.85,0.64,1) : rgba(0.23,0.40,0.32,1);
      mint.setFill;
      for (var i=0; i<4; i++) {
        var bh = playing && !reduceMotion() ? 4 + (1 + Math.sin(Date.now()/130 + i*1.3))*4 : [5,10,13,7][i];
        $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(23+i*4.5,h-25-bh/2,2.5,bh),1.25,1.25).fill;
      }
      var labels = { preparing:'准备朗读', word:'正在读单词', example:'正在读例句', done:'读完啦', error:'暂时无法播放' };
      var attrs = $.NSMutableDictionary.alloc.init;
      attrs.setObjectForKey(fontAt(10,true), $.NSFontAttributeName);
      attrs.setObjectForKey(mint, $.NSForegroundColorAttributeName);
      $.NSString.stringWithString(labels[speakPhase] || '陪你读一遍').drawAtPointWithAttributes($.NSMakePoint(48,h-32),attrs);
    },
  }});
  function drawSpeakLines(h){
    var lines = speakSession.lines || [], attrs = $.NSMutableDictionary.alloc.init;
    var font = $.NSFont.fontWithNameSize('AvenirNext-Regular',15);
    if (!font || font.isNil()) font = fontAt(15,false);
    attrs.setObjectForKey(font,$.NSFontAttributeName);
    var ink = darkSkin ? rgba(1,0.94,0.96,1) : rgba(0.22,0.15,0.20,1);
    attrs.setObjectForKey(ink,$.NSForegroundColorAttributeName);
    var active = null;
    if (speakPhase === 'example' && speakActiveCue) {
      for (var i=0;i<lines.length;i++) {
        var line = lines[i], a = Math.max(line.from,speakActiveCue.from), b = Math.min(line.to,speakActiveCue.to);
        if (a>=b) continue;
        var prefix = line.text.substring(0,a-line.from), word = line.text.substring(a-line.from,b-line.from);
        var before = $.NSString.stringWithString(prefix).sizeWithAttributes(attrs).width;
        var width = $.NSString.stringWithString(prefix+word).sizeWithAttributes(attrs).width-before;
        active = {x:line.x+before,y:h-line.y-4,w:width,text:word,key:String(a)+':'+String(b)};
        break;
      }
    }
    if (active) {
      if (!speakHighlight || speakHighlight.key!==active.key) {
        var old = speakHighlight && speakHighlight.target;
        speakHighlight = {key:active.key,target:active,start:Date.now(),from:old && Math.abs(old.y-active.y)<2 ? old : active};
      }
      var p = reduceMotion() ? 1 : Math.min(1,(Date.now()-speakHighlight.start)/90);
      var ease = 1-Math.pow(1-p,3), from=speakHighlight.from;
      var rx = from.x+(active.x-from.x)*ease, rw=from.w+(active.w-from.w)*ease;
      var pill = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(rx-3,active.y-1,rw+6,20),5,5);
      rgba(0.95,0.59,0.70,darkSkin?0.19:0.15).setFill; pill.fill;
      rgba(0.95,0.59,0.70,0.3).setStroke; pill.lineWidth=0.6; pill.stroke;
    }
    lines.forEach(function(line){
      $.NSString.stringWithString(line.text).drawAtPointWithAttributes($.NSMakePoint(line.x,h-line.y-4),attrs);
    });
    if (active) {
      attrs.setObjectForKey(darkSkin ? rgba(1,0.75,0.83,1) : rgba(0.61,0.25,0.36,1),$.NSForegroundColorAttributeName);
      $.NSString.stringWithString(active.text).drawAtPointWithAttributes($.NSMakePoint(active.x,active.y),attrs);
    }
  }
  function stopSpeakAudio(keepMotion){
    if (speakPlayer) { try { speakPlayer.stop; } catch(e) {} }
    speakPlayer=null; speakAudioPart=-1; speakCues=[]; speakActiveCue=null; speakHighlight=null;
    speakMouth={open:0,round:0};speakSample={time:0,cue:null,db:-160,playing:false};
    if (!keepMotion) speakMotion.active=false;
  }
  function tickSpeakMotion(now){
    var m=speakMotion, dt=Math.min(100,Math.max(0,now-(m.last || now))); m.last=now;
    var target=m.active?1:0, speed=dt/(m.active?180:300);
    m.amount += (target-m.amount)*Math.min(1,speed);
    if (!m.active && m.amount<0.01) m.amount=0;
    var level=speakSample.playing ? Math.min(1,Math.pow(10,speakSample.db/30)) : 0;
    m.level+=(level-m.level)*0.35;
    speakMouth=advanceMouth(speakMouth,mouthTarget(speakSample.db,speakSample.cue,speakCues.length>0,speakSample.playing,reduceMotion()),dt);
  }
  function speakingFrame(now){
    if (reduceMotion()) return FR.front0;
    var beat=(now-speakMotion.started)%3800;
    if (beat>2450 && beat<3150) return beat<2800?FR.wave0:FR.wave1;
    // 以笑脸和轻眨眼陪读,避免在不匹配的表情帧间快速闪跳。
    return beat>1600 && beat<1730 ? FR.blink : beat<1100 ? FR.front0 : FR.idle0;
  }
  function finishNativeAudio(error){
    if (!speakSession || speakAudioPart<0) return;
    var part=speakAudioPart,id=speakSession.id;
    stopSpeakAudio(!error && part===0 && (speakSession.lines || []).length>0); speakPhase='preparing';
    postUrl(M.speakFinishedUrl,JSON.stringify({id:id,part:part,error:!!error}));
  }
  function startNativeAudio(c){
    stopSpeakAudio(true);
    speakAudioPart=c.part; speakCues=c.cues || []; speakPhase=c.phase;
    try {
      speakPlayer=$.AVAudioPlayer.alloc.initWithContentsOfURLError($.NSURL.fileURLWithPath(c.file),$());
      if (speakPlayer && !speakPlayer.isNil()) speakPlayer.meteringEnabled=true;
      if (!speakPlayer || speakPlayer.isNil() || !speakPlayer.prepareToPlay || !speakPlayer.play) { finishNativeAudio(true); return; }
      if (!speakMotion.active) speakMotion.started=Date.now();
      speakMotion.active=true;
    } catch(e) { finishNativeAudio(true); }
  }
  function hideSpeakCard(){
    stopSpeakAudio();
    if (speakWin) speakWin.orderOut($());
    speakWin = null; speakView = null; speakImage = null; speakSession = null;
    speakCloseAt = 0; speakExitAt = 0; speakAckAt = 0; speakPendingUntil = 0;
  }
  function showSpeakCard(c){
    // 轮询中的旧朗读命令可能晚于换题到达。
    if (c.quizId && (!st.quiz || !lastQuizGeom || lastQuizGeom.id !== c.quizId)) return;
    hideSpeakCard();
    var img = $.NSImage.alloc.initWithContentsOfFile(M.speakPng);
    if (!img || img.isNil()) return;
    var f = screenForPet(), vh = Math.min(c.h, 440, f.size.height - 16);
    var cw = Math.min(c.w, f.size.width - 16);
    speakSession = c; speakImage = img; speakPhase = 'preparing';
    if (c.holdResult) st.quizResultHideAt = 0;
    bubble = null;
    speakWin = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
      $.NSMakeRect(x,y,cw,vh), $.NSWindowStyleMaskBorderless,$.NSBackingStoreBuffered,false);
    speakWin.opaque = false; speakWin.backgroundColor = $.NSColor.clearColor;
    speakWin.level = $.NSFloatingWindowLevel + 2; speakWin.hasShadow = true;
    speakWin.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorIgnoresCycle;
    speakView = $.DWPatrickSpeakView.alloc.initWithFrame($.NSMakeRect(0,0,c.w,c.h));
    var scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(0,0,cw,vh));
    scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true;
    scroll.hasHorizontalScroller = cw < c.w; scroll.scrollerStyle = $.NSScrollerStyleOverlay;
    scroll.documentView = speakView; speakWin.contentView.addSubview(scroll);
    speakView.scrollPoint($.NSMakePoint(0,Math.max(0,c.h-vh)));
    syncSpeakWinPosition();
    var target = speakWin.frame.origin, motion = !reduceMotion();
    speakWin.alphaValue = 0;
    if (motion) speakWin.setFrameOrigin($.NSMakePoint(target.x,target.y-10));
    speakWin.orderFrontRegardless;
    $.NSAnimationContext.beginGrouping;
    $.NSAnimationContext.currentContext.duration = motion ? 0.24 : 0.1;
    speakWin.animator.alphaValue = 1;
    if (motion) speakWin.animator.setFrameOrigin(target);
    $.NSAnimationContext.endGrouping;
    speakAckAt = Date.now() + 250;
    speakSession.openedAt = Date.now();
  }
  function tickSpeakCard(now){
    if (!speakWin || !speakSession) return;
    if (speakAckAt && now >= speakAckAt) {
      speakAckAt = 0;
      postUrl(M.speakShownUrl,JSON.stringify({ id:speakSession.id }));
    }
    if (speakPlayer) {
      // One playback sample drives lips, body and highlighting in this frame.
      // No independent elapsed-time clock: pauses, replays and seeks stay aligned.
      var time=speakPlayer.currentTime,db=-160,playing=!!speakPlayer.isPlaying;
      try{speakPlayer.updateMeters;db=speakPlayer.averagePowerForChannel(0);}catch(e){}
      speakSample={time:time,cue:cueAtTime(speakCues,time),db:db,playing:playing};
      var cue=speakPhase==='example' ? speakSample.cue : null;
      if (cue && (!speakActiveCue || cue.from!==speakActiveCue.from)) {
        var lines=speakSession.lines || [];
        for(var i=0;i<lines.length;i++) if(cue.from>=lines[i].from && cue.from<lines[i].to) {
          speakView.scrollRectToVisible($.NSMakeRect(20,speakSession.h-lines[i].y-10,speakSession.w-40,40)); break;
        }
      }
      speakActiveCue=cue;
      if (!playing) finishNativeAudio(false);
    }
    if (speakExitAt && now >= speakExitAt) { hideSpeakCard(); return; }
    if (!speakExitAt && ((speakCloseAt && now >= speakCloseAt) || now-speakSession.openedAt > 125000)) {
      speakExitAt = now + 220;
      $.NSAnimationContext.beginGrouping;
      $.NSAnimationContext.currentContext.duration = 0.2;
      speakWin.animator.alphaValue = 0;
      $.NSAnimationContext.endGrouping;
    }
    if (speakView) speakView.setNeedsDisplay(true);
  }
  function handleSpeakCommand(c){
    if (c.cmd === 'speak-card') { showSpeakCard(c); return; }
    if (!speakSession || speakSession.id !== c.id) return;
    if (c.cmd === 'speak-audio') { startNativeAudio(c); return; }
    if (c.cmd === 'speak-phase') speakPhase = c.phase;
    if (c.cmd === 'speak-end') {
      stopSpeakAudio();
      speakPhase = c.reason === 'error' ? 'error' : 'done';
      speakCloseAt = Date.now() + (c.reason === 'done' ? 650 : c.reason === 'error' ? 1800 : 0);
      if (c.resumeQuizMs && st.quiz) st.quizResultHideAt = Date.now() + c.resumeQuizMs;
    }
  }
  var answerHideAt = 0;
  function showAnswerCard(){
    hideQuizCard();
    quizWin = makeCardWin(x, y, M.answerPng, M.answerW, M.answerH);
    cardKind = 'answer';
    var af = quizWin.frame;
    animateCardIn(Math.round(af.origin.x), Math.round(af.origin.y));
    quizMtime = 0;
    answerHideAt = Date.now() + 15000;
  }
  function showQuizCard(){
    if (quizWin) { quizWin.orderOut($()); quizWin = null; }
    var qw = lastQuizGeom ? lastQuizGeom.w : M.quizW;
    var qh = lastQuizGeom ? lastQuizGeom.h : M.quizH;
    quizWin = makeCardWin(x, y, M.quizPng, qw, qh);
    cardKind = 'quiz';
    syncQuizWinPosition();
    var qf = quizWin.frame;
    animateCardIn(Math.round(qf.origin.x), Math.round(qf.origin.y));
    quizMtime = 0;   // 子窗重建后重置 mtime 基线,保证新 PNG 一定会触发一次重绘
  }
  function hideQuizCard(){
    if (quizWin) { quizWin.orderOut($()); quizWin = null; }
    quizGripView = null;
    quizScrollView = null;
    quizMtime = 0;
  }
  // quiz.png mtime 轮询:伴侣在出题/作答后重渲 PNG,子窗发现文件变了自动重绘
  // (作答后的对/错标记卡就是靠这条路径显示的)。PNG 不存在(已撤)→ 关子窗。
  var quizMtime = 0;
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(0.35, true, function(){
    if (!quizWin) return;
    try {
      var watchPng = cardKind === 'answer' ? M.answerPng : M.quizPng;
      var at = $.NSFileManager.defaultManager.attributesOfItemAtPathError(watchPng, $());
      if (!at) { hideQuizCard(); st.quiz = false; if (st.mode === 'quiz') { st.mode = 'idle'; st.idleHoldUntil = Date.now() + 1500; } grip.setNeedsDisplay(true); return; }
      var d = at.objectForKey($.NSFileModificationDate);
      if (!d) return;
      var mt = d.timeIntervalSince1970 || 0;
      if (mt > quizMtime + 0.05) {
        quizMtime = mt;
        quizGripView.setNeedsDisplay(true);   // 重绘的是 qgrip 自己,不是 contentView
      }
    } catch (e) {}
  });

  // ---- 主循环 50ms ----
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(0.05, true, function(){
    var now = Date.now();
    tickPatrickIdle(now);
    tickSpeakCard(now);
    tickSpeakMotion(now);
    if (bubble && now > bubble.until) { bubble = null; grip.setNeedsDisplay(true); }
    // 动画序列推进
    if (st.animSeq) {
      if (now - st.animLast >= st.animTickMs) {
        st.animLast = now;
        st.animSeqIdx++;
        if (st.animSeqIdx >= st.animSeq.length) {
          if (st.animSeqOnce) { var then = st.animThen; st.animSeq = null; st.animThen = null; if (then) then(); }
          else st.animSeqIdx = 0;
        }
        if (st.animSeq) st.animSeqFrame = st.animSeq[st.animSeqIdx];
      }
    }
    if (st.mode === 'drag') {
      if (speakPlayer || speakMouth.open>0) grip.setNeedsDisplay(true);
      return;
    }
    if (st.quiz && !quizWin && st.hover) {
      st.target = null; st.mode = 'hover'; st.frame = FR.wave0;
      grip.setNeedsDisplay(true); return;
    }
    // 悬停 → 挥手 + 气泡
    if (st.hover && !st.quiz && !speakWin && now > speakPendingUntil && st.mode !== 'drag' && st.mode !== 'jump') {
      if (st.mode !== 'hover') {
        st.mode = 'hover'; st.target = null; bubble = null;
        playSeq([FR.wave0, FR.wave1, FR.wave0, FR.wave1, FR.wave0], 300, false, null);
        st.hoverBubbleAt = now + 400;
      }
      if (st.hoverBubbleAt && now >= st.hoverBubbleAt) { st.hoverBubbleAt = 0; showHoverBubble(); }
      st.frame = st.animSeq ? st.animSeqFrame : FR.wave0;
      grip.setNeedsDisplay(true);
      return;
    }
    if (st.mode === 'hover' && !st.hover) { st.mode = 'idle'; st.idleHoldUntil = now + 800; st.animSeq = null; bubble = null; }
    if (answerHideAt && now >= answerHideAt) { answerHideAt = 0; if (cardKind === 'answer') hideQuizCard(); }
    if (st.quizResultHideAt && now >= st.quizResultHideAt) {   // 结果展示完毕,撤卡恢复散步
      st.quizResultHideAt = 0;
      st.quiz = false; if (st.mode === 'quiz') { st.mode = 'idle'; st.idleHoldUntil = now + 1500; }
      hideQuizCard();
    }
    if (st.quiz && quizWin) {
      // 有特效时不要覆盖帧(答对=开心脸 / 答错=难过脸);特效结束后才回到思考脸。
      if (!st.fx) st.frame = speakMotion.amount>0.05 ? speakingFrame(now) : now - (st.listenTap || 0) < 650 ? FR.happy0 : FR.think0;
      grip.setNeedsDisplay(true);
      return;
    }
    if (speakWin || speakMotion.amount>0.01) { st.frame = speakMotion.amount>0.05 ? speakingFrame(now) : FR.idle0; grip.setNeedsDisplay(true); return; }
    if (st.mode === 'jump') {
      var jt = (now - st.jumpStart) / 420;
      if (jt >= 1) { st.mode = 'idle'; st.idleHoldUntil = now + 1200; y = st.jumpY0; setFrame(); st.frame = FR.idle0; }
      else {
        var arc = Math.sin(Math.PI * jt) * 26;
        y = st.jumpY0 + arc; setFrame();
        st.frame = jt < 0.5 ? FR.happy0 : FR.idle0;
      }
      grip.setNeedsDisplay(true);
      return;
    }
    if (st.mode === 'walk') {
      if (st.target == null) { st.mode = 'idle'; return; }
      var wt = Math.min(1, (now - st.walkStart) / st.walkDur);
      // easeInOutQuad:起步加速、到点减速,运动连续不再一顿一顿
      var we = wt < 0.5 ? 2 * wt * wt : 1 - Math.pow(-2 * wt + 2, 2) / 2;
      var dxT = st.target - st.walkFromX, dyT = st.targetY - st.walkFromY;
      x = st.walkFromX + dxT * we;
      y = st.walkFromY + dyT * we;
      if (Math.abs(dxT) > 2) st.facing = dxT > 0 ? 1 : -1;
      win.setFrameOrigin($.NSMakePoint(x, y));
      if (quizWin) syncQuizWinPosition();   // 出题时走路,卡片跟随
      if (bubbleWin) layoutBubbleWin();     // 气泡跟随
      // 行走帧跟着"实际走过的距离"推进(每 22pt 一帧),并按朝向选右/左组
      var travelled = st.walkDist * we;
      var walkBase = st.facing === 1 ? FR.walkR0 : FR.walkL0;
      st.frame = walkBase + (Math.floor(travelled / 22) % 4);
      if (wt >= 1) {
        st.mode = 'idle'; st.idleHoldUntil = now + 2500 + Math.random() * 6000;
        st.blinkAt = now + 700 + Math.random() * 2500;
        st.animSeq = null; st.frame = FR.idle0; st.target = null;
      }
      grip.setNeedsDisplay(true);
      return;
    }
    // idle
    if (now >= st.idleHoldUntil) {
      if (M.roam && !reduceMotion() && !idleLocked && !idleSleeping && Math.random() < 0.5) {
        var margin = 24;
        // screen 可能是兜底矩形,无碍;但唤醒后宽高会变,每圈现取
        var ms2 = $.NSScreen.mainScreen;
        if (ms2 && ms2.frame) screen = ms2.frame;
        var nx = screen.origin.x + margin + Math.random() * Math.max(1, screen.size.width - W - margin * 2);
        var ny = screen.origin.y + margin + Math.random() * Math.max(1, screen.size.height * 0.55 - H);
        var wdist = Math.sqrt((nx - x) * (nx - x) + (ny - y) * (ny - y));
        if (wdist < 12) { st.idleHoldUntil = now + 1800; }
        else {
          st.target = nx; st.targetY = ny;
          st.mode = 'walk';
          st.walkFromX = x; st.walkFromY = y;
          st.walkStart = now;
          // 90–140 pt/s:走路自然,不再是每 tick 跳几十点的瞬移
          var speed = idleState.phase === 2 ? 100 : idleState.phase === 1 ? 45 : 65;
          st.walkDur = Math.max(320, (wdist / speed) * 1000);
          st.walkDist = wdist;
        }
      } else {
        st.idleHoldUntil = now + 2500 + Math.random() * 5000;
      }
    }
    if (now >= st.blinkAt && st.mode === 'idle') {
      var resting = idleState.phase === 2 ? FR.angry0 : idleState.phase === 1 ? FR.sad0 : FR.idle0;
      playSeq([resting, idleState.phase ? resting : FR.blink, resting], 90, true, null);
      st.blinkAt = now + 1800 + Math.random() * 4200;
    }
    if (!st.animSeq && idleState.phase === 0) {
      var r = Math.random();
      if (r < 0.006) playSeq([FR.idle0, FR.lookL, FR.idle0], 280, true, null);
      else if (r < 0.012) playSeq([FR.idle0, FR.lookR, FR.idle0], 280, true, null);
    }
    st.frame = st.animSeq ? st.animSeqFrame : idleState.phase === 2 ? FR.angry0 : idleState.phase === 1 ? FR.sad0 : st.frame;
    grip.setNeedsDisplay(true);
  });

  // 空闲每 0.8s;用户朗读期间每 0.2s,避免点击/声音状态落后。请求串行防乱序。
  var lastCmdSeq = 0, cmdPolling = false, cmdPollAt = 0;
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(0.2, true, function(){
    if (cmdPolling || (!speakWin && Date.now() > speakPendingUntil && Date.now()-cmdPollAt < 800)) return;
    cmdPolling = true; cmdPollAt = Date.now();
    var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + M.port + '/pet-patrick.json?after=' + lastCmdSeq));
    req.setTimeoutInterval(3);
    $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){
      cmdPolling = false;
      if (!data) return;
      try {
        var d = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
        if (!d || !d.ok) return;
        if (d.idle) updateIdleContext(d.idle, Date.now());
        lastCmdSeq = Math.max(Number(d.seq) || 0, lastCmdSeq);
        if (d.quizGeom) {
          lastQuizGeom = d.quizGeom; syncQuizWinSize();
          if (d.quizGeom.hold) st.quizResultHideAt = 0;
          if (quizGripView) quizGripView.setNeedsDisplay(true);
        }
        (d.commands || []).forEach(function(c){
          if (c.cmd === 'bubble') {
            bubble = { lines: c.lines, until: Date.now() + (c.ms || 6500) };
            grip.setNeedsDisplay(true);
          } else if (c.cmd === 'quiz') {
            hideSpeakCard();
            hideQuizCard();
            st.quizResultHideAt = 0;
            st.quiz = true; st.mode = 'idle'; st.animSeq = null; bubble = null;
            // A pending question never pins the pet. Hover reveals the existing
            // question, and the shown acknowledgement is sent once per quiz.
            if (st.hover) revealIdleQuiz(Date.now());
            grip.setNeedsDisplay(true);
          } else if (c.cmd === 'quiz-end') {
            hideSpeakCard();
            st.quiz = false; if (st.mode === 'quiz') { st.mode = 'idle'; st.idleHoldUntil = Date.now() + 1500; }
            hideQuizCard();
            bubble = st.hover && c.lines ? { lines: c.lines, until: Date.now() + (c.ms || 6000) } : null;
            grip.setNeedsDisplay(true);
          } else if (c.cmd === 'answer-card') {
            // 派大星先转头+开心,再滑出卡片(有"它给你看"的感觉)
            st.facing = 1; st.frame = FR.happy0; st.animSeq = null;
            grip.setNeedsDisplay(true);
            var _ac = Date.now();
            $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(0.14, true, function(tm){
              tm.invalidate;
              showAnswerCard();
              st.frame = FR.think0;
              grip.setNeedsDisplay(true);
            });
          } else if (c.cmd === 'speak-card' || c.cmd === 'speak-phase' || c.cmd === 'speak-audio' || c.cmd === 'speak-end') {
            handleSpeakCommand(c);
          } else if (c.cmd === 'quiz-result') {
            // 答题特效:答对撒星星+光环,答错抖动+红环
            var kind = c.effect === 'correct' ? 'correct' : 'wrong';
            st.fx = { kind: kind, start: Date.now(), dur: kind === 'correct' ? 950 : 620 };
            if (kind === 'correct') {
              st.fxParticles = [];
              for (var pi = 0; pi < 9; pi++) {
                var ang = -Math.PI / 2 + (pi - 4) * 0.42 + (Math.random() - 0.5) * 0.3;
                st.fxParticles.push({
                  dx: Math.cos(ang) * (34 + Math.random() * 26),
                  dy: Math.sin(ang) * (34 + Math.random() * 22),
                  size: 4 + Math.random() * 3.5,
                  alpha: 0.75 + Math.random() * 0.25,
                  r: 1.0, g: 0.82 + Math.random() * 0.15, b: 0.35 + Math.random() * 0.3,
                });
              }
              st.frame = FR.happy0;      // 开心脸
            } else {
              st.shakeUntil = Date.now() + 420;
              st.frame = FR.sad0;        // 难过脸
            }
            grip.setNeedsDisplay(true);
            // 作答完成:st.quiz 保持 true(派大星留在 think 帧),子窗继续显示——
            // quiz.png 被伴侣重渲后 mtime 轮询会自动重绘出对/错标记卡;
            // ms 毫秒后由 hideResultTimer 撤卡恢复散步。
            bubble = c.lines ? { lines: c.lines, until: Date.now() + (c.ms || 2600) } : null;
            st.quizResultHideAt = c.hold ? 0 : Date.now() + (c.ms || 2600);
            grip.setNeedsDisplay(true);
          } else if (c.cmd === 'pose') {
            st.mode = 'idle'; st.idleHoldUntil = Date.now() + (c.ms || 2500);
            st.frame = FR[c.pose] != null ? FR[c.pose] : FR.idle0;
            st.animSeq = null;
            if (c.lines) bubble = { lines: c.lines, until: Date.now() + (c.ms || 6000) };
            grip.setNeedsDisplay(true);
          } else if (c.cmd === 'words') {
            M.words = c.words;
            if (c.exampleLines) M.exampleLines = c.exampleLines;
          } else if (c.cmd === 'speak-all') {
            // 伴侣侧已经把 6 个词逐个入队;这里只负责展示气泡与动画
            bubble = { lines: c.lines || [{ text: '正在朗读这一页的 ' + ((M.words && M.words.length) || 0) + ' 个词', size: 11 }], until: Date.now() + (c.ms || 8000) };
            st.mode = 'jump'; st.jumpStart = Date.now(); st.jumpY0 = y; st.animSeq = null;
            grip.setNeedsDisplay(true);
          } else if (c.cmd === 'jump') {
            st.mode = 'jump'; st.jumpStart = Date.now(); st.jumpY0 = y; st.animSeq = null;
          } else if (c.cmd === 'celebrate') {
            // 达标庆祝:开心脸 + 连跳 + 两次撒星星(复用 fx 粒子),气泡说话。
            st.quiz = false;
            st.mode = 'idle'; st.idleHoldUntil = Date.now() + (c.ms || 3500);
            st.frame = FR.happy0; st.animSeq = null;
            st.fx = { kind: 'correct', start: Date.now(), dur: 1400 };
            st.fxParticles = [];
            for (var pi = 0; pi < 14; pi++) {
              var ang = -Math.PI / 2 + (pi - 7) * 0.30 + (Math.random() - 0.5) * 0.3;
              st.fxParticles.push({
                dx: Math.cos(ang) * (36 + Math.random() * 34),
                dy: Math.sin(ang) * (34 + Math.random() * 30),
                size: 4 + Math.random() * 4,
                alpha: 0.8 + Math.random() * 0.2,
                r: 1.0, g: 0.78 + Math.random() * 0.2, b: 0.3 + Math.random() * 0.35,
              });
            }
            // 连跳三下(260ms 间隔)
            var jumps = 3, j = 0;
            var jt = $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(0.26, true, function(t2){
              j++;
              if (j >= jumps) { t2.invalidate; st.mode = 'idle'; st.frame = FR.happy1; grip.setNeedsDisplay(true); return; }
              st.mode = 'jump'; st.jumpStart = Date.now(); st.jumpY0 = y; st.animSeq = null;
            });
            bubble = { lines: c.lines || [{ text: '🎉 太棒了！目标达成！', size: 12, bold: true }], until: Date.now() + (c.ms || 3500) };
            grip.setNeedsDisplay(true);
          }
        });
      } catch (e2) {}
    });
  });

  // 孤儿自毁 + 心跳
  var missTicks = 0;
  function petSelfDestruct(){ saveIdleClock(); idleTimerWin.orderOut($()); idleNudgeWin.orderOut($()); if (bubbleWin) { try { bubbleWin.orderOut($()); } catch {} bubbleWin = null; } hideSpeakCard(); hideQuizCard(); win.orderOut($()); $.exit(0); }
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(2, true, function(){
    missTicks++;
    if (M.ownerPid && OWNER_PPID !== String(M.ownerPid)) petSelfDestruct();
    if (missTicks >= 8) petSelfDestruct();
    var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + M.port + '/pet-owner.json'));
    req.setTimeoutInterval(3);
    $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){
      if (data) {
        try {
          var o = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
          if (o && o.ok && o.ownerPid) {
            if (String(o.ownerPid) !== String(M.ownerPid)) petSelfDestruct();
            missTicks = 0;
          }
        } catch (e2) {}
      }
    });
  });
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(3, true, function(){ savePos(); saveIdleClock(); });

  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  $.NSApplication.sharedApplication.run;
}`;
}

/* Render the pet card as SVG (rasterized to PNG later). The pet WINDOW is a
 * borderless draggable grip that just draws this image — no WKWebView, because
 * a web view swallows the mouse drag (movableByWindowBackground won't work). */
function buildPetSVG(words, reminders, uiTheme, W, H) {
  const s = 2; // render at 2x so it's crisp on retina
  const w = W * s, h = H * s;
  const { padX, padY, headerH, bodyBottomGap } = PET_FRAME;
  const footerH = PET_FOOTER_H;
  const parts = [];
  const skin = petSkin(uiTheme);
  const { shell, shell2, shellLine, card, card2, ink, sub, moss, rust, rustStrong, gold, mist, phonetic } = skin;
  parts.push(`<defs>` +
    `<linearGradient id="shellG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${shell}"/><stop offset="1" stop-color="${shell2}"/></linearGradient>` +
    `<linearGradient id="topG" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${skin.top1}"/><stop offset=".58" stop-color="${skin.top2}"/><stop offset="1" stop-color="${skin.top3}"/></linearGradient>` +
    `<linearGradient id="cardG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${card}"/><stop offset="1" stop-color="${card2}"/></linearGradient>` +
    `<linearGradient id="liquidRim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${skin.dark ? '#b9cdf7' : '#ffffff'}"/><stop offset=".32" stop-color="${skin.dark ? '#5f7ec4' : '#f4e4ec'}"/><stop offset=".58" stop-color="${skin.dark ? '#3d5a9e' : '#e7f2ed'}"/><stop offset=".78" stop-color="${skin.dark ? '#44619f' : '#ebe8f6'}"/><stop offset="1" stop-color="${skin.dark ? '#a9c0f2' : '#ffffff'}"/></linearGradient>` +
    `<filter id="shellShadow" x="-18%" y="-15%" width="136%" height="140%"><feDropShadow dx="0" dy="${5 * s}" stdDeviation="${7 * s}" flood-color="${skin.shellShadow}" flood-opacity="${skin.shellShadowOpacity}"/></filter>` +
    `<filter id="cardShadow" x="-12%" y="-14%" width="124%" height="135%"><feDropShadow dx="0" dy="${1.6 * s}" stdDeviation="${2.2 * s}" flood-color="${skin.cardShadow}" flood-opacity="${skin.cardShadowOpacity}"/></filter>` +
    `</defs>`);
  const fam = skin.font;
  const txt = (x, y, str, size, fill, weight) =>
    `<text x="${x}" y="${y}" font-family="${fam}" font-size="${size}" fill="${fill}"${weight ? ` font-weight="${weight}"` : ''}>${esc(str)}</text>`;
  const ctxt = (cx, cy, str, size, fill, weight) =>
    `<text x="${cx}" y="${cy}" text-anchor="middle" font-family="${fam}" font-size="${size}" fill="${fill}"${weight ? ` font-weight="${weight}"` : ''}>${esc(str)}</text>`;
  const rtxt = (x, y, str, size, fill, weight) =>
    `<text x="${x}" y="${y}" text-anchor="end" font-family="${fam}" font-size="${size}" fill="${fill}"${weight ? ` font-weight="${weight}"` : ''}>${esc(str)}</text>`;
  const maxW = w - 2 * padX * s;
  const estW = (str, fs) => { let u = 0; for (const ch of String(str)) u += /[　-鿿豈-﫿]/.test(ch) ? 1 : (ch === ' ' ? 0.3 : 0.55); return u * fs; };
  // 外壳是一个悬浮的记忆舱，而不是动物身体或笔记本轮廓。
  parts.push(`<rect x="${4 * s}" y="${4 * s}" width="${(W - 8) * s}" height="${(H - 8) * s}" rx="${22 * s}" fill="url(#shellG)" opacity="${skin.shellOpacity}" filter="url(#shellShadow)"/>`);
  parts.push(`<rect x="${5 * s}" y="${5 * s}" width="${(W - 10) * s}" height="${(H - 10) * s}" rx="${21 * s}" fill="none" stroke="${shellLine}" stroke-width="${.8 * s}" opacity=".72"/>`);
  parts.push(`<rect x="${7 * s}" y="${7 * s}" width="${(W - 14) * s}" height="${(headerH + 5) * s}" rx="${17 * s}" fill="url(#topG)" opacity="${skin.topOpacity}"/>`);
  if (skin.liquid) {
    parts.push(`<rect x="${5.7 * s}" y="${5.7 * s}" width="${(W - 11.4) * s}" height="${(H - 11.4) * s}" rx="${20.4 * s}" fill="none" stroke="url(#liquidRim)" stroke-width="${1.15 * s}" opacity=".78"/>`);
    parts.push(`<path d="M ${20 * s} ${12 * s} Q ${W * .34 * s} ${4.5 * s} ${W * .57 * s} ${11 * s}" fill="none" stroke="${skin.dark ? '#a9c0f2' : '#fff'}" stroke-width="${1.25 * s}" stroke-linecap="round" opacity="${skin.dark ? .5 : .68}"/>`);
  }
  parts.push(`<path d="M ${18 * s} ${(padY + headerH - 1) * s} H ${(W - 18) * s}" stroke="${gold}" stroke-width="${.8 * s}" opacity=".42"/>`);
  // 可拖动的标题区用三根短线做暗示，不添加新交互。
  [0, 1, 2].forEach(i => parts.push(`<rect x="${(W / 2 - 13 + i * 10) * s}" y="${10 * s}" width="${6 * s}" height="${1.2 * s}" rx="${.6 * s}" fill="${mist}" opacity=".28"/>`));

  // 小词灵头像 = 与网页一致的「书页+轨道」徽记(不再用卡通脸):虚线轨道环绕
  // 一本摊开的书,轨道上的圆点是唯一的状态点缀——成熟、安静,四套皮肤只换色。
  const sprite = (cx, cy, r) => (
    `<circle cx="${cx}" cy="${cy}" r="${r * 1.18}" fill="${skin.avatarOuter}" stroke="${skin.avatarStroke}" stroke-width="${1.1 * s}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${skin.avatarFace}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r * .74}" fill="none" stroke="${skin.avatarInk}" stroke-width="${.85 * s}" stroke-dasharray="${r * 1.55} ${r * .8}" transform="rotate(-55 ${cx} ${cy})" opacity=".42"/>` +
    `<g stroke="${skin.avatarInk}" stroke-width="${1.5 * s}" stroke-linecap="round" stroke-linejoin="round" fill="none">` +
    `<path d="M ${cx} ${cy - r * .32} c ${-r * .28} ${-r * .22} ${-r * .62} ${-r * .27} ${-r * .96} ${-r * .18} l 0 ${r * 1.4} c ${r * .34} ${-r * .1} ${r * .68} ${-r * .05} ${r * .96} ${r * .18} c ${r * .28} ${-r * .23} ${r * .62} ${-r * .28} ${r * .96} ${-r * .18} l 0 ${-r * 1.4} c ${-r * .34} ${-r * .1} ${-r * .68} ${-r * .05} ${-r * .96} ${r * .18} Z" fill="${skin.avatarInk}" fill-opacity=".07"/>` +
    `<path d="M ${cx} ${cy - r * .32} l 0 ${r * 1.4}"/>` +
    `<path d="M ${cx - r * .62} ${cy - r * .18} l ${r * .28} ${r * .08} M ${cx - r * .62} ${cy + r * .1} l ${r * .28} ${r * .08} M ${cx + r * .34} ${cy - r * .06} l ${r * .28} ${-r * .08} M ${cx + r * .34} ${cy + r * .22} l ${r * .28} ${-r * .08}"/>` +
    `</g>` +
    `<circle cx="${cx + r * .68}" cy="${cy - r * .62}" r="${r * .14}" fill="${skin.avatarAccent}"/>`
  );
  // 六个词槽是暖雾白「任务片」，左侧苔玉状态线将它们连成连续词流。
  const tile = (x, y, tw, th, rr) =>
    `<rect x="${x}" y="${y + 1.5 * s}" width="${tw}" height="${th}" rx="${rr}" fill="${skin.cardShadow}" opacity="${skin.cardShadowOpacity}" filter="url(#cardShadow)"/>` +
    `<rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="${rr}" fill="url(#cardG)" fill-opacity="${skin.cardOpacity}" stroke="${skin.cardStroke}" stroke-width="${.8 * s}"/>` +
    `<rect x="${x + 1.2 * s}" y="${y + rr * .7}" width="${2.2 * s}" height="${Math.max(0, th - rr * 1.4)}" rx="${1.1 * s}" fill="${moss}" opacity=".86"/>`;
  const faceR = 12.5;
  const faceX = padX + 18;
  const faceY = padY + 25;
  parts.push(sprite(faceX * s, faceY * s, faceR * s));
  const deck = state.petDecksByLibrary[CFG.library] || { index: 0, pages: [] };
  const pageLabel = words.length ? `第 ${deck.index + 1} 页 · ${words.length} 个首轮词` : '首轮新词已完成';
  parts.push(txt((faceX + 22) * s, (padY + 22) * s, '小词灵 · 首轮词流', 12.2 * s, skin.title, 700));
  parts.push(txt((faceX + 22) * s, (padY + 39) * s, pageLabel, 9.5 * s, skin.titleSub, 500));
  parts.push(`<circle cx="${(faceX + 14) * s}" cy="${(padY + 39 - 3) * s}" r="${2 * s}" fill="${moss}"/>`);
  // 右上角关闭按钮（✕）与形态切换按钮（⭐ 派大星）：✕ 在最右,⭐ 在其左
  const cR = 12 * s;
  const cX = w - padX * s - cR, cY = padY * s + cR;
  const sX = cX - cR * 2.6;   // ⭐ 中心
  parts.push(`<circle cx="${sX}" cy="${cY}" r="${cR}" fill="${skin.closeFill}" fill-opacity="${skin.liquid ? .62 : 1}" stroke="${skin.closeStroke}" stroke-width="${.8 * s}"/>`);
  // 星形(形态切换到派大星):五角星路径
  const starPts = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + i * Math.PI / 5;
    const rr = (i % 2 === 0 ? 5.2 : 2.3) * s;
    starPts.push(`${(sX + rr * Math.cos(ang)).toFixed(2)},${(cY + rr * Math.sin(ang)).toFixed(2)}`);
  }
  parts.push(`<polygon points="${starPts.join(' ')}" fill="${skin.avatarAccent}" stroke="none"/>`);
  parts.push(`<circle cx="${cX}" cy="${cY}" r="${cR}" fill="${skin.closeFill}" fill-opacity="${skin.liquid ? .62 : 1}" stroke="${skin.closeStroke}" stroke-width="${.8 * s}"/>`);
  parts.push(`<path d="M ${cX - 4.5 * s} ${cY - 4.5 * s} L ${cX + 4.5 * s} ${cY + 4.5 * s} M ${cX + 4.5 * s} ${cY - 4.5 * s} L ${cX - 4.5 * s} ${cY + 4.5 * s}" stroke="${skin.closeInk}" stroke-width="${1.45 * s}" stroke-linecap="round"/>`);
  // 单词区（底部预留 footerH 给提示行 + 按钮栏）
  const mode = petMode(W, H);
  const scale = petScale(W, H);              // 文字等比缩放：卡片越大字越大
  const footerTop = H - footerH;                       // pt
  const waX = padX, waY = padY + headerH;
  const waW = W - 2 * padX, waH = footerTop - waY - bodyBottomGap;
  const n = Math.max(1, words.length);
  const shown = words.slice(0, n);
  // 小词灵是日常学习卡：中文释义始终可见；只有记忆本会遮盖中文来做回忆检测。
  const meaning = wd => (wd.pos ? wd.pos + ' ' : '') + (wd.meaning || '');
  if (!words.length) {
    parts.push(ctxt(w / 2, (waY + waH * .45) * s, '这一词书的首轮新词已完成', 14 * s * scale, skin.empty, 700));
    parts.push(ctxt(w / 2, (waY + waH * .45 + 23 * scale) * s, '继续去艾宾浩斯记忆本巩固吧', 10 * s * scale, skin.emptySub));
  }
  if (mode === 'wide') {
    // 横版固定最多三列，保持卡片宽度与三层文字层级，不为填满宽度而挤成六个细条。
    const cols = Math.max(1, Math.min(n, 3, Math.floor(waW / (125 * scale)) || 1));
    const rows = Math.ceil(n / cols);
    const colW = waW / cols;
    const rowH = waH / rows;
    const cellScale = Math.min(scale, Math.max(0.78, rowH / 86));
    const gapX = 8 * scale, gapY = 7 * scale;
    shown.forEach((wd, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const cellX = waX + c * colW;
      const cellTop = waY + r * rowH;
      const cardTop = cellTop + gapY / 2, cardH = rowH - gapY;
      const ix = cellX + gapX / 2 + 11 * cellScale;
      const right = cellX + colW - gapX / 2 - 10 * cellScale;
      parts.push(tile((cellX + gapX / 2) * s, cardTop * s, (colW - gapX) * s, cardH * s, 11 * s * cellScale));
      const phoneticSize = Math.max(9, 8.4 * cellScale);
      const meaningSize = Math.max(9.3, 9.3 * cellScale);
      parts.push(txt(ix * s, (cardTop + cardH * .32) * s, truncate(wd.word, 14.5 * s * cellScale, (colW - gapX - 19) * s), 14.5 * s * cellScale, ink, 700));
      if (wd.phonetic) parts.push(rtxt(right * s, (cardTop + cardH * .57) * s, truncate(wd.phonetic, phoneticSize * s, (colW - gapX - 19) * s), phoneticSize * s, phonetic));
      parts.push(txt(ix * s, (cardTop + cardH * .79) * s, truncate(meaning(wd), meaningSize * s, (colW - gapX - 19) * s), meaningSize * s, sub));
    });
  } else if (mode === 'square') {
    // 方形：稳定的 2×3 连续词槽，英文、音标、中文都有独立基线。
    const cols = 2, rows = Math.max(1, Math.ceil(n / 2));
    const gapX = 8 * scale, gapY = 7 * scale;
    const colW = (waW - gapX) / cols;
    const rowH = waH / rows;
    const cellScale = Math.min(scale, Math.max(.82, rowH / 92));
    shown.forEach((wd, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const x = waX + c * (colW + gapX);
      const cellTop = waY + r * rowH;
      const cardTop = cellTop + gapY / 2, cardH = rowH - gapY;
      const ix = x + 10 * cellScale, right = x + colW - 10 * cellScale;
      parts.push(tile(x * s, cardTop * s, colW * s, cardH * s, 12 * s * cellScale));
      const phoneticSize = Math.max(9, 8.5 * cellScale);
      const meaningSize = Math.max(9.3, 9.4 * cellScale);
      parts.push(txt(ix * s, (cardTop + Math.max(21, cardH * .31)) * s, truncate(wd.word, 14.5 * s * cellScale, (colW - 18 * cellScale) * s), 14.5 * s * cellScale, ink, 700));
      if (wd.phonetic) parts.push(rtxt(right * s, (cardTop + Math.max(37, cardH * .54)) * s, truncate(wd.phonetic, phoneticSize * s, (colW - 18 * cellScale) * s), phoneticSize * s, phonetic));
      parts.push(txt(ix * s, (cardTop + Math.min(cardH - 8, Math.max(51, cardH * .78))) * s, truncate(meaning(wd), meaningSize * s, (colW - 18 * cellScale) * s), meaningSize * s, sub));
    });
  } else {
    // 竖版窄条：逐行词格，音标右对齐，中文始终保留。
    const rowH = waH / n;
    const tilePad = 2.5 * scale;                       // 贴纸上下留白
    const cellScale = Math.min(scale, Math.max(.8, rowH / 64));
    shown.forEach((wd, i) => {
      const rowTop = waY + i * rowH;
      const mid = rowTop + rowH / 2;
      parts.push(tile(waX * s, (rowTop + tilePad) * s, waW * s, (rowH - tilePad * 2) * s, 12 * s * scale));
      const ix = waX + 12 * cellScale, right = waX + waW - 11 * cellScale;
      const phoneticSize = Math.max(9, 9 * cellScale);
      const meaningSize = Math.max(9.5, 10.2 * cellScale);
      parts.push(txt(ix * s, (mid - 5 * cellScale) * s, truncate(wd.word, 15 * s * cellScale, waW * .62 * s), 15 * s * cellScale, ink, 700));
      if (wd.phonetic) parts.push(rtxt(right * s, (mid - 5 * cellScale) * s, truncate(wd.phonetic, phoneticSize * s, waW * .33 * s), phoneticSize * s, phonetic));
      parts.push(txt(ix * s, (mid + 13 * cellScale) * s, truncate(meaning(wd), meaningSize * s, (waW - 22 * cellScale) * s), meaningSize * s, sub));
    });
  }
  // 提醒（横版太矮放不下，只竖版/方形画；且单词区下方确有空间才画，避免压到按钮栏）
  if (reminders && reminders.length && mode !== 'wide') {
    let ry = waY + (mode === 'square' ? Math.ceil(n / 2) * (waH / Math.max(1, Math.ceil(n / 2))) : n * (waH / n)) + 4 * scale;
    if (ry < footerTop - 16 * scale) {           // 标签本身放得下才画
      parts.push(txt(padX * s, ry * s, '今日提醒', 12 * s * scale, gold, 700));
      ry += 18 * scale;
      reminders.slice(0, 5).forEach(r => {
        if (ry > footerTop - 14 * scale) return;   // 不压到按钮栏
        parts.push(`<circle cx="${(padX + 5 * scale) * s}" cy="${(ry - 3.5 * scale) * s}" r="${4.5 * s * scale}" fill="none" stroke="${rust}" stroke-width="${1.4 * s}"/>`);
        parts.push(txt(padX * s + 16 * s * scale, ry * s, truncate(r.text + (r.time ? ' · ' + r.time : ''), 11 * s * scale, maxW - 16 * s * scale), 11 * s * scale, skin.reminder));
        ry += 16 * scale;
      });
    }
  }
  parts.push(`<path d="M ${14 * s} ${(footerTop + 1) * s} H ${(W - 14) * s}" stroke="${shellLine}" stroke-width="${.7 * s}" opacity=".7"/>`);
  parts.push(ctxt(w / 2, (footerTop + 15) * s, '点词记首轮 · 记忆本完成周期巩固', 8.7 * s, skin.footerSub, 500));
  const btn = PET_BTN, actionW = W - 2 * padX - PET_RESIZE.size - 8;
  const btnW = Math.min(btn.w, Math.floor((actionW - btn.gap * (btn.count - 1)) / btn.count));
  const actionUsedW = btnW * btn.count + btn.gap * (btn.count - 1);
  const btnY = H - btn.bottomPad - btn.h;
  const btnX0 = padX + Math.max(0, (actionW - actionUsedW) / 2);
  const btnX1 = btnX0 + btnW + btn.gap, btnX2 = btnX1 + btnW + btn.gap;
  const petBtn = (x, label, tone) => {
    const prefix = tone === 'next' ? 'next' : tone === 'memory' ? 'memory' : 'prev';
    // 与网页同一套线性图标语言(24×24 描边):上一页/记忆本/下一页
    const iconD = tone === 'prev' ? 'M14.5 6.5 L8.5 12 L14.5 17.5'
      : tone === 'next' ? 'M9.5 6.5 L15.5 12 L9.5 17.5'
      : 'M6.5 4.2 h11 a.9 .9 0 0 1 .9 .9 V20.3 L12 16.8 L5.6 20.3 V5.1 a.9 .9 0 0 1 .9 -.9 Z';
    const inkC = skin[`${prefix}Ink`];
    const labelFs = 10.5, iconPt = 11, gapPt = 4.5;
    const groupW = iconPt + gapPt + estW(label, labelFs);
    const startX = x + Math.max(5, (btnW - groupW) / 2);
    const iconY = btnY + (btn.h - iconPt) / 2;
    const iconK = (iconPt / 24) * s;
    return `<rect x="${x * s}" y="${(btnY + 2) * s}" width="${btnW * s}" height="${btn.h * s}" rx="${12 * s}" fill="${skin.cardShadow}" opacity="${skin.liquid ? .08 : .2}"/>` +
      `<rect x="${x * s}" y="${btnY * s}" width="${btnW * s}" height="${btn.h * s}" rx="${12 * s}" fill="${skin[`${prefix}Fill`]}" fill-opacity="${skin.liquid && tone !== 'next' ? .7 : 1}" stroke="${skin[`${prefix}Stroke`]}" stroke-width="${.9 * s}"/>` +
      `<g transform="translate(${startX * s} ${iconY * s}) scale(${iconK})"><path d="${iconD}" fill="none" stroke="${inkC}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g>` +
      `<text x="${(startX + iconPt + gapPt) * s}" y="${(btnY + 22) * s}" font-family="${fam}" font-size="${labelFs * s}" font-weight="700" fill="${inkC}">${esc(label)}</text>`;
  };
  parts.push(petBtn(btnX0, '上一页', 'prev'));
  parts.push(petBtn(btnX1, '记忆本', 'memory'));
  parts.push(petBtn(btnX2, '下一页', 'next'));
  // ---- 右下角圆形拉伸把手：小而明确，不再使用生硬的三角形。----
  const rs = PET_RESIZE;
  const gcx = (W - rs.pad - rs.size / 2) * s, gcy = (H - rs.pad - rs.size / 2) * s, gr = (rs.size / 2) * s;
  parts.push(`<circle cx="${gcx}" cy="${gcy + 2 * s}" r="${gr}" fill="${skin.cardShadow}" opacity="${skin.liquid ? .1 : .26}"/>`);
  parts.push(`<circle cx="${gcx}" cy="${gcy}" r="${gr}" fill="${skin.handleFill}" fill-opacity="${skin.liquid ? .74 : 1}" stroke="${skin.handleStroke}" stroke-width="${.9 * s}"/>`);
  parts.push(`<path d="M ${gcx - 6 * s} ${gcy + 6 * s} L ${gcx + 6 * s} ${gcy - 6 * s} M ${gcx + 2 * s} ${gcy - 6 * s} H ${gcx + 6 * s} V ${gcy - 2 * s} M ${gcx - 2 * s} ${gcy + 6 * s} H ${gcx - 6 * s} V ${gcy + 2 * s}" stroke="${skin.handleInk}" stroke-width="${1.45 * s}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
}
/* SVG 文本不会自动换行,所有宽度都得自己估。全角字符按 1em、其它按 0.55em。 */
function charWidth(ch, fs) {
  return /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(ch) ? fs : (ch === ' ' ? fs * 0.3 : fs * 0.55);
}
/* wf = 拉丁字符的宽度系数(粗体/大字比小字更宽,调用方按需调大) */
function measureText(str, fs, wf) {
  let wid = 0;
  const latin = wf || 0.55;
  for (const ch of String(str)) {
    if (/\p{Mark}/u.test(ch)) continue;
    if (/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u.test(ch) || /\p{Extended_Pictographic}/u.test(ch)) wid += fs;
    else if (/\s/u.test(ch)) wid += fs * 0.33;
    else {
      // Conservative widths for the local Avenir/PingFang fonts; W/m must not be
      // measured like i/l. Bold headings need a little extra space as well.
      const ratio = /[MWmw@%&]/.test(ch) ? 1 : /[ilI.,'’!:;|]/.test(ch) ? 0.34 : /[A-Z]/.test(ch) ? 0.78 : 0.63;
      wid += fs * ratio * (latin / 0.55);
    }
  }
  return wid;
}
/* 大字号自动缩到能塞进一行(不折行时最好看);缩到 minFs 还放不下就交给 wrapText。 */
function fitFont(str, fs, maxW, minFs, wf) {
  let size = fs;
  while (size > minFs && measureText(str, size, wf) > maxW) size -= 0.5;
  return Math.max(minFs, size);
}
/* crude width estimate + truncate with ellipsis (SVG text doesn't wrap). */
function truncate(str, fs, maxW) {
  let out = '';
  let wid = 0;
  for (const ch of String(str)) {
    const cw = charWidth(ch, fs);
    if (wid + cw > maxW && out) return out.replace(/\s+$/, '') + '…';
    out += ch; wid += cw;
  }
  return out;
}
/* 折行:中文按字、英文按词切,避免把 "disproportionate" 劈成两半。
 * maxLines 之后的内容合并进最后一行并加省略号(正常情况下走不到,卡片高度会先长出来)。 */
function wrapText(str, fs, maxW, maxLines, wf) {
  const tokens = String(str == null ? '' : str).match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]|[A-Za-z0-9'’\-\/\.,;:!?]+|\s+|./g) || [];
  const lines = [];
  let cur = '', curW = 0;
  for (const tk of tokens) {
    if (/\r|\n/.test(tk)) {
      if (cur.trim()) lines.push(cur.trimEnd());
      cur = ''; curW = 0;
      continue;
    }
    const tw = measureText(tk, fs, wf);
    if (curW + tw > maxW && cur.trim()) {
      lines.push(cur.replace(/\s+$/, ''));
      cur = ''; curW = 0;
      if (/^\s+$/.test(tk)) continue;
    }
    if (!cur && /^\s+$/.test(tk)) continue;   // 行首不留空格
    if (tw > maxW) {
      // A single unbroken token can exceed the entire card. Break only then,
      // at grapheme boundaries, preserving accents and every character.
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(tk)) {
        const sw = measureText(segment, fs, wf);
        if (cur && curW + sw > maxW) { lines.push(cur); cur = ''; curW = 0; }
        cur += segment; curW += sw;
      }
      continue;
    }
    cur += tk; curW += tw;
  }
  if (cur.trim()) lines.push(cur.replace(/\s+$/, ''));
  if (!lines.length) return [''];
  if (maxLines && lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = truncate(kept[maxLines - 1] + ' ' + lines.slice(maxLines).join(''), fs, maxW);
    return kept;
  }
  return lines;
}

/* ---------------- 抽查卡(quiz card, 派大星模式的「艾宾浩斯抽查」) ----------------
 * 桌面上弹出的 4 选 1 小卡:英文词在上,四个中文释义选项。派大星站在卡下方举牌。
 * 作答结果经 /pet-quiz.php 落回 petMemoryEvents(action: 'quiz'),网页艾宾浩斯
 * 记忆本据此推进/重置阶段 —— 与网页记忆本「记住了/还没记住」完全同一条 SRS 链。 */
/* 卡片 PNG 路径:必须带进程 PID。
 * 2.4.6 修过「两个实例写同一个 /tmp 文件 → 留下写了一半的空白图」,壁纸与小词灵
 * 早都按 PID 分离了;抽查卡/朗读卡/回答卡沿用同一条约定,否则开两个 WordPaper 会
 * 互相覆盖对方的卡片。sips 输出带渲染序号,只原子发布当前版本。 */
const CARD_PNG = {
  quiz: path.join(os.tmpdir(), `dw_patrick_quiz-${process.pid}.png`),
  speak: path.join(os.tmpdir(), `dw_patrick_speak-${process.pid}.png`),
  answer: path.join(os.tmpdir(), `dw_patrick_answer-${process.pid}.png`),
};
const PET_QUIZ_W = 300, PET_QUIZ_H = 296;
/* 普通卡完整显示;超长内容显式折叠,展开后的原生滚动视图保留可读字号。 */
const QUIZ_CARD_MAX_H = 560;
/* 抽查卡底部两颗按钮(自上而下的 y 区间与左右分栏,与 buildQuizSVG 同步):
 *   左「下一个」   —— 不造句,直接出下一题
 *   右「造个句子」 —— 弹造句窗
 * 不是每个词都要造句:用户自己选。 */
const QUIZ_BTN_TOP = 232, QUIZ_BTN_BOTTOM = 264;
const QUIZ_BTN_GAP = 10;
const QUIZ_BTN_SKIP_X0 = 14;
const QUIZ_BTN_SKIP_X1 = 14 + (PET_QUIZ_W - 28 - QUIZ_BTN_GAP) / 2;              // 左半
const QUIZ_BTN_SENT_X0 = QUIZ_BTN_SKIP_X1 + QUIZ_BTN_GAP;                          // 右半
const QUIZ_BTN_SENT_X1 = PET_QUIZ_W - 14;
/* 独立朗读气泡:完整例句按内容增高;超出屏幕时用原生滚动视图承载。 */
const SPEAK_CARD_W = 340;
const ANSWER_CARD_W = 320, ANSWER_CARD_H = 150;
/* 派大星回答卡:显示 DeepSeek 对当前词的讲解(自动换行)。 */
function buildAnswerSVG(word, answer, dark) {
  const s = 2, W = ANSWER_CARD_W, H = ANSWER_CARD_H, w = W * s, h = H * s;
  const pink = '#f79ba6', seaGreen = '#a8d94f', outline = '#2b1d2e';
  const paper = dark ? '#241a2b' : '#fffaf6';
  const paperEdge = dark ? '#3a2b45' : '#ffe8ea';
  const ink = dark ? '#ffe9f0' : '#3a1f2b';
  const sub = dark ? '#c9a9d4' : '#8a6270';
  const fam = 'PingFang SC, Hiragino Sans GB, Avenir Next, sans-serif';
  const parts = [];
  parts.push(`<defs><linearGradient id="apaper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${paper}"/><stop offset="1" stop-color="${paperEdge}"/></linearGradient>
    <filter id="ash" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="${3*s}" stdDeviation="${3*s}" flood-color="${outline}" flood-opacity=".22"/></filter></defs>`);
  parts.push(`<rect x="${3*s}" y="${3*s}" width="${(W-6)*s}" height="${(H-6)*s}" rx="${16*s}" fill="url(#apaper)" stroke="${pink}" stroke-width="${2.2*s}" filter="url(#ash)"/>`);
  parts.push(`<path d="M ${14*s} ${10*s} h ${70*s} a ${6*s} ${6*s} 0 0 1 ${6*s} ${6*s} v ${14*s} a ${6*s} ${6*s} 0 0 1 ${-6*s} ${6*s} h ${-70*s} Z" fill="${seaGreen}" stroke="${outline}" stroke-width="${1.4*s}" stroke-linejoin="round"/>`);
  parts.push(`<text x="${20*s}" y="${24*s}" font-family="${fam}" font-size="${9.5*s}" font-weight="800" fill="${outline}">派大星说</text>`);
  if (word) parts.push(`<text x="${(W-16)*s}" y="${24*s}" text-anchor="end" font-family="Avenir Next, ${fam}" font-size="${11*s}" font-weight="700" fill="${sub}">${esc(String(word).slice(0, 18))}</text>`);
  // 正文自动换行:中文按字符、英文按空格切词,避免把 "course schedule" 劈成两半
  const lines = [];
  const MAXC = 22;                       // 每行最多字符(中文口径)
  let cur = '', curW = 0;
  const tokens = String(answer || '').match(/[\u4e00-\u9fff]|[A-Za-z0-9'’\-\.]+|\s+|./g) || [];
  for (const tk of tokens) {
    const tw = /^[\u4e00-\u9fff]$/.test(tk) ? 1 : (/^\s+$/.test(tk) ? 0.35 : tk.length * 0.55);
    if (curW + tw > MAXC && cur.trim()) { lines.push(cur.trim()); cur = ''; curW = 0; }
    if (/^\s+$/.test(tk) && !cur) continue;   // 行首不留空格
    cur += tk; curW += tw;
    if (lines.length >= 4) break;
  }
  if (cur.trim() && lines.length < 5) lines.push(cur.trim());
  lines.forEach((ln, i) => {
    parts.push(`<text x="${16*s}" y="${(50 + i * 17)*s}" font-family="${fam}" font-size="${11.5*s}" fill="${ink}">${esc(ln)}</text>`);
  });
  parts.push(`<text x="${(W/2)*s}" y="${(H-10)*s}" text-anchor="middle" font-family="${fam}" font-size="${9*s}" fill="${sub}">再双击可以换个问题 · 点一下继续背词</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
}
function buildSpeakSVG(word, example, dark, nativeText = false) {
  const W = SPEAK_CARD_W, pad = 22;
  const pink = dark ? '#f5a5b5' : '#b65a73';
  const ink = dark ? '#fff0f4' : '#382532';
  const sub = dark ? '#bda9c4' : '#876b7b';
  const fam = 'Avenir Next, PingFang SC, Hiragino Sans GB, sans-serif';
  const body = [];
  const text = (value, x, y, size, color, weight = 400, extra = '') =>
    `<text x="${x}" y="${y}" font-family="${fam}" font-size="${size}" font-weight="${weight}" fill="${color}" ${extra}>${esc(value)}</text>`;
  // 顶部左侧为原生绘制的声波/实时状态预留空间,右侧是安静的署名。
  body.push(text('PATRICK / 陪你读', W - pad, 29, 9, sub, 500, 'text-anchor="end" letter-spacing=".6"'));
  let y = 66;
  const wordSize = fitFont(word.word || '', 26, W - pad * 2, 22, 0.6);
  for (const line of wrapText(word.word || '', wordSize, W - pad * 2, 0, 0.6)) {
    body.push(text(line, pad, y, wordSize, ink, 700));
    y += 31;
  }
  if (word.phonetic) {
    for (const line of wrapText(word.phonetic, 11.5, W - pad * 2, 0, 0.6)) {
      body.push(text(line, pad, y - 10, 11.5, sub)); y += 16;
    }
  }
  y += 2;
  const panelTop = y;
  y += 23;
  body.push(text(example?.en ? '例句  /  EXAMPLE' : '单词发音', pad + 14, y, 9, sub, 600, 'letter-spacing="1"'));
  y += 27;
  // 只强调完整匹配的目标词,不高亮另一个单词里的相同字母。
  const target = String(word.word || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = target ? new RegExp(`(?<![\\p{L}])(${target})(?![\\p{L}])`, 'giu') : null;
  const enLines = example?.en ? wrapText(example.en, 15, W - pad * 2 - 28, 0, 0.57) : [];
  const lines = [];
  let textCursor = 0;
  for (const line of enLines) {
    const from = example.en.indexOf(line, textCursor);
    lines.push({text:line,x:pad+14,y,from,to:from+line.length});
    textCursor = from + line.length;
    const markup = matcher ? line.split(matcher).map((part, i) => i % 2
      ? `<tspan fill="${pink}" font-weight="600">${esc(part)}</tspan>` : esc(part)).join('') : esc(line);
    if (!nativeText) body.push(`<text x="${pad + 14}" y="${y}" font-family="${fam}" font-size="15" fill="${ink}">${markup}</text>`);
    y += 22;
  }
  if (!enLines.length) { body.push(text('暂无例句 · 先听单词发音', pad + 14, y, 12, sub)); y += 20; }
  if (example?.zh) {
    y += 3;
    for (const line of wrapText(example.zh, 11.5, W - pad * 2 - 28)) {
      body.push(text(line, pad + 14, y, 11.5, sub)); y += 18;
    }
  }
  const panelBottom = y + 2;
  const H = Math.ceil(panelBottom + 44);
  const shell = `<defs><linearGradient id="speech-paper" x1="0" y1="0" x2="1" y2="1">
    <stop stop-color="${dark ? '#302536' : '#fffaf7'}"/><stop offset="1" stop-color="${dark ? '#211b2b' : '#f9edf1'}"/>
    </linearGradient></defs>
    <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="19" fill="url(#speech-paper)" stroke="${dark ? '#b77e96' : '#dba2b2'}" stroke-width="1.2"/>
    <rect x="4" y="4" width="${W - 8}" height="${H - 8}" rx="16" fill="none" stroke="${dark ? '#ffffff' : '#ffffff'}" stroke-opacity="${dark ? '.045' : '.7'}"/>
    <rect x="${pad}" y="${panelTop}" width="${W - pad * 2}" height="${panelBottom - panelTop}" rx="11" fill="${dark ? '#1a1522' : '#fffdfb'}" fill-opacity=".65"/>
    <path d="M ${pad} ${panelTop + 15} V ${panelBottom - 15}" stroke="${pink}" stroke-width="2" stroke-linecap="round" opacity=".65"/>`;
  body.push(text('轻点派大星 · 再听一遍', pad, H - 18, 9.5, sub));
  body.push(text('读完自动收起', W - pad, H - 18, 9.5, sub, 400, 'text-anchor="end"'));
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}">${shell}${body.join('')}</svg>`, geom: { w: W, h: H, lines: nativeText ? lines : [] } };
}

/* Cocoa 坐标(y 向上)。候选位置先钳到当前屏幕,再按遮挡面积选择,
 * 通常从头顶冒出;上方空间不足时绕到另一侧,不覆盖选项。纯函数供原生与测试共用。 */
function speakCardPosition(pet, card, screen, obstacle) {
  var gap = 12, margin = 8;
  var candidates = [
    { x: pet.x + (pet.w - card.w) / 2, y: pet.y + pet.h + gap },
    { x: pet.x + (pet.w - card.w) / 2, y: pet.y - card.h - gap },
    { x: pet.x - card.w - gap, y: pet.y + pet.h - card.h },
    { x: pet.x + pet.w + gap, y: pet.y + pet.h - card.h },
  ];
  if (obstacle) {
    candidates.push({ x: obstacle.x, y: obstacle.y + obstacle.h + gap });
    candidates.push({ x: obstacle.x, y: obstacle.y - card.h - gap });
  }
  function overlap(a, b) {
    if (!b) return 0;
    return Math.max(0, Math.min(a.x + card.w, b.x + b.w) - Math.max(a.x, b.x))
      * Math.max(0, Math.min(a.y + card.h, b.y + b.h) - Math.max(a.y, b.y));
  }
  var best = null, score = Infinity;
  candidates.forEach(function(p, i) {
    p.x = Math.max(screen.x + margin, Math.min(p.x, screen.x + screen.w - card.w - margin));
    p.y = Math.max(screen.y + margin, Math.min(p.y, screen.y + screen.h - card.h - margin));
    var cost = overlap(p, obstacle) * 10 + overlap(p, pet) * 2 + i;
    if (cost < score) { best = p; score = cost; }
  });
  return { x: Math.round(best.x), y: Math.round(best.y) };
}

/* 悬停状态气泡(SVG):与抽查卡同一套派大星设计语言。
 * 三段:❗ 到期该复习 / ⏳ 艾宾浩斯倒计时(带进度条) / 🆕 还没背的新词。
 * 高度按行数算,调用方负责 sips 渲染。 */
function buildStatusBubbleSVG(status, dark) {
  const W = 300;   // 之前 280 装不下长词+中文注释,右侧会被裁
  const pink = '#f79ba6', seaGreen = '#a8d94f', seaDeep = '#8cba3a', purple = '#8b6bd9', outline = '#2b1d2e';
  const paper = dark ? '#241a2b' : '#fffaf6';
  const paperEdge = dark ? '#3a2b45' : '#ffe8ea';
  const ink = dark ? '#ffe9f0' : '#3a1f2b';
  const sub = dark ? '#c9a9d4' : '#8a6270';
  const good = '#4caf7d', bad = '#e2574c', warn = '#e8a33d';
  const fam = 'PingFang SC, Hiragino Sans GB, Avenir Next, sans-serif';
  const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const s = 2;

  const dueNow = (status || []).filter(x => x.kind === 'due');
  const timing = (status || []).filter(x => x.kind === 'countdown');
  const fresh = (status || []).filter(x => x.kind === 'new');
  const mastered = (status || []).filter(x => x.kind === 'mastered');

  // 行布局:每段一个 header + 每词一行;总高动态
  let y = 34;   // header 之下
  const rows = [];
  const fmtDue = (ms) => {
    const min = Math.max(1, Math.round(ms / 60000));
    if (min < 60) return min + ' 分钟';
    const h = Math.floor(min / 60), m = min % 60;
    if (h < 24) return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
    return Math.round(h / 24) + ' 天';
  };

  if (dueNow.length) {
    rows.push({ type: 'header', text: '❗ 该复习了', color: bad, y: y }); y += 20;
    dueNow.slice(0, 3).forEach(w => { rows.push({ type: 'word', text: w.word, note: '到点了', color: bad, y: y }); y += 19; });
    y += 4;
  }
  if (timing.length) {
    rows.push({ type: 'header', text: '⏳ 艾宾浩斯倒计时', color: seaDeep, y: y }); y += 20;
    timing.slice(0, 4).forEach(it => {
      const stage = Number(it.stage) || 0;
      const total = SRS_INTERVALS_MIN.length;
      const pct = Math.min(100, Math.round((stage / total) * 100));
      rows.push({ type: 'countdown', word: it.word, stage, total, pct, dueText: fmtDue(Number(it.dueInMs) || 0), y: y });
      y += 30;
    });
    y += 2;
  }
  if (fresh.length) {
    rows.push({ type: 'header', text: '🆕 还没背 ' + fresh.length + ' 个', color: purple, y: y }); y += 19;
    // 每词一行(之前挤成一行会被裁掉后半截)
    fresh.slice(0, 3).forEach(w => {
      rows.push({ type: 'word', text: w.word, note: '', color: purple, y: y });
      y += 18;
    });
    if (fresh.length > 3) {
      rows.push({ type: 'more', text: '还有 ' + (fresh.length - 3) + ' 个…', y: y });
      y += 15;
    }
  }
  if (mastered.length) {
    rows.push({ type: 'header', text: '✅ 已记牢 ' + mastered.length + ' 个', color: good, y: y }); y += 18;
  }
  y += 6;
  const H = Math.max(72, y);

  const parts = [];
  parts.push(`<defs>
    <linearGradient id="bpg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${paper}"/><stop offset="1" stop-color="${paperEdge}"/>
    </linearGradient>
    <filter id="bsh" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="${2*s}" stdDeviation="${2.5*s}" flood-color="${outline}" flood-opacity=".18"/>
    </filter>
  </defs>`);
  parts.push(`<rect x="${2*s}" y="${2*s}" width="${(W-4)*s}" height="${(H-4)*s}" rx="${14*s}" fill="url(#bpg)" stroke="${pink}" stroke-width="${2*s}" filter="url(#bsh)"/>`);
  // 顶部小旗
  parts.push(`<path d="M ${12*s} ${10*s} h ${84*s} a ${5*s} ${5*s} 0 0 1 ${5*s} ${5*s} v ${10*s} a ${5*s} ${5*s} 0 0 1 ${-5*s} ${5*s} h ${-84*s} Z" fill="${seaGreen}" stroke="${outline}" stroke-width="${1.2*s}" stroke-linejoin="round"/>`);
  parts.push(`<text x="${17*s}" y="${21*s}" font-family="${fam}" font-size="${9*s}" font-weight="800" fill="${outline}">学习状态</text>`);

  rows.forEach(r => {
    if (r.type === 'header') {
      parts.push(`<text x="${14*s}" y="${(r.y+9)*s}" font-family="${fam}" font-size="${9.5*s}" font-weight="800" fill="${r.color}">${esc(r.text)}</text>`);
    } else if (r.type === 'word') {
      parts.push(`<circle cx="${18*s}" cy="${r.y*s}" r="${2.2*s}" fill="${r.color}"/>`);
      parts.push(`<text x="${26*s}" y="${(r.y+4)*s}" font-family="Avenir Next, ${fam}" font-size="${11*s}" font-weight="700" fill="${ink}">${esc(r.text)}</text>`);
      parts.push(`<text x="${(W-14)*s}" y="${(r.y+4)*s}" text-anchor="end" font-family="${fam}" font-size="${9*s}" fill="${r.color}">${esc(r.note)}</text>`);
    } else if (r.type === 'countdown') {
      parts.push(`<text x="${26*s}" y="${(r.y+4)*s}" font-family="Avenir Next, ${fam}" font-size="${11*s}" font-weight="700" fill="${ink}">${esc(r.word)}</text>`);
      parts.push(`<text x="${(W-14)*s}" y="${(r.y+4)*s}" text-anchor="end" font-family="${fam}" font-size="${9*s}" fill="${sub}">第 ${r.stage+1}/${r.total} 轮 · ${esc(r.dueText)}后</text>`);
      // 进度条
      const bx = 26*s, bw2 = (W-52)*s, by2 = (r.y+8)*s, bh2 = 4*s;
      parts.push(`<rect x="${bx}" y="${by2}" width="${bw2}" height="${bh2}" rx="${2*s}" fill="${dark ? '#3a2b45' : '#f3e2e6'}"/>`);
      parts.push(`<rect x="${bx}" y="${by2}" width="${Math.max(2, bw2 * r.pct / 100)}" height="${bh2}" rx="${2*s}" fill="${seaGreen}"/>`);
    } else if (r.type === 'more') {
      parts.push(`<text x="${26*s}" y="${(r.y+4)*s}" font-family="${fam}" font-size="${8.5*s}" fill="${sub}">${esc(r.text)}</text>`);
    } else if (r.type === 'wordlist') {
      parts.push(`<text x="${26*s}" y="${(r.y+4)*s}" font-family="Avenir Next, ${fam}" font-size="${11*s}" font-weight="600" fill="${ink}">${esc(r.text)}</text>`);
      if (r.count > 5) parts.push(`<text x="${(W-14)*s}" y="${(r.y+4)*s}" text-anchor="end" font-family="${fam}" font-size="${9*s}" fill="${sub}">+${r.count-5}</text>`);
    }
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W*s}" height="${H*s}" viewBox="0 0 ${W*s} ${H*s}">${parts.join('')}</svg>`;
}

function buildQuizSVG(word, options, dark) {
  const s = 2, W = PET_QUIZ_W;
  // 派大星配色:粉身体 #f79ba6 / 海绿短裤 #a8d94f / 紫斑 #8b6bd9 / 描边 #2b1d2e
  const pink = '#f79ba6', pinkDeep = '#e87f8d', seaGreen = '#a8d94f', seaDeep = '#8cba3a';
  const purple = '#8b6bd9', outline = '#2b1d2e';
  const paper = dark ? '#241a2b' : '#fffaf6';
  const paperEdge = dark ? '#3a2b45' : '#ffe8ea';
  const ink = dark ? '#ffe9f0' : '#3a1f2b';
  const sub = dark ? '#c9a9d4' : '#8a6270';
  const good = '#4caf7d', bad = '#e2574c';
  const fam = 'PingFang SC, Hiragino Sans GB, Avenir Next, sans-serif';

  // 普通内容完整显示;超长释义明确折叠,展开后保留字号并用原生视图滚动。
  // 几何(optTops/optHs/btnTop/chip)随卡写入 quizGeom,子窗按它命中。 ──
  const body = [];
  const padX = 16, contentW = W - padX * 2;

  // 顶部小旗标:按类别换色换字 —— 一眼看出这词属于哪一类
  const cat = word.category || 'other';
  const flagFill = cat === 'review' ? '#f2a03d' : cat === 'fresh' ? seaGreen : '#c5b5ef';
  const flagText = cat === 'review' ? '⏰ 复习到期' : (cat === 'fresh' ? '🆕 桌面新词' : '词库新词');
  const flagW = cat ? 92 : 74;
  body.push(`<path d="M ${14*s} ${10*s} h ${flagW*s} a ${6*s} ${6*s} 0 0 1 ${6*s} ${6*s} v ${14*s} a ${6*s} ${6*s} 0 0 1 ${-6*s} ${6*s} h ${-flagW*s} Z" fill="${flagFill}" stroke="${outline}" stroke-width="${1.4*s}" stroke-linejoin="round"/>`);
  body.push(`<text x="${20*s}" y="${24*s}" font-family="${fam}" font-size="${9.5*s}" font-weight="800" fill="${outline}">${esc(flagText)}</text>`);

  // 单词:大字优先,一行放不下缩字号;13pt 还放不下就折行(仍然全显,不省略)
  const wordText = String(word.word || '');
  const phon = String(word.phonetic || '');
  let wordFs = fitFont(wordText, 22, contentW, 13, 0.62);
  let wordLines = [wordText];
  if (measureText(wordText, wordFs, 0.62) > contentW) {
    wordFs = 13;
    wordLines = wrapText(wordText, 13, contentW, 0, 0.62);
  }
  const wordBase = 36 + wordFs * 0.95;
  wordLines.forEach((ln, li) => {
    body.push(`<text x="${padX*s}" y="${(wordBase + li * wordFs * 1.18)*s}" font-family="Avenir Next, ${fam}" font-size="${wordFs*s}" font-weight="800" fill="${ink}">${esc(ln)}</text>`);
  });
  let y = 36 + wordLines.length * wordFs * 1.18 + 7;
  if (phon) {
    const wordOneLine = wordLines.length === 1;
    const wordW = wordOneLine ? measureText(wordText, wordFs, 0.62) : 0;
    if (wordOneLine && wordW + measureText(phon, 10.5) + 10 <= contentW) {
      body.push(`<text x="${(W-padX)*s}" y="${wordBase*s}" text-anchor="end" font-family="Avenir Next, ${fam}" font-size="${10.5*s}" fill="${sub}">${esc(phon)}</text>`);
    } else {
      wrapText(phon, 11, contentW, 0).forEach(ln => {
        body.push(`<text x="${padX*s}" y="${(y+4)*s}" font-family="Avenir Next, ${fam}" font-size="${11*s}" fill="${sub}">${esc(ln)}</text>`);
        y += 16;
      });
    }
  }

  // 复习中的词:显示「第 N/8 轮」+「下轮时间」
  const ri = (cat === 'review' && word.roundInfo) ? word.roundInfo : null;
  if (ri) {
    const next = ri.nextIn ? `答对后 ${ri.nextIn}复习` : '答对后完成全部周期';
    const roundText = word.done ? (word.correct ? (ri.nextIn ? `下次复习：${ri.nextIn}后` : '已完成全部复习周期') : '本轮未通过 · 20 分钟后复习') : `第 ${ri.stage + 1}/${ri.total} 轮 · ${next}`;
    wrapText(roundText, 10, contentW, 0).forEach(ln => {
      body.push(`<text x="${padX*s}" y="${(y+3)*s}" font-family="${fam}" font-size="${10*s}" font-weight="700" fill="#b66c16">${esc(ln)}</text>`);
      y += 15;
    });
  }
  if (word.expand) {
    body.push(`<text x="${padX*s}" y="${(y+3)*s}" font-family="${fam}" font-size="${10*s}" fill="${sub}">完整释义 · 可上下滚动查看</text>`);
    y += 15;
  }

  // 分隔虚线
  const lineY = y + 4;
  body.push(`<path d="M ${padX*s} ${lineY*s} H ${(W-padX)*s}" stroke="${pink}" stroke-width="${1*s}" stroke-dasharray="${3*s} ${3*s}" opacity=".55"/>`);
  const startY = lineY + 8;

  // 选项:每行按自己的折行数定高,折行数不限 —— 释义一字不少
  const optTextX = 48, optTextW = W - optTextX - 24;
  const measureLayout = (optFs, cap) => {
    const wrapped = options.map(o => wrapText(o === undefined || o === null ? '' : String(o), optFs, optTextW, cap));
    const heights = wrapped.map(ls => Math.max(29, ls.length * 15 + 14));
    const total = heights.reduce((a, b) => a + b, 0) + 5 * (options.length - 1);
    return { wrapped, heights, total };
  };
  const chromeH = 5 + 32 + 5 + 20;                       // 按钮间隙+按钮+提示
  const optFs = 12;
  let lay = measureLayout(optFs, 0);                      // cap 0 = 不限行数
  let collapsed = false, chipLabel = null;
  const needsExpansion = startY + lay.total + chromeH > QUIZ_CARD_MAX_H;
  const collapsedOptions = lay.wrapped.map(ls => needsExpansion && !word.expand && ls.length > 2);
  if (needsExpansion && !word.expand) {
    // The preview is explicitly marked; clicking a shortened option expands
    // it without submitting an answer. Full text is available at the same size.
    lay.wrapped = lay.wrapped.map(ls => ls.slice(0, 2));
    lay.heights = lay.wrapped.map(ls => Math.max(29, ls.length * 15 + 14));
    collapsed = true; chipLabel = '⌄ 展开完整释义';
  } else if (needsExpansion) {
    chipLabel = '⌃ 收起完整释义';
  }
  const answered = word.pickedIndex >= 0;
  const optTops = [], optHs = [];
  let oy = startY;
  options.forEach((opt, i) => {
    const rowH = lay.heights[i];
    optTops.push(Math.round(oy)); optHs.push(Math.round(rowH));
    const letter = 'ABCD'[i];
    const isAnswer = i === word.answerIndex;
    const isPicked = i === word.pickedIndex;
    let fill = dark ? '#2e2138' : '#ffffff';
    let stroke = dark ? '#4a3558' : '#f0d9de';
    let letterBg = dark ? '#3b2b49' : '#ffeef1';
    let letterInk = dark ? '#d9bfe6' : '#b5748a';
    let textInk = ink;
    if (answered && isAnswer) { fill = dark ? '#1f3d2f' : '#e8f7ee'; stroke = good; letterBg = good; letterInk = '#fff'; }
    else if (answered && isPicked && !isAnswer) { fill = dark ? '#3d2222' : '#fdeceb'; stroke = bad; letterBg = bad; letterInk = '#fff'; }
    body.push(`<rect x="${14*s}" y="${oy*s}" width="${(W-28)*s}" height="${rowH*s}" rx="${10*s}" fill="${fill}" stroke="${stroke}" stroke-width="${1.6*s}"/>`);
    const cy = oy + Math.min(rowH / 2, 22);
    body.push(`<circle cx="${31*s}" cy="${cy*s}" r="${8.5*s}" fill="${letterBg}"/>`);
    body.push(`<text x="${31*s}" y="${(cy+3.5)*s}" text-anchor="middle" font-family="Avenir Next, ${fam}" font-size="${10*s}" font-weight="800" fill="${letterInk}">${letter}</text>`);
    const lines = lay.wrapped[i];
    const padTop = (rowH - lines.length * 15) / 2;
    lines.forEach((ln, li) => {
      body.push(`<text x="${optTextX*s}" y="${(oy + padTop + 11 + li * 15)*s}" font-family="${fam}" font-size="${optFs*s}" fill="${textInk}">${esc(ln)}</text>`);
    });
    oy += rowH + 5;
  });
  y = oy - 5;

  // 展开/收起条(仅折叠/已展开时出现)
  let chipTop = null, chipBottom = null;
  if (chipLabel) {
    chipTop = Math.round(y + 3); chipBottom = chipTop + 22;
    body.push(`<rect x="${14*s}" y="${chipTop*s}" width="${(W-28)*s}" height="${22*s}" rx="${11*s}" fill="${dark ? '#2b2033' : '#fff6f2'}" stroke="${pink}" stroke-width="${1.3*s}" stroke-dasharray="${4*s} ${3*s}"/>`);
    body.push(`<text x="${(W/2)*s}" y="${(chipTop+14.5)*s}" text-anchor="middle" font-family="${fam}" font-size="${10*s}" font-weight="700" fill="${sub}">${esc(chipLabel)}</text>`);
    y = chipBottom;
  }

  // 底部两颗按钮:作答后点亮。用户自己决定「下一个」还是「造个句子」。
  const canAct = !!word.done;
  const btnTop = y + 5, btnH = 32, btnBottom = btnTop + btnH;
  const btnFill = (primary) => canAct
    ? (primary ? seaGreen : (dark ? '#33263f' : '#ffffff'))
    : (dark ? '#2b2033' : '#f7eef0');
  const btnStroke = () => canAct ? outline : (dark ? '#4a3558' : '#ead6db');
  // 左:下一个
  body.push(`<rect x="${QUIZ_BTN_SKIP_X0*s}" y="${btnTop*s}" width="${(QUIZ_BTN_SKIP_X1-QUIZ_BTN_SKIP_X0)*s}" height="${btnH*s}" rx="${10*s}" fill="${btnFill(false)}" stroke="${btnStroke()}" stroke-width="${1.6*s}"/>`);
  body.push(`<text x="${((QUIZ_BTN_SKIP_X0+QUIZ_BTN_SKIP_X1)/2)*s}" y="${(btnTop+20)*s}" text-anchor="middle" font-family="${fam}" font-size="${11*s}" font-weight="800" fill="${canAct ? ink : sub}">${canAct ? '下一个 ›' : '答完题可选'}</text>`);
  // 右:造个句子
  body.push(`<rect x="${QUIZ_BTN_SENT_X0*s}" y="${btnTop*s}" width="${(QUIZ_BTN_SENT_X1-QUIZ_BTN_SENT_X0)*s}" height="${btnH*s}" rx="${10*s}" fill="${btnFill(true)}" stroke="${btnStroke()}" stroke-width="${1.6*s}"/>`);
  body.push(`<text x="${((QUIZ_BTN_SENT_X0+QUIZ_BTN_SENT_X1)/2)*s}" y="${(btnTop+20)*s}" text-anchor="middle" font-family="${fam}" font-size="${11*s}" font-weight="800" fill="${canAct ? outline : sub}">${canAct ? '造个句子' : '—'}</text>`);
  y = btnBottom;

  // 底部提示
  const tip = word.done
    ? (word.correct ? (ri && !ri.nextIn ? '答对了！已完成全部复习周期' : '答对了！已安排下次复习') : '没关系，20 分钟后它会回来找你')
    : (collapsed ? '释义尚未展开 · 点击长选项可看全文' : '点选项作答 · 点派大星听例句');
  body.push(`<text x="${(W/2)*s}" y="${(y+12)*s}" text-anchor="middle" font-family="${fam}" font-size="${9.8*s}" font-weight="600" fill="${word.done ? (word.correct ? good : bad) : sub}">${esc(tip)}</text>`);
  const H = Math.round(y + 20);

  const geom = { w: W, h: H, optTop: optTops[0], optH: optHs[0], optTops, optHs, optCount: options.length,
    btnTop: Math.round(btnTop), btnBottom: Math.round(btnBottom), chipTop, chipBottom,
    collapsed, collapsedOptions, expanded: needsExpansion && word.expand === true, done: !!word.done };
  const wpx = W * s, hpx = H * s;
  const parts = [`<defs>
    <linearGradient id="qpaper" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${paper}"/><stop offset="1" stop-color="${paperEdge}"/>
    </linearGradient>
    <filter id="qshadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="${3*s}" stdDeviation="${3*s}" flood-color="${outline}" flood-opacity=".22"/>
    </filter>
  </defs>`];
  // 卡片底:圆角 + 粉色描边(卡通感),右下角轻微阴影
  parts.push(`<rect x="${3*s}" y="${3*s}" width="${(W-6)*s}" height="${(H-6)*s}" rx="${16*s}" fill="url(#qpaper)" stroke="${pink}" stroke-width="${2.2*s}" filter="url(#qshadow)"/>`);
  parts.push(...body);
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${wpx}" height="${hpx}" viewBox="0 0 ${wpx} ${hpx}">${parts.join('')}</svg>`, w: W, h: H, geom };
}

function buildPetJXA(W, H) {
  const meta = JSON.stringify({ btn: PET_BTN, frame: PET_FRAME, footerH: PET_FOOTER_H, rsz: PET_RESIZE, minW: MIN_PET_W, minH: MIN_PET_H, max: MAX_PET, port: CFG.port, count: petWords.length, wordKeys: petWords.map(petWordKey), dark: petSkin(CFG.uiTheme).dark === true, morphUrl: 'http://127.0.0.1:' + CFG.port + '/pet-mode.php?mode=patrick' });
  return `
ObjC.import('Cocoa');
ObjC.import('QuartzCore');
ObjC.import('stdlib');
ObjC.bindFunction('getppid', ['int', []]);
function run(argv){
  var pngPath = argv[0], corner = argv[1], posFile = argv[2], savedPos = argv[3], closeFile = argv[4], W = ${W}, H = ${H};
  var OWNER = argv[5] || '';   // 派生我的伴侣 PID;/pet-owner.json 对不上号 = 我是孤儿,自毁
  var OWNER_PPID = String($.getppid());   // 启动时取一次(2s 心跳里不再走 bridge)
  var TRANSITION = ${JSON.stringify(CFG.petTransition || 'dissolve-pop')};
  var META = ${meta};
  var BTN = META.btn, FRAME = META.frame, FOOTERH = META.footerH, RSZ = META.rsz, MINW = META.minW, MINH = META.minH, MAXS = META.max, PORT = META.port, COUNT = META.count, KEYS = META.wordKeys, skinDark = META.dark === true;
  var MORPH_URL = META.morphUrl;   // ⭐ → 派大星形态切换
  var rememberUrl = 'http://127.0.0.1:' + PORT + '/remember.php?i=';
  var pageUrl = 'http://127.0.0.1:' + PORT + '/pet-page.php?dir=';
  var memoryUrl = 'http://127.0.0.1:' + PORT + '/menu.php?cmd=workspace-memory';
  var sizeUrl = 'http://127.0.0.1:' + PORT + '/pet-size.php';
  var renderUrl = 'http://127.0.0.1:' + PORT + '/pet-render.php';
  var img = $.NSImage.alloc.initWithContentsOfFile(pngPath);
  var startX = 0, startY = 0, oX = 0, oY = 0, dragging = false, moved = false, downTime = 0, wordIndex = -1;
  var resizing = false, rStartX = 0, rStartY = 0, rW0 = 0, rH0 = 0, lastRenderAt = 0;
  function postUrl(u){
    var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString(u));
    req.setHTTPMethod('POST');
    req.setValueForHTTPHeaderField('1', 'X-WordPaper-Local');
    var data = $.NSURLConnection.sendSynchronousRequestReturningResponseError(req, $(), $());
    try { return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js; } catch (e) { return ''; }
  }
  // 点词/翻页成功后,服务端在响应里回传最新命中 key 表;原位换图不重开窗口,必须
  // 同步更新窗口自己的 KEYS,否则下一次点击 key 对不上 → stale 拒判 → “点不动”。
  function applyKeys(body){
    try { var d = JSON.parse(body || '{}'); if (d && d.ok && Object.prototype.toString.call(d.keys) === '[object Array]') KEYS = d.keys; } catch (e) {}
  }
  // 原地换图：服务端已把新 PNG 写到同一路径（同步 POST 返回时渲染已完成）。
  // 丝滑过渡 = 交叉溶解 + 弹性缩放,在 grip 自己的 drawRect 里按帧混合绘制旧/新图。
  // 关键:不用叠层视图——叠层 NSImageView 会拦截鼠标事件导致 grip 收不到点击(“点不动”
  // 的根因)。改用一个 ~60fps NSTimer 驱动 setNeedsDisplay,drawRect 里按进度混绘,
  // 期间 grip 的 mouseDown/拖动/缩放完全不受影响。失败自动退化瞬时替换。
  var fade = { active: false, oldImg: null, newImg: null, start: 0, mode: 'dissolve-pop' };
  function reloadImg(){
    lastMtime = Date.now() / 1000;   // 抬高轮询基线，避免 0.6s 轮询再覆盖一次
    var newImg = $.NSImage.alloc.initWithContentsOfFile(pngPath);
    if (TRANSITION === 'none') { img = newImg; grip.setNeedsDisplay(true); return; }   // 无动画
    try {
      fade.oldImg = img; fade.newImg = newImg; fade.start = Date.now(); fade.active = true; fade.mode = TRANSITION;
      var frames = 0;
      $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(0.016, true, function(timer){
        frames++;
        if (!fade.active || frames > 22) { fade.active = false; fade.newImg = null; img = newImg; timer.invalidate; }
        grip.setNeedsDisplay(true);
      });
    } catch (e) {   // 动画不可用 → 瞬时替换
      fade.active = false; fade.newImg = null; img = newImg; grip.setNeedsDisplay(true);
    }
  }
  // 动态布局：所有命中区都按“当前窗口尺寸”算，拉伸后无需重启窗口
  function layout(){
    var fs = win.frame.size;
    var W2 = fs.width, H2 = fs.height;
    var actionW = W2 - 2 * FRAME.padX - RSZ.size - 8;
    var bw = Math.min(BTN.w, Math.floor((actionW - BTN.gap * (BTN.count - 1)) / BTN.count));
    var usedW = bw * BTN.count + BTN.gap * (BTN.count - 1);
    var bx0 = FRAME.padX + Math.max(0, (actionW - usedW) / 2);
    return {
      W: W2, H: H2,
      closeX: W2 - FRAME.padX - 28, closeY: H2 - FRAME.padY - 28,
      morphX: W2 - FRAME.padX - 28 - 31, morphY: H2 - FRAME.padY - 28,   // ⭐ 在 ✕ 左侧
      rszX: W2 - RSZ.pad - RSZ.size, rszY0: RSZ.pad, rszY1: RSZ.pad + RSZ.size,
      btnX0: bx0, btnX1: bx0 + bw + BTN.gap, btnX2: bx0 + (bw + BTN.gap) * 2, btnW: bw
    };
  }
  // NSView 在不同 macOS/屏幕缩放组合下可能给出翻转的局部 y 坐标；
  // 为右下角圆形缩放把手同时保留两套命中坐标，避免视觉和热区错位。
  function inResizeY(p, L){ return (p.y >= L.rszY0 && p.y <= L.rszY1) || (p.y >= L.H - L.rszY1 && p.y <= L.H - L.rszY0); }
  function footerAction(p, L){
    // 三个按钮间距只有 8pt，因此命中区使用精确边界，杜绝翻页与记忆本互相抢事件。
    if (p.y < BTN.bottomPad - 3 || p.y > BTN.bottomPad + BTN.h + 3) return '';
    if (p.x >= L.btnX0 && p.x <= L.btnX0 + L.btnW) return 'prev';
    if (p.x >= L.btnX1 && p.x <= L.btnX1 + L.btnW) return 'memory';
    if (p.x >= L.btnX2 && p.x <= L.btnX2 + L.btnW) return 'next';
    return '';
  }
  // 与 SVG 的三种布局对应：只命中词泡泡，空白仍可自由拖动窗口。
  function wordAt(p){
    var fs = win.frame.size, W2 = fs.width, H2 = fs.height, qx = p.x, qy = H2 - p.y;
    if (COUNT < 1) return -1;
    var scale = Math.max(.74, Math.min(1.65, Math.sqrt((W2 / 320) * (H2 / 428))));
    var padX = FRAME.padX, padY = FRAME.padY, headerH = FRAME.headerH, footerH = FOOTERH;
    var waX = padX, waY = padY + headerH, waW = W2 - 2 * padX, waH = H2 - footerH - waY - FRAME.bodyBottomGap, n = COUNT;
    if (qx < waX || qx > waX + waW || qy < waY || qy > waY + waH) return -1;
    var ratio = W2 / H2;
    if (ratio >= 1.32) {
      var cols = Math.max(1, Math.min(n, 3, Math.floor(waW / (125 * scale)) || 1));
      var rows = Math.ceil(n / cols), colW = waW / cols, rowH = waH / rows;
      var gapX = 8 * scale, gapY = 7 * scale, lx = (qx - waX) % colW, ly = (qy - waY) % rowH;
      if (lx < gapX / 2 || lx > colW - gapX / 2 || ly < gapY / 2 || ly > rowH - gapY / 2) return -1;
      var c = Math.floor((qx - waX) / colW), r = Math.floor((qy - waY) / rowH), i = r * cols + c;
      return i < n ? i : -1;
    }
    if (ratio <= .72) {
      var rowH = waH / n, tilePad = 2.5 * scale, localY = (qy - waY) % rowH;
      if (localY < tilePad || localY > rowH - tilePad) return -1;
      var ri = Math.floor((qy - waY) / rowH); return ri < n ? ri : -1;
    }
    var squareGapX = 8 * scale, squareGapY = 7 * scale, cw = (waW - squareGapX) / 2;
    var rowH = waH / Math.ceil(n / 2), localY = (qy - waY) % rowH;
    if (localY < squareGapY / 2 || localY > rowH - squareGapY / 2) return -1;
    var dx = qx - waX, col = dx <= cw ? 0 : (dx >= cw + squareGapX ? 1 : -1);
    if (col < 0) return -1;
    var row = Math.floor((qy - waY) / rowH), si = row * 2 + col; return si < n ? si : -1;
  }
  // 拖动中实时重渲：用异步请求（不阻塞主线程），窗口全程跟手；
  // 渲染在服务端 ~50ms 完成，回到主线程后刷新成清晰图（token 保证只应用最新一次）
  var renderToken = 0, lastRenderAt = 0, lastRendered = '';
  function renderAsync(w, h){
    var nw = Math.round(w), nh = Math.round(h);
    var key = nw + 'x' + nh;
    if (key === lastRendered) return;             // 尺寸没变，跳过
    var now = Date.now();
    if (now - lastRenderAt < 90) return;          // 节流 ~11fps，不阻塞
    lastRenderAt = now;
    lastRendered = key;
    renderToken++;
    var tok = renderToken;
    var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString(renderUrl + '?w=' + nw + '&h=' + nh));
    req.setHTTPMethod('POST');
    $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){
      if (tok !== renderToken) return;            // 已有更新请求，丢弃这次
      img = $.NSImage.alloc.initWithContentsOfFile(pngPath);
      grip.setNeedsDisplay(true);
    });
  }
  var spawnedAt = Date.now();   // 只短暂过滤 spawn 幽灵事件，不能让用户刚召唤就无法调大小
  ObjC.registerSubclass({ name: 'DWGrip', superclass: 'NSView', methods: {
    'mouseDownCanMoveWindow': function () { return false; },
    'drawRect:': function (rect) {
      var fs = win.frame.size, R = $.NSMakeRect(0, 0, fs.width, fs.height);
      // 换词过渡:在 grip 自己 drawRect 里按帧混绘旧/新图——不叠加子视图,点击不受影响。
      if (fade.active && fade.newImg) {
        var t = (Date.now() - fade.start) / 280;
        if (t >= 1) { img = fade.newImg; fade.active = false; fade.newImg = null; img.drawInRectFromRectOperationFraction(R, $.NSZeroRect, $.NSCompositeSourceOver, 1); return; }
        if (t < 0) t = 0;
        var ease = 1 - Math.pow(1 - t, 3);                 // easeOutCubic
        var back = 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);  // easeOutBack(Q弹)
        var mode = fade.mode || 'dissolve-pop';
        if (mode === 'dissolve' || mode === 'dissolve-pop') {
          fade.oldImg.drawInRectFromRectOperationFraction(R, $.NSZeroRect, $.NSCompositeSourceOver, 1 - ease);
          var sc = mode === 'dissolve-pop' ? (0.90 + 0.10 * back) : 1;   // Q弹:0.90→1.0带回弹
          var nw = fs.width * sc, nh = fs.height * sc;
          fade.newImg.drawInRectFromRectOperationFraction($.NSMakeRect((fs.width - nw) / 2, (fs.height - nh) / 2, nw, nh), $.NSZeroRect, $.NSCompositeSourceOver, ease);
          return;
        }
        if (mode === 'pop') {
          fade.oldImg.drawInRectFromRectOperationFraction(R, $.NSZeroRect, $.NSCompositeSourceOver, 1);
          var ps = 0.86 + 0.14 * back, pw = fs.width * ps, ph = fs.height * ps;
          fade.newImg.drawInRectFromRectOperationFraction($.NSMakeRect((fs.width - pw) / 2, (fs.height - ph) / 2, pw, ph), $.NSZeroRect, $.NSCompositeSourceOver, ease);
          return;
        }
        // none:直接画新图
        img = fade.newImg; fade.active = false; fade.newImg = null;
        img.drawInRectFromRectOperationFraction(R, $.NSZeroRect, $.NSCompositeSourceOver, 1);
        return;
      }
      img.drawInRectFromRectOperationFraction(R, $.NSZeroRect, $.NSCompositeSourceOver, 1);
    },
    'mouseDown:': function (e) {
      var L = layout();
      var p = e.locationInWindow;
      if (p.x > L.closeX && p.y > L.closeY) {   // 右上角 ✕ 区域
        $.NSString.stringWithString('1').writeToFileAtomicallyEncodingError(closeFile, true, $.NSUTF8StringEncoding, $());
        win.orderOut($());
        $.NSApplication.sharedApplication.terminate($());   // 彻底退出，窗口消失
        return;
      }
      if (p.x > L.morphX && p.x <= L.morphX + 28 && p.y > L.morphY) {   // ⭐ → 派大星形态
        applyKeys(postUrl(MORPH_URL));   // 同步 POST:形态保存+窗口重建完成才返回
        return;
      }
      if (Date.now() - spawnedAt < 350) return;   // 预热期：不响应幽灵按下
      if (p.x >= L.rszX && inResizeY(p, L)) {   // 右下角拉伸手柄
        var rm = $.NSEvent.mouseLocation;
        rStartX = rm.x; rStartY = rm.y;
        var rf = win.frame;
        rW0 = rf.size.width; rH0 = rf.size.height;
        resizing = true; moved = true;
        return;
      }
      var action = footerAction(p, L);
      if (action) {
        // A footer mouseUp must never reuse the preceding word-card click state.
        dragging = false; wordIndex = -1; downTime = 0; moved = false;
      }
      if (action === 'prev') { applyKeys(postUrl(pageUrl + '-1')); reloadImg(); return; }
      if (action === 'next') { applyKeys(postUrl(pageUrl + '1')); reloadImg(); return; }
      if (action === 'memory') {
        postUrl(memoryUrl);
        return;
      }
      wordIndex = wordAt(p);
      var m = $.NSEvent.mouseLocation;
      startX = m.x; startY = m.y;
      moved = false; downTime = Date.now();
      var f = win.frame;
      oX = f.origin.x; oY = f.origin.y;
      dragging = true;
    },
    'mouseDragged:': function (e) {
      if (resizing) {   // 拉伸：保持左上角位置，右下角跟随鼠标；边拉边重渲
        var m = $.NSEvent.mouseLocation;
        var nw = Math.round(rW0 + (m.x - rStartX));
        var nh = Math.round(rH0 + (rStartY - m.y));   // Cocoa y 向上，鼠标下移=变高
        nw = Math.max(MINW, Math.min(MAXS, nw));
        nh = Math.max(MINH, Math.min(MAXS, nh));
        var f = win.frame;
        win.setFrameDisplay($.NSMakeRect(f.origin.x, f.origin.y + f.size.height - nh, nw, nh), true);   // setFrame:display:
        renderAsync(nw, nh);
        return;
      }
      if (!dragging) return;
      var m = $.NSEvent.mouseLocation;
      if (Math.abs(m.x - startX) > 4 || Math.abs(m.y - startY) > 4) moved = true;
      win.setFrameOrigin($.NSMakePoint(oX + (m.x - startX), oY + (m.y - startY)));
    },
    'mouseUp:': function (e) {
      if (resizing) {   // 松手：同步保存尺寸（/pet-size.php 渲染完才响应）→ 立刻加载最终高清图
        resizing = false;
        var f2 = win.frame;
        // 同步 POST：服务端串行渲染完才返回，保证读到的是最终尺寸的完整 PNG
        postUrl(sizeUrl + '?w=' + Math.round(f2.size.width) + '&h=' + Math.round(f2.size.height));
        img = $.NSImage.alloc.initWithContentsOfFile(pngPath);
        grip.setNeedsDisplay(true);
        lastRendered = Math.round(f2.size.width) + 'x' + Math.round(f2.size.height);
        renderToken++;   // 作废任何还在飞的异步重渲，避免旧尺寸覆盖最终图
        return;
      }
      dragging = false;
      if (Date.now() - spawnedAt < 350 || downTime === 0) return;   // 预热期 / 没有真实按下
      // 单击词泡泡＝记住该词；不会再跳到下一组。拖动空白处只移动小词灵。
      // 同步 POST 返回时新 PNG 已写好:立即原地换图(新词顶替旧词不闪),并用响应里
      // 的最新 key 表更新窗口 KEYS,保证下一次点击命中不 stale。
      if (!moved && wordIndex >= 0 && Date.now() - downTime < 400) { applyKeys(postUrl(rememberUrl + wordIndex + '&key=' + encodeURIComponent(KEYS[wordIndex] || ''))); reloadImg(); }
    }
  }});
  // 轮询 PNG 变化：外部重渲（网页换形状 / 定时刷新 / 拉伸重渲）自动重载，不用重启窗口
  var lastMtime = 0;
  try {
    var at0 = $.NSFileManager.defaultManager.attributesOfItemAtPathError(pngPath, $());
    if (at0) { var d0 = at0.objectForKey($.NSFileModificationDate); if (d0) lastMtime = d0.timeIntervalSince1970 || 0; }
  } catch (e) {}
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(0.6, true, function(){
    try {
      var at = $.NSFileManager.defaultManager.attributesOfItemAtPathError(pngPath, $());
      if (!at) return;
      var d = at.objectForKey($.NSFileModificationDate);
      if (!d) return;
      var mt = d.timeIntervalSince1970 || 0;
      if (mt > lastMtime + 0.05) {
        lastMtime = mt;
        img = $.NSImage.alloc.initWithContentsOfFile(pngPath);
        grip.setNeedsDisplay(true);
      }
    } catch (e) {}
  });
  var screen = $.NSScreen.mainScreen.frame;
  var pad = 18;
  var x, y;
  if (savedPos) {
    var p = JSON.parse(savedPos);
    x = p.x; y = p.y;
    x = Math.max(screen.origin.x + 10, Math.min(x, screen.origin.x + screen.size.width - W - 10));
    y = Math.max(screen.origin.y + 10, Math.min(y, screen.origin.y + screen.size.height - H - 10));
  } else {
    x = /left/.test(corner) ? screen.origin.x + pad : screen.origin.x + screen.size.width - W - pad;
    var top = /top/.test(corner) ? pad + 22 : screen.size.height - H - pad - 12;
    y = screen.origin.y + screen.size.height - top - H;  // Cocoa y is from bottom
  }
  var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(x, y, W, H), $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
  win.opaque = false; win.backgroundColor = $.NSColor.clearColor;
  win.level = $.NSFloatingWindowLevel;
  win.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorStationary | $.NSWindowCollectionBehaviorIgnoresCycle;
  win.hasShadow = true;
  var grip = $.DWGrip.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
  grip.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;
  // macOS 26+ 直接使用系统 Liquid Glass；旧系统回退到原生视觉材质。
  // 四套皮肤都复用该承载层，非 Liquid 的高不透明 SVG 会自然遮住材质。暗夜用 style=3 深色材质。
  var GlassClass = $.NSClassFromString('NSGlassEffectView');
  if (GlassClass) {
    var glassHost = GlassClass.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    glassHost.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;
    glassHost.cornerRadius = 22;
    glassHost.style = skinDark ? 3 : 0;   // macOS 26 NSGlassEffectView: 0=clear 3=dark
    glassHost.contentView = grip;
    win.contentView.addSubview(glassHost);
  } else {
    var visualHost = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    visualHost.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;
    visualHost.material = skinDark ? 4 : 12;   // 4=underWindowBackground-dark  12=sidebar(light)
    visualHost.blendingMode = 0;
    visualHost.state = 1;
    visualHost.wantsLayer = true;
    visualHost.layer.cornerRadius = 22;
    visualHost.layer.masksToBounds = true;
    win.contentView.addSubview(visualHost);
    win.contentView.addSubview(grip);
  }
  win.orderFrontRegardless;
  // 每 3 秒存一次当前位置，下次重启小窗留在你放的地方
  function savePos(){
    var f = win.frame;
    var s = JSON.stringify({x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height});
    $.NSString.stringWithString(s).writeToFileAtomicallyEncodingError(posFile, true, $.NSUTF8StringEncoding, $());
  }
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(3, true, function(){ savePos(); });
  // 孤儿自毁心跳:每 2s 问一次「8771 上的伴侣还是派生我的那个吗」。伴侣已死
  // (失联 ~16s)或端口被新伴侣接管(ownerPid 变了)时,本窗口立即退出 —— 否则
  // 更新/重启后旧窗口残留,和新窗口一起抢同一份渲染文件,屏幕上「来回跳」。
  // 自毁判定走**本地计数器**(timer 自身递增,网络回调只清零):实测对死端口
  // sendAsynchronousRequest 的回调可能迟迟不来,靠回调数失联永远凑不满。
  var missTicks = 0;
  var ownerReq = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + PORT + '/pet-owner.json'));
  ownerReq.setTimeoutInterval(3);
  var petSelfDestruct = function(){
    win.orderOut($());
    $.exit(0);
  };
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(2, true, function(){
    missTicks++;
    if (OWNER && OWNER_PPID !== OWNER) petSelfDestruct();
    if (missTicks >= 8) petSelfDestruct();   // ~16s 没有一次成功响应
    $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(ownerReq, $.NSOperationQueue.mainQueue, function(resp, data, err){
      if (data) {
        try {
          var o = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
          if (o && o.ok && o.ownerPid) {
            if (OWNER && String(o.ownerPid) !== OWNER) petSelfDestruct();
            missTicks = 0;
          }
        } catch (e2) {}
      }
    });
  });
  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  $.NSApplication.sharedApplication.run;
}`;
}

let petChild = null;
let petGeneration = 0;
let petVisible = false;   // whether the floating pet window is currently shown
let petWords = [];        // 当前小词灵实际展示的词，供点击命中和记忆事件使用
function stopPet() {
  petGeneration++;
  petVisible = false;
  if (petChild) { try { petChild.kill(); } catch {} petChild = null; }
}

/* ---------------- 派大星漫游窗启动器 ---------------- */
let patrickChild = null;
let patrickGeneration = 0;
let patrickVisible = false;
let patrickCrashCount = 0;
let patrickLastCrashAt = 0;
let patrickQuizState = null;   // {word, options, answerIndex, pickedIndex, lib, key, dueWordRef, askedAt}
let displayedQuiz = null;     // Includes the answer card until it is dismissed.
let quizSequence = 0;
let quizRenderSequence = 0;
function clearQuizCard() {
  if (speakCardState?.quizId) ttsStopNow();
  patrickQuizState = null;
  displayedQuiz = null;
  quizRenderSequence++;       // In-flight sips output may no longer publish.
  try { fs.unlinkSync(CARD_PNG.quiz); } catch {}
}
function stopPatrickPet() {
  ttsStopNow();
  patrickGeneration++;
  patrickVisible = false;
  clearQuizCard();
  pendingQuiz = null;
  if (patrickChild) { try { patrickChild.kill(); } catch {} patrickChild = null; }
  try { fs.unlinkSync(CARD_PNG.quiz); } catch {}
}
function stopPetAll() {
  stopPet();
  stopPatrickPet();
  // 2.4.6 的孤儿回收原则:宠物隐藏/关闭时,它派生的**所有**窗口都要一起收掉,
  // 否则主窗口没了、对话窗与造句窗还浮在桌面上(用户会当成关不掉的幽灵窗)。
  stopChatWindow();
  stopSentenceWindow();
}
function petWordsForPatrick() {
  return petFirstPassWords().map(w => ({
    word: w.word, phonetic: w.phonetic || '', pos: w.pos || '', meaning: w.meaning || '',
    example: (exampleForWord(CFG.library, w) || {}).en || '',
  }));
}
function startPatrickPet() {
  // 崩溃风暴退避:连续崩 ≥3 次后按 1s×2^n 退避(上限 10 分钟),10 分钟无崩溃自动清零。
  if (patrickCrashCount >= 3) {
    const backoff = Math.min(600000, 1000 * Math.pow(2, patrickCrashCount));
    if (Date.now() - patrickLastCrashAt < backoff) {
      console.error('[companion] patrick 连续崩溃 ' + patrickCrashCount + ' 次,退避 ' + Math.round(backoff / 1000) + 's 后再试');
      return;
    }
  }
  stopPetAll();
  const generation = patrickGeneration;
  if (!isMac || !CFG.petEnabled) return;
  if (process.env.WORDPAPER_TEST_MODE === '1') return;   // 测试模式不开真实窗口(端点/逻辑全在)
  if (!fs.existsSync(PATRICK_SHEET)) { console.error('[companion] 缺 assets/patrick/sheet.png,派大星形态不可用;回退卡片'); CFG.petMode = 'card'; saveConfig(); startPet(); return; }
  if (fs.existsSync(PET_CLOSED_PATH)) { console.log('[companion] 小窗已被关闭(点 ✕),重启伴侣后恢复'); return; }
  let saved = state.patrickSize && Number(state.patrickSize.w) ? state.patrickSize : PATRICK_DEFAULT;
  // 老版本默认 118×128 太小,未手动调过尺寸的用户自动升到新默认。
  if (saved && saved.w <= 130 && saved.h <= 140) { saved = PATRICK_DEFAULT; state.patrickSize = saved; saveState(); }
  const W = Math.max(PATRICK_MIN, Math.min(PATRICK_MAX, saved.w));
  const H = Math.max(PATRICK_MIN, Math.min(PATRICK_MAX, saved.h));
  const frameNames = PATRICK_FRAME;
  const exampleLines = petWordsForPatrick().map(w => w.example).filter(Boolean);
  const jxa = buildPatrickJXA({ W, H, words: petWordsForPatrick(), keys: currentPetKeys(), frameNames, roamInterval: CFG.petRoamInterval, dark: petSkin(CFG.uiTheme).dark === true, exampleLines });
  const scriptPath = path.join(os.tmpdir(), `dw_patrick-${process.pid}.jxa.js`);
  try { fs.writeFileSync(scriptPath, jxa); } catch (err) { console.error('[companion] patrick script failed:', err.message); return; }
  const { spawn } = require('child_process');
  patrickVisible = true;
  const child = patrickChild = spawn('osascript', ['-l', 'JavaScript', scriptPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', data => console.error('[companion] patrick window:', String(data).trim()));
  child.on('error', () => { if (patrickChild === child) { patrickChild = null; patrickVisible = false; } });
  child.on('exit', (code) => {
    if (patrickChild !== child) return;
    patrickChild = null; patrickVisible = false;
    if (code && !fs.existsSync(PET_CLOSED_PATH) && generation === patrickGeneration) {
      console.error(`[companion] patrick window exited (${code})`);
      // 崩溃风暴退避:窗口连续异常退出时记录次数,1s×2^n(上限 10 分钟)后才允许重启,
      // 避免「系统唤醒 → NSScreen 还没就绪 → 崩 → 立刻重拉 → 再崩」的循环空转。
      patrickCrashCount++;
      patrickLastCrashAt = Date.now();
    } else {
      patrickCrashCount = 0;   // 正常关闭(用户点 ✕ / 形态切换)不算
    }
  });
  patrickChild.unref();
  renderStatusBubble();
  setInterval(() => { if (patrickVisible) renderStatusBubble(); }, 300000).unref();
  console.log('[companion] 派大星已在桌面散步(悬停=挥手打招呼,点击=跳跃+朗读,拖动=摆放;点 ⭐ 可切回词卡)');
}


/* ── 常驻 AI 对话浮窗(独立 JXA 进程)──────────────────────────
 * 一个像 ChatGPT 侧栏的小窗口:上面是对话记录(NSTextView 只读),
 * 下面输入框 + 发送。双击派大星或菜单栏都能打开/收起。
 * 独立进程:不干扰派大星的 50ms 主循环。 */
/* 读出派大星当前窗口位置(它每 3s 落盘一次);拿不到返回 null。
 * 用来让浮窗「从派大星身上长出来」,而不是从屏幕角落凭空空降。 */
function readPatrickAnchor() {
  try {
    const p = JSON.parse(fs.readFileSync(PATRICK_POS_PATH, 'utf8'));
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      const size = state.patrickSize || PATRICK_DEFAULT;
      return { x: p.x, y: p.y, w: Number(size.w) || PATRICK_DEFAULT.w, h: Number(size.h) || PATRICK_DEFAULT.h };
    }
  } catch {}
  return null;
}

function buildChatWindowJXA() {
  const meta = {
    port: CFG.port, ownerPid: process.pid,
    posFile: path.join(RUNTIME_ROOT, 'chat-position.json'),
    dark: petSkin(CFG.uiTheme).dark === true,
    anchor: readPatrickAnchor(),
  };
  // HTML 由伴侣在本地端口提供(/pet-chat.html),WebView 直接加载 —— 中文输入法正常。
  return `ObjC.import('Cocoa');
ObjC.import('WebKit');
ObjC.import('stdlib');
ObjC.bindFunction('getppid', ['int', []]);
function run(){
  var M = ${JSON.stringify(meta)};
  // getppid 只在启动时取一次:2s 心跳里反复走 bindFunction 的桥是崩溃报告里
  // objectForKeyedSubscript 的高频来源之一。
  var OWNER_PPID = String($.getppid());
  var CW = 520, CH = 600;   // 抽屉默认收起;展开(+186)后主区仍有 334pt,不会把文字挤成竖排
  var screen = $.NSScreen.mainScreen.frame;
  var cx = screen.origin.x + screen.size.width - CW - 30;
  var cy = screen.origin.y + screen.size.height - CH - 80;
  try {
    var savedTxt = $.NSString.stringWithContentsOfFileEncodingError(M.posFile, $.NSUTF8StringEncoding, $());
    var saved = JSON.parse((savedTxt && savedTxt.js) || '{}');
    if (typeof saved.x === 'number') { cx = saved.x; cy = saved.y; }
  } catch (e) {}

  ObjC.registerSubclass({ name: 'DWChatWindow', superclass: 'NSWindow', methods: {
    'canBecomeKeyWindow': function(){ return true; },
    'canBecomeMainWindow': function(){ return true; },
  }});
  var win = $.DWChatWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(cx, cy, CW, CH),
    $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable | $.NSWindowStyleMaskResizable,
    $.NSBackingStoreBuffered, false);
  win.title = '派大星 · 聊聊单词';
  win.level = $.NSFloatingWindowLevel;
  win.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces;
  win.setMinSize($.NSMakeSize(380, 460));
  win.backgroundColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1.0, 0.98, 0.965, 1);

  var conf = $.WKWebViewConfiguration.alloc.init;
  var web = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, CW, CH), conf);
  web.setAutoresizingMask($.NSViewWidthSizable | $.NSViewHeightSizable);
  win.contentView.addSubview(web);
  web.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString('http://127.0.0.1:' + M.port + '/pet-chat.html')));

  /* ── 出场动效:从派大星身旁「弹」出来 ──────────────────────
   * 之前是窗口直接 makeKeyAndOrderFront,先闪一帧完整窗口再什么都不做 → 很生硬。
   * 现在:
   *   - 窗口先 alphaValue=0 上屏(不会闪白)
   *   - 以派大星中心为锚点做 scale(0.86→1.0) + 位移,弹簧曲线(过冲一点点再回落)
   *   - alpha 用更快的 easeOut 提前到 1,避免"半透明发虚"的观感
   * 全程 260ms、60fps 定时器插值(JXA 里没有 CAAnimation 的简单入口)。 */
  var finalX = cx, finalY = cy;
  var A = M.anchor;
  // 起点:朝派大星方向偏 18pt,并缩到 0.86
  var fromX = finalX, fromY = finalY;
  if (A) {
    var pcx = A.x + A.w / 2, pcy = A.y + A.h / 2;
    var wcx = finalX + CW / 2, wcy = finalY + CH / 2;
    var dx = pcx - wcx, dy = pcy - wcy;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    fromX = finalX + (dx / len) * 18;
    fromY = finalY + (dy / len) * 18;
  }
  win.alphaValue = 0.0;
  win.setFrameOrigin($.NSMakePoint(fromX, fromY));
  win.makeKeyAndOrderFront($());
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);

  /* 出场动画改用 NSWindow animator(ObjC 层插值),**不用 16ms NSTimer 手动插值**:
   * JXA 崩溃报告(osascript SIGSEGV ×10)的崩点全在 NSTimer 回调读 $ 桥
   * (objectForKeyedSubscript → objc_retain 野指针),动画帧率越高风险越大。
   * CA 动画在 ObjC 层自走,JS 只发一次指令,彻底绕开这个坑。 */
  function playEntrance() {
    try {
      // NSWindow.animator 的隐式动画:淡入 + 平移都由 AppKit 在 ObjC 层插值,
      // JS 侧一次调用即返回,没有高频 $ 桥访问(崩溃点已消除)。
      win.setFrameOrigin($.NSMakePoint(fromX, fromY));
      win.animator.alphaValue = 1.0;
      win.setFrameDisplay($.NSMakeRect(finalX, finalY, CW, CH), true);
    } catch (e) {
      win.alphaValue = 1.0;
      win.setFrameOrigin($.NSMakePoint(finalX, finalY));
    }
  }
  var entranceStarted = false, waitT0 = Date.now();
  function maybeStartEntrance() {
    if (entranceStarted) return;
    entranceStarted = true;
    playEntrance();
  }
  // didFinishNavigation 在页面真正渲染后触发(JXA 代理回调只触发一次,风险低)
  try {
    if (!$.DWChatNavDelegate) {
      ObjC.registerSubclass({ name: 'DWChatNavDelegate', superclass: 'NSObject', methods: {
        'webView:didFinishNavigation:': function(){ maybeStartEntrance(); },
      }});
    }
    var navDelegate = $.DWChatNavDelegate.alloc.init;
    web.navigationDelegate = navDelegate;
  } catch (e) { /* 拿不到导航回调就靠下面的保底定时器 */ }
  // 保底一次性延时器:0.05s 后必播(本地页面很快,别让用户等)
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(0.05, true, function(tm){
    tm.invalidate;
    maybeStartEntrance();
  });

  var missTicks = 0;
  /* 心跳与位置保存合并成一个 2s 定时器(SIGSEGV 排查:多个定时器在窗口关闭竞态中
   * 重入 $ 桥是崩溃主因);win 不可见时跳过一切 $ 访问。 */
  var posDirty = false;
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(2, true, function(){
    try {
      if (!win.isVisible) return;   // 窗口被关/隐藏:不碰 $ 桥(崩点防御)
      missTicks++;
      if (M.ownerPid && OWNER_PPID !== String(M.ownerPid)) { $.exit(0); }
      if (missTicks >= 8) { $.exit(0); }
      // 位置每 4s 落一次盘(隔次),降低写盘频率
      posDirty = !posDirty;
      if (posDirty) {
        var f = win.frame;
        $.NSString.stringWithString(JSON.stringify({ x: f.origin.x, y: f.origin.y }))
          .writeToFileAtomicallyEncodingError(M.posFile, true, $.NSUTF8StringEncoding, $());
      }
      var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + M.port + '/pet-owner.json'));
      req.setTimeoutInterval(3);
      $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){
        if (data) {
          try {
            var o = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
            if (o && o.ok && o.ownerPid) {
              if (String(o.ownerPid) !== String(M.ownerPid)) { $.exit(0); }
              missTicks = 0;
            }
          } catch (e) {}
        }
      });
    } catch (e) {}
  });

  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  $.NSApplication.sharedApplication.run;
}`;
}

/* ── 造句练习浮窗(WebView,和对话浮窗同一条路线)──────────────
 * 抽查答完后点卡片底部「用它造个句子」→ 开一个小窗:
 *   上半是这个词(词/音标/释义),下半让用户用英文写一句话,
 *   提交后交 DeepSeek 批改(语法/用词/更自然的说法),结果直接显示在窗里。
 * 用 WebView 的理由和对话窗一样:原生 NSTextField 在 launchd 派生的
 * osascript 里拿不到输入法,中文/长英文都打不进去。 */
function buildSentenceWindowJXA() {
  const meta = {
    port: CFG.port, ownerPid: process.pid,
    posFile: path.join(RUNTIME_ROOT, 'sentence-position.json'),
    anchor: readPatrickAnchor(),
  };
  return `ObjC.import('Cocoa');
ObjC.import('WebKit');
ObjC.import('stdlib');
ObjC.bindFunction('getppid', ['int', []]);
function run(){
  var M = ${JSON.stringify(meta)};
  var OWNER_PPID = String($.getppid());   // 启动时取一次(见对话窗注释)
  var SW = 420, SH = 520;
  var screen = $.NSScreen.mainScreen.frame;
  var sx = screen.origin.x + screen.size.width - SW - 30;
  var sy = screen.origin.y + screen.size.height - SH - 140;
  try {
    var savedTxt = $.NSString.stringWithContentsOfFileEncodingError(M.posFile, $.NSUTF8StringEncoding, $());
    var saved = JSON.parse((savedTxt && savedTxt.js) || '{}');
    if (typeof saved.x === 'number') { sx = saved.x; sy = saved.y; }
  } catch (e) {}

  ObjC.registerSubclass({ name: 'DWSentenceWindow', superclass: 'NSWindow', methods: {
    'canBecomeKeyWindow': function(){ return true; },
    'canBecomeMainWindow': function(){ return true; },
  }});
  var win = $.DWSentenceWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(sx, sy, SW, SH),
    $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable | $.NSWindowStyleMaskResizable,
    $.NSBackingStoreBuffered, false);
  win.title = '派大星 · 用它造个句子';
  win.level = $.NSFloatingWindowLevel;
  win.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces;
  win.setMinSize($.NSMakeSize(340, 420));
  win.backgroundColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1.0, 0.98, 0.965, 1);

  var conf = $.WKWebViewConfiguration.alloc.init;
  var web = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, SW, SH), conf);
  web.setAutoresizingMask($.NSViewWidthSizable | $.NSViewHeightSizable);
  win.contentView.addSubview(web);
  web.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString('http://127.0.0.1:' + M.port + '/pet-sentence.html')));

  /* 出场动效:和对话浮窗同一套语言 —— 从派大星身旁弹出,
   * 位移 + easeOutBack 轻微过冲 + alpha 快速拉满。造句窗比对话窗小,
   * 动画略快一点(220ms),两个窗同时出现时节奏协调。 */
  var finalX = sx, finalY = sy;
  var A = M.anchor;
  var fromX = finalX, fromY = finalY;
  if (A) {
    var pcx = A.x + A.w / 2, pcy = A.y + A.h / 2;
    var wcx = finalX + SW / 2, wcy = finalY + SH / 2;
    var dx = pcx - wcx, dy = pcy - wcy;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    fromX = finalX + (dx / len) * 16;
    fromY = finalY + (dy / len) * 16;
  }
  win.alphaValue = 0.0;
  win.setFrameOrigin($.NSMakePoint(fromX, fromY));
  win.makeKeyAndOrderFront($());
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);

  // 与对话窗一致:animator 一次提交淡入(不再用 16ms 定时器逐帧插值 —— JXA 崩溃点就在那里)
  function playEntrance() {
    try {
      win.setFrameOrigin($.NSMakePoint(fromX, fromY));
      win.animator.alphaValue = 1.0;   // NSWindow animator 在 ObjC 层插值
      win.setFrameDisplay($.NSMakeRect(finalX, finalY, SW, SH), true);
    } catch (e) {
      win.alphaValue = 1.0;
      win.setFrameOrigin($.NSMakePoint(finalX, finalY));
    }
  }
  var entranceStarted = false;
  function maybeStartEntrance() {
    if (entranceStarted) return;
    entranceStarted = true;
    playEntrance();
  }
  try {
    if (!$.DWSentenceNavDelegate) {
      ObjC.registerSubclass({ name: 'DWSentenceNavDelegate', superclass: 'NSObject', methods: {
        'webView:didFinishNavigation:': function(){ maybeStartEntrance(); },
      }});
    }
    var navDelegate = $.DWSentenceNavDelegate.alloc.init;
    web.navigationDelegate = navDelegate;
  } catch (e) { /* 同上 */ }
  // 保底一次性延时器:0.05s 后必播(导航回调若先到 entranceStarted 会挡住二次)。
  // 本地页面加载很快,等 0.22s 反而让用户觉得"点了没反应"。
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(0.05, true, function(tm){
    tm.invalidate;
    maybeStartEntrance();
  });

  var missTicks = 0;
  // 与对话窗同款:合并定时器 + isVisible 守卫(SIGSEGV 防御)
  var posDirty2 = false;
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(2, true, function(){
    try {
      if (!win.isVisible) return;
      missTicks++;
      if (M.ownerPid && OWNER_PPID !== String(M.ownerPid)) { $.exit(0); }
      if (missTicks >= 8) { $.exit(0); }
      posDirty2 = !posDirty2;
      if (posDirty2) {
        var f = win.frame;
        $.NSString.stringWithString(JSON.stringify({ x: f.origin.x, y: f.origin.y }))
          .writeToFileAtomicallyEncodingError(M.posFile, true, $.NSUTF8StringEncoding, $());
      }
      var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + M.port + '/pet-owner.json'));
      req.setTimeoutInterval(3);
      $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){
        if (data) {
          try {
            var o = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
            if (o && o.ok && o.ownerPid) {
              if (String(o.ownerPid) !== String(M.ownerPid)) { $.exit(0); }
              missTicks = 0;
            }
          } catch (e) {}
        }
      });
    } catch (e) {}
  });

  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  $.NSApplication.sharedApplication.run;
}`;
}

/* ── 输入法切换(造句时自动用英文)────────────────────────────
 * 造句窗一打开就把输入法切到英文键盘,用户不用自己按 Ctrl+空格;
 * 关窗时**切回原来那个**输入源,不改变用户平时的习惯。
 * 用 TIS(Carbon)API,不依赖 AppleScript 的 System Events(那个还需要额外授权)。
 * JXA 的坑:TISGetInputSourceProperty 返回 CFTypeRef,必须
 * ObjC.castRefToObject() 之后才能 unwrap/TISSelectInputSource。 */
const TIS_JXA = `ObjC.import('Cocoa');
ObjC.import('Carbon');
function run(argv) {
  var want = argv[0] || '';
  var current = ObjC.castRefToObject($.TISGetInputSourceProperty($.TISCopyCurrentKeyboardInputSource(), $.kTISPropertyInputSourceID));
  var curId = current ? ObjC.unwrap(current) : '';
  if (want === '--current') { return curId || ''; }
  if (!want) { return curId || ''; }
  var list = ObjC.castRefToObject($.TISCreateInputSourceList($(), false));
  if (!list) { return curId || ''; }
  for (var i = 0; i < list.count; i++) {
    var src = list.objectAtIndex(i);
    var raw = ObjC.castRefToObject($.TISGetInputSourceProperty(src, $.kTISPropertyInputSourceID));
    var id = raw ? ObjC.unwrap(raw) : '';
    if (id === want) { $.TISSelectInputSource(src); break; }
  }
  return curId || '';
}`;
/* 当前输入源 ID(同步拿不到,包成回调;失败返回 '')。 */
function currentInputSource(cb) {
  if (!isMac) return cb && cb('');
  const tmp = path.join(os.tmpdir(), `dw_tis-${process.pid}.jxa.js`);
  try { fs.writeFileSync(tmp, TIS_JXA); } catch { return cb && cb(''); }
  execFile('osascript', ['-l', 'JavaScript', tmp, '--current'], { timeout: 6000 }, (err, stdout) => {
    try { fs.unlinkSync(tmp); } catch {}
    cb && cb(err ? '' : String(stdout || '').trim());
  });
}
/* 切到指定输入源;返回切换前的那个(供稍后恢复)。 */
function selectInputSource(id, cb) {
  if (!isMac || !id) return cb && cb('');
  const tmp = path.join(os.tmpdir(), `dw_tis-${process.pid}.jxa.js`);
  try { fs.writeFileSync(tmp, TIS_JXA); } catch { return cb && cb(''); }
  execFile('osascript', ['-l', 'JavaScript', tmp, id], { timeout: 6000 }, (err, stdout) => {
    try { fs.unlinkSync(tmp); } catch {}
    cb && cb(err ? '' : String(stdout || '').trim());
  });
}
/* 造句期间用的英文键盘。优先 ABC(纯英文,不会弹候选词)。 */
const EN_INPUT_SOURCE = 'com.apple.keylayout.ABC';
let imeRestoreTo = '';        // 造句前用户的输入源,关窗时切回

let sentenceWinChild = null;
function stopSentenceWindow() {
  const hadWindow = Boolean(sentenceWinChild);
  if (sentenceWinChild) { try { sentenceWinChild.kill(); } catch {} sentenceWinChild = null; }
  // 切回用户原来的输入法(只有造句窗真的开过才恢复,避免无谓地打断输入)
  if (hadWindow && imeRestoreTo) {
    const back = imeRestoreTo;
    imeRestoreTo = '';
    selectInputSource(back);
  }
  // 只有**真的关掉了一个开着的窗**才算"刚关窗",才进缓冲期。
  // 否则切形态 / 隐藏宠物时 stopPetAll 里这次调用会把整个抽查卡住 2.5s。
  if (!hadWindow) return;
  sentenceClosedAt = Date.now();
  setTimeout(() => { flushPendingQuiz(); }, SENTENCE_CLOSE_GRACE_MS + 50).unref?.();
}
function startSentenceWindow() {
  if (!isMac) return { ok: false, error: 'not mac' };
  if (sentenceWinChild) {
    let alive = false;
    try { process.kill(sentenceWinChild.pid, 0); alive = true; } catch {}
    if (alive) return { ok: true, already: true };
    sentenceWinChild = null;
  }
  const scriptPath = path.join(os.tmpdir(), `dw_sentence-${process.pid}.jxa.js`);
  try { fs.writeFileSync(scriptPath, buildSentenceWindowJXA()); }
  catch (err) {
    console.error('[companion] 造句窗脚本生成失败:', err && err.stack || err);
    return { ok: false, error: String(err && err.message || err) };
  }
  const { spawn } = require('child_process');
  const errPath = path.join(os.tmpdir(), `dw_sentence-${process.pid}.err.log`);
  let errFd = 'ignore';
  try { errFd = fs.openSync(errPath, 'a'); } catch {}
  const child = sentenceWinChild = spawn('osascript', ['-l', 'JavaScript', scriptPath], { stdio: ['ignore', 'ignore', errFd] });
  if (typeof errFd === 'number') { try { fs.closeSync(errFd); } catch {} }
  child.on('exit', (code, sig) => {
    if (sentenceWinChild === child) sentenceWinChild = null;
    sentenceClosedAt = Date.now();
    console.error('[companion] 造句窗退出 code=' + code + ' sig=' + sig);
    setTimeout(() => { flushPendingQuiz(); }, SENTENCE_CLOSE_GRACE_MS + 50).unref?.();
  });
  child.unref();
  return { ok: true, script: scriptPath, errLog: errPath };
}

let voicePreviewUntil = 0, voicePreviewId = '';
const voicePreviewClips = new Map();
function serveVoicePreview(req,res,id) {
  const audio=voicePreviewClips.get(id);
  if (!audio || audio.expires<Date.now()) {voicePreviewClips.delete(id);res.writeHead(404);return res.end();}
  let size;try{size=fs.statSync(audio.file).size;}catch{res.writeHead(404);return res.end();}
  let start=0,end=size-1;
  if(req.headers.range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(match && (match[1] || match[2])) {
      start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
      end=match[1] && match[2]?Math.min(size-1,Number(match[2])):size-1;
    }else start=-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=size){
      res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();
    }
  }
  const headers={'Content-Type':audio.fallback?'audio/aiff':'audio/mpeg','Accept-Ranges':'bytes',
    'Content-Length':end-start+1,'Cache-Control':'private, no-store'};
  if(req.headers.range)headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  res.writeHead(req.headers.range?206:200,headers);
  if(req.method==='HEAD')return res.end();
  const stream=fs.createReadStream(audio.file,{start,end});stream.on('error',()=>res.destroy());stream.pipe(res);
}

let chatWinChild = null;
function stopChatWindow() {
  if (chatWinChild) { try { chatWinChild.kill(); } catch {} chatWinChild = null; }
}
function startChatWindow() {
  if (!isMac) return { ok: false, error: 'not mac' };
  // 子进程可能已崩溃但引用还在 → 先探活,死了就清掉重开
  if (chatWinChild) {
    let alive = false;
    try { process.kill(chatWinChild.pid, 0); alive = true; } catch {}
    if (alive) return { ok: true, already: true };
    chatWinChild = null;
  }
  const scriptPath = path.join(os.tmpdir(), `dw_chat-${process.pid}.jxa.js`);
  try { fs.writeFileSync(scriptPath, buildChatWindowJXA()); }
  catch (err) {
    console.error('[companion] 对话浮窗脚本生成失败:', err && err.stack || err);
    return { ok: false, error: String(err && err.message || err) };
  }
  const { spawn } = require('child_process');
  const errPath = path.join(os.tmpdir(), `dw_chat-${process.pid}.err.log`);
  let errFd = 'ignore';
  try { errFd = fs.openSync(errPath, 'a'); } catch {}
  const child = chatWinChild = spawn('osascript', ['-l', 'JavaScript', scriptPath], { stdio: ['ignore', 'ignore', errFd] });
  if (typeof errFd === 'number') { try { fs.closeSync(errFd); } catch {} }
  child.on('exit', (code, sig) => {
    if (chatWinChild === child) chatWinChild = null;
    console.error('[companion] 对话浮窗退出 code=' + code + ' sig=' + sig);
  });
  child.unref();
  return { ok: true, script: scriptPath, errLog: errPath };
}

/* ---------------- global hotkey (zero-dep, via a JXA event monitor) ------- */
/* A dedicated osascript listener stays alive while the companion runs. Global
 * key monitors need the host process to be Accessibility-trusted (System
 * Settings → 隐私与安全性 → 辅助功能 → add osascript / your terminal), else the
 * events never arrive — the pet click still works without it. */
const FLAG_CTRL = 262144, FLAG_OPT = 524288, FLAG_SHIFT = 131072, FLAG_CMD = 1048576;
function buildHotkeyJXA(combos, port) {
  const spec = combos.map(c => ({
    keyCode: c.keyCode,
    wantC: (c.mask & 1) ? 1 : 0, wantO: (c.mask & 2) ? 1 : 0,
    wantS: (c.mask & 4) ? 1 : 0, wantM: (c.mask & 8) ? 1 : 0,
    dir: c.dir, last: 0,
  }));
  return `ObjC.import('AppKit'); ObjC.import('Foundation');
function run(){
  var combos = ${JSON.stringify(spec)};
  var events = 0, fires = 0;
  function fire(dir){
    var urlStr = 'http://127.0.0.1:${port}/' + (dir > 0 ? 'next' : 'prev') + '.php';
    var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString(urlStr));
    req.setHTTPMethod('POST');
    $.NSURLConnection.sendSynchronousRequestReturningResponseError(req, $(), $());
  }
  $.NSEvent.addGlobalMonitorForEventsMatchingMaskHandler($.NSEventMaskKeyDown, function(e){
    events++;
    if (e.isARepeat) return;                 // 长按自动重复只算一次
    var f = e.modifierFlags;
    var gotC = (f & ${FLAG_CTRL}) ? 1 : 0, gotO = (f & ${FLAG_OPT}) ? 1 : 0, gotS = (f & ${FLAG_SHIFT}) ? 1 : 0, gotM = (f & ${FLAG_CMD}) ? 1 : 0;
    for (var i = 0; i < combos.length; i++){
      var c = combos[i];
      if (e.keyCode !== c.keyCode) continue;
      if (gotC !== c.wantC || gotO !== c.wantO || gotS !== c.wantS || gotM !== c.wantM) continue;
      var now = Date.now();
      if (now - c.last < 400) break;         // 快速重按节流
      c.last = now; fires++;
      fire(c.dir);
      break;
    }
  });
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(2, true, function(){
    $.NSString.stringWithString('{"events":' + events + ',"fires":' + fires + ',"t":' + Date.now() + '}').writeToFileAtomicallyEncodingError('/tmp/dw_hotkey_beat.json', true, $.NSUTF8StringEncoding, $());
  });
  while (true) { $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.5)); }
}
`;
}
let hotkeyChild = null;
let hotkeyAlive = false;
function hotkeyStatus() {
  let beat = { events: 0, fires: 0 };
  try { beat = Object.assign(beat, JSON.parse(fs.readFileSync('/tmp/dw_hotkey_beat.json', 'utf8'))); } catch {}
  return { enabled: CFG.hotkeyEnabled !== false, alive: hotkeyAlive, events: beat.events || 0, fires: beat.fires || 0 };
}
function startHotkey() {
  if (!isMac || !CFG.hotkeyEnabled) return;
  if (hotkeyChild) { try { hotkeyChild.kill(); } catch {} hotkeyChild = null; }
  const fwd = parseHotkey(CFG.hotkey || 'ctrl+alt+w');
  if (!fwd) { console.log('[companion] 快捷键配置无法识别，已跳过：' + CFG.hotkey); return; }
  const back = parseHotkey(CFG.hotkeyBack || 'ctrl+alt+shift+w');
  const combos = [{ keyCode: fwd.keyCode, mask: fwd.mask, dir: 1 }];
  if (back) combos.push({ keyCode: back.keyCode, mask: back.mask, dir: -1 });
  const scriptPath = path.join(os.tmpdir(), 'dw_hotkey.jxa.js');
  try { fs.writeFileSync(scriptPath, buildHotkeyJXA(combos, CFG.port)); } catch (err) { console.error('[companion] hotkey script failed:', err.message); return; }
  const { spawn } = require('child_process');
  hotkeyChild = spawn('osascript', ['-l', 'JavaScript', scriptPath], { stdio: 'ignore' });
  hotkeyChild.on('error', () => { hotkeyChild = null; hotkeyAlive = false; });
  hotkeyChild.unref();
  hotkeyAlive = true;
  const label = fwd.label + (back ? ' / ' + back.label : '');
  console.log(`[companion] 全局快捷键已开启：${label}（需在 系统设置→隐私与安全性→输入监控 里给 osascript 才生效，否则热键无响应）`);
}

/* ---------------- menu bar item (zero-dep, via a JXA status item) --------
 * 常驻菜单栏「词」图标 = App 正在运行的可见指示。菜单提供:
 *   召唤/隐藏小词灵 · 换一组词 · 记忆复习本 · 打开控制面板 ·
 *   检查更新/一键更新(独立版) · 退出 WordPaper
 * 点击经 127.0.0.1:PORT/menu.php 回到本进程执行;菜单内容 10s 刷新一次 +
 * 每次命令完成后立即刷新。菜单栏脚本随伴侣进程存活,server 死亡时伴侣
 * follow-server 自杀,图标随 App 一同消失(不再有「看不见的僵尸实例」)。 */
/* 把请求原样转给主服务(同机回环)。仅用于 /api/export/* 这类只读、需登录态的接口。 */
function proxyToMainApi(req, res) {
  let target;
  try { target = new URL(serverBase()); } catch { res.writeHead(502); return res.end(JSON.stringify({ error: '主服务地址无效' })); }
  const headers = {};
  if (req.headers.cookie) headers.Cookie = req.headers.cookie;
  if (req.headers.accept) headers.Accept = req.headers.accept;
  const upstream = http.request({
    hostname: target.hostname, port: target.port || 80, path: req.url, method: req.method, headers, timeout: 20000,
  }, resp => {
    const out = {};
    if (resp.headers['content-type']) out['Content-Type'] = resp.headers['content-type'];
    if (resp.headers['content-disposition']) out['Content-Disposition'] = resp.headers['content-disposition'];
    out['Cache-Control'] = 'no-store';
    res.writeHead(resp.statusCode || 502, out);
    resp.pipe(res);
  });
  upstream.on('error', () => { try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '主服务未运行' })); } catch {} });
  upstream.on('timeout', () => { upstream.destroy(); });
  req.pipe(upstream);
}

function serverBase() {
  // 探测/内部调用一律 127.0.0.1,绝不用 localhost:Node 会先试 ::1,而主服务
  // 只听 127.0.0.1 —— 双栈解析差异曾让 followServer 连续拒连误判「主服务已死」,
  // 伴侣在主服务健康时自杀(小词灵消失、壁纸停更的真实事故)。
  const origin = localWebOrigin(CFG.webOrigin);
  if (origin) return origin.replace('//localhost:', '//127.0.0.1:');
  return `http://127.0.0.1:${new URL(CFG.webOrigin || 'http://localhost:8770').port || 8770}`;
}

function buildMenuBarJXA(port, ownerPid) {
  return `ObjC.import('Cocoa');
ObjC.import('WebKit');
ObjC.import('stdlib');
ObjC.bindFunction('getppid', ['int', []]);
function run(argv){
  var PORT = '${port}';
  var OWNER = '${ownerPid || ''}';
  var OWNER_PPID = String($.getppid());
  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var item = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
  var btn = item.button;
  btn.toolTip = 'WordPaper · 点击打开菜单';
  (function(){
    try {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="7.2" fill="none" stroke="black" stroke-width="1.6"/><rect x="5" y="6.4" width="8" height="1.7" rx="0.85" fill="black"/><rect x="5" y="9.9" width="5.2" height="1.7" rx="0.85" fill="black"/></svg>';
      var data = $.NSString.stringWithString(svg).dataUsingEncodingAllowLossyConversion($.NSUTF8StringEncoding, true);
      var img = $.NSImage.alloc.initWithData(data);
      if (img && !img.isNil()) { img.setSize($.NSMakeSize(16, 16)); img.setTemplate(true); btn.image = img; }
      else btn.title = '词';
    } catch (e) { btn.title = '词'; }
  })();
  var pageURL = 'http://127.0.0.1:' + PORT + '/pet-voices.html';
  var web, popover, lastGoodAt = Date.now(), lastMenuSig = '', pendingStatus = false;
  var allowed = ['pet-open','pet-close','pet-mode','next','workspace-memory','workspace-home','update-check','update-apply','quit'];
  function callPage(method, args){
    web.evaluateJavaScriptCompletionHandler('window.WordPaperMenu && window.WordPaperMenu.' + method + '(' + (args || []).map(function(arg){return JSON.stringify(arg);}).join(',') + ')', function(){});
  }
  function markLocal(req){req.setValueForHTTPHeaderField('1','X-WordPaper-Local');}
  function decode(data){
    try {return JSON.parse($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding).js);}catch(e){return null;}
  }
  function post(cmd){
    var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + PORT + '/menu.php?cmd=' + cmd));
    req.setHTTPMethod('POST');markLocal(req);req.setTimeoutInterval(100);
    $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req,$.NSOperationQueue.mainQueue,function(resp,data,err){
      var result=decode(data) || {ok:false,error:'连接暂不可用，请重试'};
      callPage('complete',[cmd,result]);rebuildMenu(true);
      if (result.ok && (cmd==='workspace-memory' || cmd==='workspace-home')) popover.performClose($());
    });
  }
  function showMenu(){
    rebuildMenu(true);callPage('open');
    popover.showRelativeToRectOfViewPreferredEdge(btn.bounds,btn,$.NSMinYEdge);
    $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
    web.window.makeKeyWindow;
  }
  ObjC.registerSubclass({name:'DWMenuBarTarget',superclass:'NSObject',methods:{
    'toggle:':{types:['void',['id']],implementation:function(){
      if(popover.shown)popover.performClose($());else showMenu();
    }},
    'popoverDidClose:':{types:['void',['id']],implementation:function(){callPage('close');}},
    'userContentController:didReceiveScriptMessage:':{types:['void',['id','id']],implementation:function(controller,message){
      // Only this local main frame can invoke the native command allowlist.
      if(!message.frameInfo.isMainFrame || String(web.URL.absoluteString.js)!==pageURL)return;
      var payload=ObjC.deepUnwrap(message.body);
      if(!payload || typeof payload!=='object')return;
      if(payload.type==='ready'){rebuildMenu(true);return;}
      if(payload.type==='close'){popover.performClose($());return;}
      if(payload.type==='resize'){
        var height=Number(payload.height);
        if(!isFinite(height))return;
        var screen=btn.window.screen.visibleFrame;
        popover.setContentSize($.NSMakeSize(304,Math.max(240,Math.min(Math.ceil(height),screen.size.height-30,620))));
        return;
      }
      if(payload.type==='command' && allowed.indexOf(payload.cmd)>=0){
        if(payload.cmd==='quit'){
          popover.performClose($());
          $.NSStatusBar.systemStatusBar.removeStatusItem(item);
        }
        post(payload.cmd);
      }
    }}
  }});
  var target=$.DWMenuBarTarget.alloc.init;
  var conf=$.WKWebViewConfiguration.alloc.init;
  conf.mediaTypesRequiringUserActionForPlayback=0;
  conf.userContentController.addScriptMessageHandlerName(target,'wordpaperMenu');
  web=$.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0,0,304,430),conf);
  web.setAutoresizingMask($.NSViewWidthSizable | $.NSViewHeightSizable);
  var viewController=$.NSViewController.alloc.init;
  viewController.view=web;
  popover=$.NSPopover.alloc.init;
  popover.contentViewController=viewController;
  popover.contentSize=$.NSMakeSize(304,430);
  popover.behavior=$.NSPopoverBehaviorTransient;
  popover.animates=false;popover.delegate=target;
  btn.target=target;btn.action='toggle:';
  web.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString(pageURL)));
  function rebuildMenu(force){
    if(pendingStatus)return;pendingStatus=true;
    var req=$.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + PORT + '/menu-status.json'));
    markLocal(req);req.setTimeoutInterval(4);
    $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req,$.NSOperationQueue.mainQueue,function(resp,data,err){
      pendingStatus=false;var st=decode(data);
      if(OWNER && st && st.ownerPid && String(st.ownerPid)!==OWNER){selfDestruct();return;}
      // An HTTP error or bridged nil NSData must not renew the owner heartbeat.
      if(!st || !st.ok || !st.ownerPid)return;
      lastGoodAt=Date.now();
      var sig=JSON.stringify(st);
      if(!force && sig===lastMenuSig)return;
      lastMenuSig=sig;
      popover.appearance=$.NSAppearance.appearanceNamed(st.dark?$.NSAppearanceNameDarkAqua:$.NSAppearanceNameAqua);
      callPage('status',[st]);
    });
  }
  function selfDestruct(){
    try{popover.performClose($());$.NSStatusBar.systemStatusBar.removeStatusItem(item);}catch(e){}
    $.exit(0);
  }
  rebuildMenu(true);
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(3,true,function(){rebuildMenu(false);});
  // Keep the orphan cleanup independent of WebKit and HTTP callbacks. No writes
  // to a potentially dead parent's stderr pipe (startMenuBar uses stdio ignore).
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(5,true,function(){
    if((OWNER && OWNER_PPID!==OWNER) || Date.now()-lastGoodAt>15000)selfDestruct();
  });
  // AppKit's event loop is required for popover input and WebKit audio/rAF.
  $.NSApplication.sharedApplication.run;
}
`;
}

let menuBarChild = null;
function stopMenuBar() {
  if (menuBarChild) {
    try { menuBarChild.kill(); } catch {}
    menuBarChild = null;
  }
  try { fs.unlinkSync(path.join(os.tmpdir(), `dw_menubar-${process.pid}.jxa.js`)); } catch {}
}
function startMenuBar() {
  if (!isMac || menuBarChild) return;
  // 每个伴侣写自己的脚本副本(PID 烙进去),不共用 /tmp 同名文件 —— 共享文件
  // 会让旧实例的菜单栏读到新 PORT,对着新实例显示幽灵图标(双图标 bug)。
  const scriptPath = path.join(os.tmpdir(), `dw_menubar-${process.pid}.jxa.js`);
  try { fs.writeFileSync(scriptPath, buildMenuBarJXA(CFG.port, process.pid)); } catch (err) { console.error('[companion] menubar script failed:', err.message); return; }
  const { spawn } = require('child_process');
  // stderr 丢弃('ignore')而非 pipe:父进程死后没人读管道,子进程写满 64KB
  // 缓冲会整体冻结(定时器停摆,失联自毁永远跑不到 → 幽灵图标)。
  // stdio 'ignore' 时 child.stderr 为 null —— 不能再 .on('data')(真实崩溃:
  // TypeError 阻断伴侣启动,小词灵直接消失)。
  const child = menuBarChild = spawn('osascript', ['-l', 'JavaScript', scriptPath], { stdio: ['ignore', 'ignore', 'ignore'] });
  const clear = () => { if (menuBarChild === child) menuBarChild = null; };
  child.on('error', clear);
  child.on('exit', clear);
  menuBarChild.unref();
  console.log('[companion] 菜单栏图标已显示:小词灵/换一组/记忆本/检查更新/退出 都在这里');
}

/* 菜单栏命令与状态(仅本机回环,见 /menu.php) */
let updateState = { current: BUNDLED_VERSION, applying: false, target: '', error: '', checked: false, available: false, latest: '', checkedAt: 0 };
function menuStatusPayload() {
  return {
    ok: true,
    ownerPid: process.pid,   // 菜单栏 JXA 靠它校验归属:对不上号 = 我是幽灵,自毁
    pet: petVisible || patrickVisible,
    petMode: CFG.petMode || 'card',
    appMode: APP_MODE,
    version: BUNDLED_VERSION,
    dark: petSkin(CFG.uiTheme).dark === true,
    selectedVoice: selectedVoice().id,
    web: localWebOrigin(CFG.webOrigin) || `http://localhost:${serverWebPort()}`,
    update: updateState,
  };
}
function serverWebPort() {
  try { return Number(new URL(CFG.webOrigin).port) || 8770; } catch { return 8770; }
}
/* Shared server state keeps menu updates in sync with browser installs. */
function fetchServerJson(endpoint, cb, timeout = 15000) {
  let settled = false;
  const done = (error, value) => { if (!settled) { settled = true; cb(error, value); } };
  const req = http.get(`${serverBase()}${endpoint}`, {
    timeout, headers: { 'X-WordPaper-Local': '1' },
  }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('error', done);
    res.on('end', () => {
      if (res.statusCode !== 200) return done(new Error('主服务返回 ' + res.statusCode));
      let data;
      try { data = JSON.parse(body); } catch (e) { return done(e); }
      done(null, data);
    });
  });
  req.on('error', done);
  req.on('timeout', () => req.destroy(new Error('超时')));
}
// Release discovery may fall back from a rate-limited API to official asset
// checks. Do not time out the local menu request before that bounded work ends.
function fetchServerUpdate(cb) { fetchServerJson('/api/update/check?refresh=1', cb, 90000); }
let menuUpdatePending = false;
let menuStatusPending = false;
function syncMenuUpdate() {
  if (!APP_MODE || menuStatusPending || menuUpdatePending) return;
  menuStatusPending = true;
  fetchServerJson('/api/update/status-local', (err, info) => {
    menuStatusPending = false;
    if (!err && !menuUpdatePending) Object.assign(updateState, info);
  });
}
function handleMenuCommand(cmd, res) {
  const jsonOut = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  switch (cmd) {
    case 'workspace-home':
    case 'workspace-memory':
      return openWorkspace(cmd === 'workspace-memory' ? '/?openMemory=1' : '/', (error, opened) => {
        if (error) console.error('[companion] workspace navigation failed:', error.message);
        jsonOut(error ? { ok: false, error: '无法打开 WordPaper，请重新启动 App' } : { ok: true, opened }, error ? 500 : 200);
      });
    case 'pet-open':
      try { fs.unlinkSync(PET_CLOSED_PATH); } catch {}
      startPet();
      return jsonOut({ ok: true, pet: petVisible });
    case 'pet-close':
      try { fs.writeFileSync(PET_CLOSED_PATH, '1'); } catch {}
      stopPetAll();
      return jsonOut({ ok: true, pet: false });
    case 'pet-mode':   // 菜单栏:两种形态互切
      setPetMode(CFG.petMode === 'patrick' ? 'card' : 'patrick');
      return jsonOut({ ok: true, mode: CFG.petMode });
    case 'next': {
      const now = Date.now();
      if (now - lastAdvanceAt >= 500) { lastAdvanceAt = now; bumpDelta(1); if (advancing) pendingDir = 1; else runAdvance(1); }
      return jsonOut({ ok: true });
    }
    case 'update-check': {
      if (!APP_MODE || !BUNDLED_VERSION) return jsonOut({ ok: false, error: '开发模式不支持检查更新' });
      fetchServerUpdate((err, info) => {
        if (err) { updateState.error = '无法连接主服务'; }
        else {
          updateState.error = '';
          updateState.available = info.available; updateState.latest = info.latest;
          updateState.current = info.current || BUNDLED_VERSION; updateState.checked = !!info.checked; updateState.checkedAt = Date.now();
          if (!info.checked) updateState.error = '暂时无法检查更新，请稍后重试';
        }
      });
      return jsonOut({ ok: true, checking: true });
    }
    case 'update-apply': {
      if (!APP_MODE || !BUNDLED_VERSION) return jsonOut({ ok: false, error: '开发模式不支持内置更新' });
      if (updateState.applying || menuUpdatePending) return jsonOut({ ok: true, applying: true });
      menuUpdatePending = true;
      fetchServerUpdate((err, info) => {
        if (err || !info.available) {
          menuUpdatePending = false;
          updateState.error = err ? '无法连接主服务' : '没有可用的新版本';
          return;
        }
        updateState.applying = true; updateState.error = ''; updateState.target = info.latest;
        const req = http.request(`${serverBase()}/api/update/apply-local`, { method: 'POST', timeout: 15000, headers: { 'X-WordPaper-Local': '1' } }, resp => {
          resp.resume();
          resp.on('end', () => {
            menuUpdatePending = false;
            if (resp.statusCode !== 200) { updateState.applying = false; updateState.error = '主服务拒绝更新(' + resp.statusCode + ')'; }
            syncMenuUpdate();
          });
        });
        req.on('error', () => { menuUpdatePending = false; updateState.applying = false; updateState.error = '更新请求失败'; });
        req.on('timeout', () => req.destroy(new Error('更新请求超时')));
        req.end();
      });
      return jsonOut({ ok: true, applying: true });
    }
    case 'quit': {
      console.log('[companion] 收到菜单栏退出命令:请求主服务一同退出');
      const req = http.request(`${serverBase()}/api/quit`, { method: 'POST', timeout: 8000, headers: { 'X-WordPaper-Local': '1' } }, resp => resp.resume());
      req.on('error', () => {});
      req.end();
      // server 会自行 shutdown;无论如何本进程稍后自杀,避免孤儿图标
      setTimeout(stopCompanion, 1500).unref();
      return jsonOut({ ok: true, quitting: true });
    }
    default:
      res.writeHead(400); return res.end();
  }
}

/* follow-server:主服务一旦死亡,伴侣在 3 个探测周期内跟随退出 —— 服务链
 * 的生命周期由 server 决定(launcher wait server)。这也是应用内更新重启链
 * 得以在**旧 launcher**上成立的关键:更新后 server 退出 → 伴侣退出 → 旧
 * launcher 的 wait 返回 → 看到重启旗标 → 重入拉起新版本。
 * 的生命周期由 server 决定(launcher wait server)。这也是应用内更新重启链
 * 得以在**旧 launcher**上成立的关键:更新后 server 退出 → 伴侣退出 → 旧
 * launcher 的 wait 返回 → 看到重启旗标 → 重入拉起新版本。
 * 闸门:独立版(APP_MODE)恒开;开发目录手动跑伴侣不开(防误杀)。 */
let serverMissCount = 0;
function followServer() {
  if (!APP_MODE && process.env.WORDPAPER_FOLLOW_SERVER !== '1') return;
  const req = http.get(`${serverBase()}/healthz`, { timeout: 4000 }, res => {
    res.resume();
    serverMissCount = 0;
  });
  req.on('error', () => {
    serverMissCount++;
    if (serverMissCount >= 3) {
      console.log('[companion] 主服务已退出,伴侣跟随退出(服务链由 launcher 接管)');
      stopCompanion();
    }
  });
  req.on('timeout', () => req.destroy(new Error('healthz 超时')));
}

function stopCompanion() {
  stopPetAll();
  if (autoQuizTimer) { clearInterval(autoQuizTimer); autoQuizTimer = null; }
  stopMenuBar();
  if (hotkeyChild) { try { hotkeyChild.kill(); } catch {} }
  process.exit(0);
}

/* Render the pet card PNG at a given size (shared by spawn + live resize +
 * shape change). sips is fast (~50ms), so it can run during a resize drag.
 * Serialized: concurrent POSTs during a fast drag would otherwise race on the
 * same /tmp/dw_pet.png and leave a half-written (blank / partial) image. */
let petRenderBusy = false;
let petRenderPending = null;   // {W,H,cbs:[]} — only the latest size is kept
let lastPetSig = '';
function petContentSig(words, w, h) {
  const keys = (words || []).map(petWordKey).join('\n');
  const rems = (CFG.reminders || []).map(r => (r && r.text) + '\t' + (r && r.time)).join('\n');
  return w + 'x' + h + '|' + (CFG.uiTheme || '') + '|' + keys + '|' + rems;
}
function renderPetPng(W, H, cb) {
  if (petRenderBusy) {
    if (!petRenderPending) petRenderPending = { W, H, cbs: [] };
    else { petRenderPending.W = W; petRenderPending.H = H; }
    if (cb) petRenderPending.cbs.push(cb);
    return;
  }
  petRenderBusy = true;
  const doOne = (w, h, cbs) => {
    const picked = petFirstPassWords();
    petWords = picked;
    const pngPath = path.join(os.tmpdir(), `dw_pet-${process.pid}.png`);
    const sig = petContentSig(picked, w, h);
    const done = (err) => {
      if (!err) lastPetSig = sig;
      for (const c of cbs) { try { c(err); } catch {} }
      if (petRenderPending) {
        const p = petRenderPending; petRenderPending = null;
        doOne(p.W, p.H, p.cbs);
      } else {
        petRenderBusy = false;
      }
    };
    // Same words and size already on disk: skip sips. Resize and word clicks
    // change the signature, so they still rasterize.
    if (sig === lastPetSig && fs.existsSync(pngPath)) return done(null);
    const svg = buildPetSVG(picked, CFG.reminders || [], CFG.uiTheme, w, h);
    rasterizeSVG(svg, pngPath, w * 2, h * 2, done);
  };
  doOne(W, H, cb ? [cb] : []);
}

function resolvePetSize() {
  const saved = state.petSize;
  const defH = Math.min(MAX_PET, 90 + petSlotCount() * 46 + (CFG.reminders && CFG.reminders.length ? 90 : 0) + PET_FOOTER_H);
  const oversized = saved && (saved.w > MAX_PET || saved.h > MAX_PET);
  const w = oversized ? 360 : ((saved && saved.w) ? Math.max(MIN_PET_W, Math.min(MAX_PET, saved.w)) : 320);
  const h = oversized ? Math.min(MAX_PET, defH) : ((saved && saved.h) ? Math.max(MIN_PET_H, Math.min(MAX_PET, saved.h)) : defH);
  if (oversized) { state.petSize = { w, h }; saveState(); }
  return { w, h };
}

/* 形态切换:card ⇄ patrick。config 持久化(CFG.petMode);重启伴侣保持上次形态。 */
function setPetMode(mode, cb) {
  if (!PET_MODES.has(mode)) return cb && cb(new Error('bad mode'));
  const changed = CFG.petMode !== mode;
  CFG.petMode = mode;
  saveConfig();
  if (!changed) return cb && cb(null, false);
  if (mode === 'patrick') startPatrickPet(); else startPet();
  console.log('[companion] 小词灵形态已切换 → ' + (mode === 'patrick' ? '派大星' : '词卡'));
  cb && cb(null, true);
}

/* 伴侣 → 派大星窗命令队列(单向;窗口 0.8s 轮询 /pet-patrick.json)。 */
let patrickCmdSeq = 0;
const patrickCmds = [];
function pushPatrickCmd(cmd) {
  patrickCmdSeq++;
  patrickCmds.push(Object.assign({ seq: patrickCmdSeq }, cmd));
  if (patrickCmds.length > 20) patrickCmds.splice(0, patrickCmds.length - 20);
}
/* 朗读气泡与题卡共存。会话 id 贯穿渲染、上屏确认、音频回调和收起,
 * 连点重播/换题时,旧的 sips、TTS 或完成回调都不能影响新气泡。 */
let speakCardState = null;
let speakSequence = 0;
function finishSpeakCard(reason = 'done') {
  const speech = speakCardState;
  if (!speech) return;
  speakCardState = null;
  clearTimeout(speech.timer);
  const resumeQuizMs = speech.resultHeld && displayedQuiz?.id === speech.quizId && !displayedQuiz.hold ? QUIZ_RESULT_DWELL_MS : 0;
  if (resumeQuizMs) scheduleQuizResultDismiss(displayedQuiz, resumeQuizMs);
  pushPatrickCmd({ cmd: 'speak-end', id: speech.id, reason, resumeQuizMs });
  try { fs.unlinkSync(CARD_PNG.speak); } catch {}
}
function patrickSpeakWord(index, quizId) {
  const q = patrickQuizState || displayedQuiz;
  if (quizId && (!q || q.id !== quizId)) return { ok: false, error: 'stale-quiz' };
  if (!featureOn('betaPatrickVoice')) return { ok: false, error: 'voice-disabled' };
  const words = q ? [] : petFirstPassWords();
  const word = q ? q.word : words[Math.max(0, Math.min(index || 0, words.length - 1))];
  if (!word) return { ok: false, error: 'no-word' };
  const example = exampleForWord(q ? q.library : CFG.library, word);
  ttsStopNow();
  const speech = speakCardState = {
    id: `${process.pid}-speech-${++speakSequence}`, word, example,
    voiceId: selectedVoice().id, part: -1, audioIssued: false,
    quizId: q ? q.id : null, ready: false, started: false,
    resultHeld: !!q && q.pickedIndex >= 0 && !q.hold,
  };
  if (speech.resultHeld) quizResultUntil = Date.now() + 120000;
  // 只作进程失联/异常的兜底;正常收起完全由 afplay 的完成回调驱动。
  speech.timer = setTimeout(() => { if (speakCardState === speech) ttsStopNow('error'); }, 120000);
  speech.timer.unref?.();
  renderSpeakCard(speech);
  speechAudio.prepare(word.word,speech.voiceId,()=>{});
  if (example?.en) speechAudio.prepare(example.en,speech.voiceId,()=>{});
  return { ok: true, id: speech.id, word: word.word, hasExample: !!example?.en };
}
function startSpeakCardAudio(id) {
  const speech = speakCardState;
  if (!speech || speech.id !== id || !speech.ready || speech.started) return false;
  if (speech.quizId && displayedQuiz?.id !== speech.quizId) { ttsStopNow(); return false; }
  speech.started = true;
  prepareSpeakPart(speech,0);
  return true;
}
function prepareSpeakPart(speech,part) {
  speech.part = part; speech.audioIssued = false;
  const text = part ? speech.example.en : speech.word.word;
  speechAudio.prepare(text,speech.voiceId,(err,audio)=>{
    if (speakCardState !== speech || speech.part !== part) return;
    if (err) { ttsStopNow('error'); return; }
    speech.audioIssued = true;
    pushPatrickCmd({cmd:'speak-audio',id:speech.id,part,phase:part?'example':'word',
      file:audio.file,cues:audio.cues,fallback:audio.fallback});
  });
}
function completeSpeakPart(id,part,error) {
  const speech = speakCardState;
  if (!speech || speech.id !== id || speech.part !== part || !speech.audioIssued) return false;
  speech.audioIssued = false;
  if (error) ttsStopNow('error');
  else if (part === 0 && speech.example?.en) prepareSpeakPart(speech,1);
  else finishSpeakCard();
  return true;
}
let answerCardState = null;
function renderAnswerCard() {
  if (!answerCardState) return;
  const svg = buildAnswerSVG(answerCardState.word, answerCardState.answer, petSkin(CFG.uiTheme).dark === true);
  const svgPath = CARD_PNG.answer.replace(/\.png$/, '.svg');
  const pngPath = CARD_PNG.answer;
  try { fs.writeFileSync(svgPath, svg); } catch { return; }
  execFile('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath], { timeout: 20000 }, (err) => {
    try { fs.unlinkSync(svgPath); } catch {}
    if (err) console.error('[companion] 回答卡渲染失败:', err.message);
  });
}
function renderSpeakCard(speech) {
  const out = buildSpeakSVG(speech.word, speech.example, petSkin(CFG.uiTheme).dark === true, true);
  const pngPath = CARD_PNG.speak.replace(/\.png$/, `-${speakSequence}.png`);
  const svgPath = pngPath.replace(/\.png$/, '.svg');
  try { fs.writeFileSync(svgPath, out.svg); } catch { finishSpeakCard('error'); return; }
  execFile('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath], { timeout: 20000 }, (err) => {
    try { fs.unlinkSync(svgPath); } catch {}
    if (err || speakCardState !== speech) {
      try { fs.unlinkSync(pngPath); } catch {}
      if (err && speakCardState === speech) finishSpeakCard('error');
      return;
    }
    try {
      fs.renameSync(pngPath, CARD_PNG.speak);
      speech.ready = true;
      pushPatrickCmd({ cmd: 'speak-card', id: speech.id, quizId: speech.quizId, holdResult: speech.resultHeld, ...out.geom });
    } catch { finishSpeakCard('error'); }
  });
}



/* ── 本地 magpie(Windows WorkBuddy,经 Tailscale)的 DeepSeek-V4.1-Flash ──
 * 用来回答用户对单词的追问。密钥**不进仓库**:读运行时配置
 *   ~/Library/Application Support/WordPaper/companion/magpie.json
 * 也可用环境变量覆盖。不可达时静默降级(只朗读,不解释)。 */
let magpieConfig = null;
let magpieChatModel = '';   // 最近一次成功的模型(限流时自动换到的那个)
function loadMagpie() {
  if (magpieConfig) return magpieConfig;
  const cfgPath = path.join(RUNTIME_ROOT, 'magpie.json');
  let cfg = { enabled: false, models: [] };
  try {
    if (fs.existsSync(cfgPath)) {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const primary = String(raw.model || 'workbuddy-ai/deepseek-v4.1-flash');
      // magpie 同一网关下挂了几个模型别名:主模型限流(429)时换一个继续,别直接失败。
      const extra = Array.isArray(raw.fallbackModels) ? raw.fallbackModels.map(String) : [];
      cfg = {
        enabled: raw.enabled !== false && Boolean(raw.apiKey),
        baseUrl: String(raw.baseUrl || ''),
        apiKey: String(raw.apiKey || ''),
        model: primary,
        models: [primary, ...extra].filter((m, i, a) => m && a.indexOf(m) === i),
      };
    }
  } catch (e) { console.error('[companion] magpie 配置读取失败:', e.message); }
  if (process.env.WORDPAPER_MAGPIE === '0') cfg.enabled = false;
  magpieConfig = cfg;
  return cfg;
}
/* 把上游错误体翻译成一句人话(浮窗直接显示给用户)。
 * 实测最常见的两个:429 频率限制、401 key 失效。 */
function magpieErrorText(status, raw) {
  let msg = '';
  try { msg = String((JSON.parse(raw).error || {}).message || ''); } catch {}
  if (!msg) msg = String(raw || '').slice(0, 160);
  if (status === 429 || /frequency limit|rate_limit/i.test(msg)) {
    // 上游会带 "reset at 2026-10-26 08:05:06 UTC+8",取出来告诉用户什么时候恢复
    const m = msg.match(/reset at ([^,\"]+)/i);
    return '模型被限流了' + (m ? '，' + m[1].trim() + ' 后恢复' : '') + '（已自动换备用模型）';
  }
  if (status === 401 || status === 403) return 'magpie 的 API Key 不被接受（401/403），检查 magpie.json';
  return 'magpie 返回 ' + status + (msg ? '：' + msg.slice(0, 120) : '');
}
/* 提问建议:针对当前在背的词,给几个「一问就学到东西」的角度。
 * 固定模板 × 当前词,离线生成(不耗 API);点击即填入输入框。
 * 用户要的是「不知道怎么问」时的引导,所以每条都带具体角度而不是泛泛的「什么意思」。 */
function chatSuggestions() {
  const words = petFirstPassWords().slice(0, 6);
  const first = words[0] && words[0].word ? words[0].word : '';
  if (!first) return [];
  const out = [];
  const add = (label, q) => { if (!out.some(o => o.q === q)) out.push({ label, q }); };
  add('怎么记住它', `"${first}" 有什么好记的记忆法？拆词根或者联想都行`);
  add('常见搭配', `"${first}" 最常用的搭配有哪些？给两三个例子`);
  add('区别', `"${first}" 和意思相近的词有什么区别？容易在哪儿用错`);
  add('造个句子', `用 "${first}" 造三个不同场景的英文句子，附中文`);
  if (words[1]) add('串起来造句', `用 "${first}" 和 "${words[1].word}" 一起造一句英文`);
  if (words[2]) add('一起记', `"${first}"、"${words[1] ? words[1].word + '”、' : ''}"${words[2].word}" 这三个词怎么一起记？`);
  return out;
}

/* ── 对话管理(多会话)──────────────────────────────────────
 * 结构:state.chatSessions = [{ id, title, createdAt, updatedAt, messages:[{role,content,at}] }]
 *  - 按日期分组由前端做(用 updatedAt),服务端只保证顺序与上限。
 *  - 老数据(state.chatHistory 单条数组)在读取时自动迁移成第一个会话,不丢历史。
 *  - 上限:每个会话 200 条,总共 100 个会话(超出丢最旧的)。
 *  - state.chatSessionId 记住「上次在聊的那个」,重开浮窗接着聊。 */
const CHAT_MAX_MESSAGES = 200;
const CHAT_MAX_SESSIONS = 100;
function chatSessions() {
  if (!Array.isArray(state.chatSessions)) {
    const legacy = Array.isArray(state.chatHistory) ? state.chatHistory : [];
    state.chatSessions = legacy.length ? [{
      id: 's' + Date.now().toString(36),
      title: chatTitleFrom(legacy),
      createdAt: Number(legacy[0] && legacy[0].at) || Date.now(),
      updatedAt: Number(legacy[legacy.length - 1] && legacy[legacy.length - 1].at) || Date.now(),
      messages: legacy.map(m => ({ role: m.role, content: m.content, at: Number(m.at) || Date.now() })),
    }] : [];
    if (state.chatSessions.length && !state.chatSessionId) state.chatSessionId = state.chatSessions[0].id;
    delete state.chatHistory;      // 迁移完就删掉旧字段,避免两份数据打架
    saveState();
  }
  return state.chatSessions;
}
/* 用第一条用户消息给会话起个默认名字(和大多数聊天软件一致)。 */
function chatTitleFrom(messages) {
  const first = (messages || []).find(m => m && m.role === 'user' && m.content);
  if (!first) return '新对话';
  const t = String(first.content).replace(/\s+/g, ' ').trim();
  return t.length > 24 ? t.slice(0, 23) + '…' : (t || '新对话');
}
function activeChatSession(create) {
  const list = chatSessions();
  let s = list.find(x => x.id === state.chatSessionId);
  if (!s && create) {
    s = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    list.push(s);
    state.chatSessionId = s.id;
    trimChatSessions();
    saveState();
  }
  return s || null;
}
function trimChatSessions() {
  const list = chatSessions();
  list.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  if (list.length > CHAT_MAX_SESSIONS) list.length = CHAT_MAX_SESSIONS;
  state.chatSessions = list;
}
function chatSessionSummary(s) {
  const msgs = Array.isArray(s.messages) ? s.messages : [];
  return {
    id: s.id,
    title: s.title || chatTitleFrom(msgs),
    createdAt: Number(s.createdAt) || 0,
    updatedAt: Number(s.updatedAt) || 0,
    count: msgs.length,
    preview: (msgs.filter(m => m.role === 'user').pop() || {}).content || '',
  };
}
/* 会话导出:Markdown(好读、好贴)或 JSON(完整、可再导入)。 */
function chatExportMarkdown(sessions) {
  const lines = [];
  sessions.forEach(s => {
    const when = new Date(Number(s.updatedAt) || Date.now());
    lines.push(`# ${s.title || '新对话'}`);
    lines.push('');
    lines.push(`> ${when.toLocaleString('zh-CN')} · ${(s.messages || []).length} 条消息`);
    lines.push('');
    (s.messages || []).forEach(m => {
      lines.push(`**${m.role === 'user' ? '我' : '派大星'}**：`);
      lines.push('');
      lines.push(String(m.content || ''));
      lines.push('');
    });
    lines.push('---');
    lines.push('');
  });
  return lines.join('\n');
}

/* 多轮对话(带历史)。历史存在 state.chatHistory,最多保留 40 条。
 * 系统提示里带上当前单词,让它知道用户在背什么。 */
function chatWithMagpie(userMessage, cb) {
  const cfg = loadMagpie();
  if (!cfg.enabled || !cfg.baseUrl) return cb && cb('', 'not-configured');
  const sess = activeChatSession(true);
  if (!sess) return cb && cb('', 'no-session');
  if (!Array.isArray(sess.messages)) sess.messages = [];
  const words = petFirstPassWords();
  const cur = words[0] || {};
  const sys = [
    '你是派大星,一个陪用户背单词的桌面宠物,说话轻松口语化,中文回答,通常不超过三句话。',
    cur.word ? '用户当前在背的词是「' + cur.word + '」(' + (cur.meaning || '') + ')。' : '',
    '如果用户问单词,解释要简短好记;可以给记忆法或常见搭配。',
  ].filter(Boolean).join('');

  sess.messages.push({ role: 'user', content: String(userMessage), at: Date.now() });
  if (sess.messages.length > CHAT_MAX_MESSAGES) sess.messages = sess.messages.slice(-CHAT_MAX_MESSAGES);
  // 第一条用户消息自动成为会话标题(用户没手动改过才改)
  if (!sess.title || sess.title === '新对话') sess.title = chatTitleFrom(sess.messages);
  sess.updatedAt = Date.now();
  saveState();

  let url;
  try { url = new URL(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'); } catch { return cb && cb('', 'bad-url'); }
  const messages = [{ role: 'system', content: sys }].concat(
    sess.messages.slice(-12).map(m => ({ role: m.role, content: m.content }))
  );
  // 依次尝试主模型与备用模型:429(限流)换下一个,其它错误直接报给用户。
  const queue = cfg.models && cfg.models.length ? cfg.models.slice() : [cfg.model];
  const attempt = (model, lastErr) => {
    if (!model) return cb && cb('', lastErr || 'no-model');
    const body = JSON.stringify({ model, messages, max_tokens: 400 });
    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 25000,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const reason = magpieErrorText(res.statusCode, data);
          console.error('[companion] magpie', model, res.statusCode, data.slice(0, 200));
          if ((res.statusCode === 429 || res.statusCode === 503) && queue.length) return attempt(queue.shift(), reason);
          return cb && cb('', reason);
        }
        try {
          const j = JSON.parse(data);
          const text = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
          if (text) {
            magpieChatModel = model;   // 记住这次成功的模型给 /pet-ask.php 用
            sess.messages.push({ role: 'assistant', content: text, at: Date.now() });
            if (sess.messages.length > CHAT_MAX_MESSAGES) sess.messages = sess.messages.slice(-CHAT_MAX_MESSAGES);
            sess.updatedAt = Date.now();
            saveState();
            cb && cb(text);
          } else if (queue.length) attempt(queue.shift(), 'empty');
          else cb && cb('', '模型返回了空内容（可能也在限流，稍后再试）');
        } catch { cb && cb('', 'magpie 返回了无法解析的内容'); }
      });
    });
    req.on('error', e => cb && cb('', '连不上 magpie：' + e.message));
    req.on('timeout', () => { req.destroy(); cb && cb('', 'magpie 超时（25s）'); });
    req.write(body); req.end();
  };
  attempt(queue.shift(), '');
}

/* 问 DeepSeek 一个关于单词的问题,返回纯文本;失败/未配置返回 ''。 */
function askMagpie(prompt, cb) {
  const cfg = loadMagpie();
  if (!cfg.enabled || !cfg.baseUrl) return cb && cb('');
  let url;
  try { url = new URL(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'); } catch { return cb && cb(''); }
  const queue = cfg.models && cfg.models.length ? cfg.models.slice() : [cfg.model];
  const attempt = (model) => {
    if (!model) return cb && cb('');
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是派大星,一个陪用户背单词的桌面宠物。回答要简短口语化,中文不超过两句话,像朋友聊天。' },
        { role: 'user', content: String(prompt) },
      ],
      max_tokens: 220,
    });
    const req = http.request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 12000,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error('[companion] magpie(ask)', model, res.statusCode, data.slice(0, 200));
          if ((res.statusCode === 429 || res.statusCode === 503) && queue.length) return attempt(queue.shift());
          return cb && cb('');
        }
        try {
          const j = JSON.parse(data);
          const text = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
          cb && cb(text);
        } catch { cb && cb(''); }
      });
    });
    req.on('error', () => cb && cb(''));
    req.on('timeout', () => { req.destroy(); cb && cb(''); });
    req.write(body); req.end();
  };
  attempt(queue.shift());
}

/* ── 内置 SRS 引擎(独立 App 用)────────────────────────────────
 * 与网页 js/review.js 完全相同的间隔与推进规则,直接读写 user_state.review,
 * 不再依赖浏览器轮询。这样派大星自己就能出题、自己推进艾宾浩斯。
 * 账号:单机单账号模式取「最近活跃」的那个 user(通常是本人)。 */
const SRS_INTERVALS_MIN = [20, 60, 540, 1440, 2880, 4320, 8640, 17280];

function openSrsDb() {
  const dbPath = path.join(process.env.WORDPAPER_DATA_DIR || path.join(os.homedir(), '.wordpaper'), 'wordpaper.sqlite');
  if (process.env.WORDPAPER_TEST_MODE === '1' && !process.env.WORDPAPER_DATA_DIR) return null;
  if (!fs.existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout=5000');
    return db;
  } catch { return null; }
}
/* Use the account last selected through the authenticated local server. */
function activeUserId(db) {
  try {
    if (CFG.srsUserId) {
      const row = db.prepare('SELECT id FROM users WHERE id=?').get(CFG.srsUserId);
      return row ? row.id : null;
    }
    const active = db.prepare('SELECT user_id FROM sessions WHERE expires_at>? ORDER BY created_at DESC LIMIT 1').get(Date.now());
    if (active) return active.user_id;
    const users = db.prepare('SELECT id FROM users LIMIT 2').all();
    return users.length === 1 ? users[0].id : null;
  } catch { return null; }
}
let patrickIdleCache = { at: 0, value: null };
function notePatrickStudy(at, userId) {
  const db = openSrsDb();
  try {
    const id = userId || (db && activeUserId(db));
    if (id) {
      if (!state.patrickStudyByUser) state.patrickStudyByUser = {};
      state.patrickStudyByUser[id] = at;
    }
    patrickIdleCache.at = 0;
  } finally { if (db) db.close(); }
}
function patrickIdleContext() {
  const now = Date.now();
  if (patrickIdleCache.value && now - patrickIdleCache.at < 1000) return patrickIdleCache.value;
  const value = { userKey: '', studyAt: 0, eligible: false };
  const db = openSrsDb();
  try {
    const userId = db && activeUserId(db);
    if (userId) {
      value.userKey = String(userId);
      value.studyAt = Number(state.patrickStudyByUser?.[userId]) || 0;
      const review = readReviewState(db, userId);
      for (const bucket of Object.values(review)) {
        for (const item of Object.values(bucket?.words || {})) {
          value.studyAt = Math.max(value.studyAt, Number(item.lastSeenAt) || 0, Number(item.learnedAt) || 0, Number(item.petQuiz?.lastAt) || 0);
          for (const event of item.events || []) value.studyAt = Math.max(value.studyAt, Number(event.at) || 0);
        }
      }
      const words = review[CFG.library]?.words || {};
      const due = Object.values(words).some(item => Number(item.stage) < SRS_INTERVALS_MIN.length && Number(item.due) > 0 && Number(item.due) <= now);
      const fresh = petFirstPassWords().some(word => !words[wordKey(word)]);
      const settingsRow = db.prepare("SELECT value_json FROM user_state WHERE user_id=? AND namespace='settings'").get(userId);
      const settings = settingsRow ? JSON.parse(settingsRow.value_json) : {};
      value.eligible = settings.srsEnabled !== false && CFG.quizAutoStart !== false && featureOn('betaPetQuiz') && Boolean(due || fresh || patrickQuizState);
    }
  } catch (error) { value.eligible = false; }
  finally { if (db) db.close(); }
  patrickIdleCache = { at: now, value };
  return value;
}
function syncQuizUser(req) {
  const userId = Number(req.headers['x-wordpaper-user-id']);
  if (!Number.isSafeInteger(userId) || userId <= 0 || CFG.srsUserId === userId) return;
  const db = openSrsDb();
  if (!db) return;
  try {
    if (!db.prepare('SELECT id FROM users WHERE id=?').get(userId)) return;
    CFG.srsUserId = userId;
    patrickIdleCache.at = 0;
    saveConfig();
    clearQuizCard(); pendingQuiz = null; quizResultUntil = 0;
    pushPatrickCmd({ cmd: 'quiz-end' });
  } finally { db.close(); }
}
function readReviewState(db, userId) {
  try {
    const row = db.prepare("SELECT value_json FROM user_state WHERE user_id=? AND namespace='review'").get(userId);
    if (!row) return {};
    const parsed = JSON.parse(row.value_json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function writeReviewState(db, userId, all) {
  try {
    // Can be called inside answerQuiz's read/modify/write transaction.
    db.exec('SAVEPOINT quiz_review_write');
    const json = JSON.stringify(all);
    const now = Date.now();
    const existing = db.prepare("SELECT revision FROM user_state WHERE user_id=? AND namespace='review'").get(userId);
    if (existing) {
      db.prepare("UPDATE user_state SET value_json=?, revision=revision+1, updated_at=? WHERE user_id=? AND namespace='review'")
        .run(json, now, userId);
    } else {
      db.prepare("INSERT INTO user_state (user_id, namespace, value_json, revision, updated_at) VALUES (?,?,?,1,?)")
        .run(userId, 'review', json, now);
    }
    // Native quiz answers can happen while the workspace is closed. Record
    // their cloud write in the same transaction so a pull cannot erase them.
    const paired = db.prepare("SELECT value FROM app_meta WHERE key='upstream_pairing'").get();
    const pairing = paired ? JSON.parse(paired.value) : null;
    if (pairing && Number(pairing.localUserId) === Number(userId)) {
      const queued = db.prepare("SELECT value FROM app_meta WHERE key='upstream_queue'").get();
      const queue = queued ? JSON.parse(queued.value) : {};
      queue.review = { value: all, baseRevision: queue.review ? queue.review.baseRevision : Number(existing?.revision || 0) };
      db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('upstream_queue', ?)").run(JSON.stringify(queue));
    }
    db.exec('RELEASE quiz_review_write');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK TO quiz_review_write; RELEASE quiz_review_write'); } catch {}
    console.error('[companion] SRS 写回失败:', e.message); return false;
  }
}
/* 当前词库里所有到期词(按 due 升序)。 */
function srsDueWords(db, userId, library) {
  const all = readReviewState(db, userId);
  const bucket = all[library];
  if (!bucket || !bucket.words) return [];
  const now = Date.now();
  return Object.keys(bucket.words)
    .map(k => ({ key: k, item: bucket.words[k] }))
    .filter(({ item }) => item && item.word && item.due && item.due <= now && (Number(item.stage) || 0) < SRS_INTERVALS_MIN.length)
    .sort((a, b) => (a.item.due || 0) - (b.item.due || 0));
}
/* 推进/重置一个词,规则与 review.js 的 reviewWord 一致:
 * 记住了 → stage+1,下次间隔取 SRS_INTERVALS_MIN[stage];
 * 忘了   → stage 归零,20 分钟后再来。 */
function srsApplyAnswer(db, userId, library, key, correct, word) {
  const all = readReviewState(db, userId);
  const bucket = all[library] || { words: {} };
  if (!bucket.words) bucket.words = {};
  let item = bucket.words[key];
  const now = Date.now();
  const first = !item;
  if (first) {
    if (!word) return { ok: false, reason: 'missing' };
    item = { word, learnedAt: now, stage: 0, due: now + SRS_INTERVALS_MIN[0] * 60000, learnedCount: 1, reviewCount: 0, events: [{ at: now, type: 'learn' }] };
  } else if (!item.due || item.due > now || item.stage >= SRS_INTERVALS_MIN.length) {
    return { ok: false, reason: 'not-due' };
  }
  if (!first) {
    item.reviewCount = (Number(item.reviewCount) || 0) + 1;
    item.events = Array.isArray(item.events) ? item.events : [];
    if (correct) {
      item.stage = Math.min((Number(item.stage) || 0) + 1, SRS_INTERVALS_MIN.length);
      item.successCount = (Number(item.successCount) || 0) + 1;
      item.due = item.stage < SRS_INTERVALS_MIN.length ? now + SRS_INTERVALS_MIN[item.stage] * 60000 : null;
      item.events.push({ at: now, type: item.due ? 'review-pass' : 'mastered' });
    } else {
      item.stage = 0;
      item.failCount = (Number(item.failCount) || 0) + 1;
      item.due = now + SRS_INTERVALS_MIN[0] * 60000;
      item.events.push({ at: now, type: 'forgot' });
    }
    item.lastSeenAt = now;
  }
  item.petQuiz = Object.assign({ count: 0, firstAt: now }, item.petQuiz || {});
  item.petQuiz.count++;
  item.petQuiz.lastAt = now;
  item.petQuiz.lastCorrect = correct;
  item.events = item.events.slice(-64);
  bucket.words[key] = item;
  all[library] = bucket;
  const ok = writeReviewState(db, userId, all);
  return { ok, stage: item.stage, due: item.due };
}

/* 伴侣自主抽查:定时检查到期词,自动弹卡。不需要浏览器。 */
let autoQuizTimer = null;
let autoQuizLastAt = 0;

/* ── 抽查排队机制 ────────────────────────────────────────────
 * 用户在「有事做」的时候绝不出下一题,把要出的题攒进队列,等空下来再出:
 *   1. 刚作答完,卡片还停在屏上(给时间看对错/点造句)      → quizResultUntil
 *   2. 造句窗开着(正在打字)                                → sentenceWinChild
 *   3. 刚关掉造句窗的收尾缓冲                              → sentenceClosedAt
 * 队列只留最近一次请求(同一时刻只需一道题),空下来立刻补出。
 * 这样就不会出现「来不及造句,下一题突然冒出来」的情况。 */
const QUIZ_RESULT_DWELL_MS = 4500;        // 作答后卡片停留(够看对错/点造句,又不拖慢连续抽查)
const SENTENCE_CLOSE_GRACE_MS = 2500;     // 关掉造句窗后再等一会儿
let quizResultUntil = 0;
let sentenceClosedAt = 0;
let pendingQuiz = null;                   // { words, library, srsUserId, at }; never holds an open database

/* 现在能不能出题?返回原因字符串(空串 = 可以)。 */
function quizBusyReason() {
  if (patrickQuizState) return 'quiz-in-progress';
  if (Date.now() < quizResultUntil) return 'showing-result';
  if (sentenceWinChild) return 'sentencing';
  if (Date.now() - sentenceClosedAt < SENTENCE_CLOSE_GRACE_MS) return 'sentence-closing';
  return '';
}
/* 把一次出题请求排进队列(后来的覆盖先来的:只保留最新一批到期词)。 */
function queueQuiz(words, library, srsUserId) {
  pendingQuiz = { words, library, srsUserId, at: Date.now() };
}
/* 空下来时把排队的题出掉。由 autoQuizTick 与各处「空闲」事件调用。 */
function flushPendingQuiz() {
  const p = pendingQuiz;
  if (!p) return false;
  if (!featureOn('betaPetQuiz')) { pendingQuiz = null; return false; }
  // 与 /pet-quiz.php 的 offer 闸保持一致:TEST_MODE 放行(端点测试没有真窗口)。
  const gateOpen = patrickVisible || process.env.WORDPAPER_TEST_MODE === '1';
  if (CFG.petMode !== 'patrick' || !gateOpen) return false;
  if (quizBusyReason()) return false;      // 还在忙 → 继续等
  pendingQuiz = null;
  let words = p.words;
  if (p.srsUserId) {
    const db = openSrsDb();
    if (!db) return false;
    try { words = refreshQuizCandidates(db, p.srsUserId, p.library, p.words); }
    finally { db.close(); }
  }
  if (!words.length) return false;
  autoQuizLastAt = Date.now();
  return offerQuiz(words, p.library, p.srsUserId);
}
/* 供网页/测试查询:当前是否在等、在等什么。 */
function quizQueueState() {
  return {
    queued: Boolean(pendingQuiz),
    reason: quizBusyReason(),
    queuedAt: pendingQuiz ? pendingQuiz.at : 0,
    sentenceOpen: Boolean(sentenceWinChild),
    resultUntil: quizResultUntil,
  };
}
function quizDueCandidates(db, userId, library) {
  return srsDueWords(db, userId, library).slice(0, 8).map(({ item }) =>
    Object.assign({}, item.word, { stage: Number(item.stage) || 0, due: Number(item.due) }));
}
function refreshQuizCandidates(db, userId, library, fallback) {
  const due = quizDueCandidates(db, userId, library);
  if (due.length) return due;
  const bucket = readReviewState(db, userId)[library];
  return fallback.filter(w => !(bucket && bucket.words && bucket.words[wordKey(w)]))
    .map(w => Object.assign({}, w, { stage: null, due: null }));
}
function autoQuizTick() {
  if (!featureOn('betaPetQuiz') || CFG.quizAutoStart === false) return;
  if (CFG.petMode !== 'patrick' || !patrickVisible) return;
  const db = openSrsDb();
  if (!db) return;
  try {
    const userId = activeUserId(db);
    if (!userId) return;
    const picks = quizDueCandidates(db, userId, CFG.library);
    if (!picks.length) {
      if (flushPendingQuiz() || quizBusyReason()) return;
      const interval = Math.max(60, Number(CFG.quizIntervalSec) || 300) * 1000;
      if (Date.now() - autoQuizLastAt < interval) return;
      const fresh = refreshQuizCandidates(db, userId, CFG.library, petFirstPassWords());
      autoQuizLastAt = Date.now();
      if (fresh.length) offerQuiz(fresh, CFG.library, userId);
      return;
    }
    // stage=0 is the first scheduled review, not an unlearned word. A click
    // sent from the replaced card carries its id and cannot answer the new one.
    if (patrickQuizState && patrickQuizState.pickedIndex < 0 && patrickQuizState.category !== 'review' && !sentenceWinChild) {
      console.log('[companion] 复习到期 → 抢占新词卡:', patrickQuizState.word.word);
      clearQuizCard();
      pendingQuiz = null;
      offerQuiz(picks, CFG.library, userId);
      return;
    }
    if (quizBusyReason()) { queueQuiz(picks, CFG.library, userId); return; }
    pendingQuiz = null;
    autoQuizLastAt = Date.now();
    offerQuiz(picks, CFG.library, userId);
  } catch (e) { console.error('[companion] 抽查检查失败:', e.message); }
  finally { db.close(); }
}
function startAutoQuiz() {
  if (autoQuizTimer) return;
  setTimeout(autoQuizTick, 3000);
  autoQuizTimer = setInterval(autoQuizTick, 15000);
  if (autoQuizTimer.unref) autoQuizTimer.unref();
  console.log('[companion] 桌面抽查已启动(每 15s 检查到期词)');
}

/* ---------------- 抽查(quiz)核心 ----------------
 * 从网页推来的到期词里选一个,再从同词库抽 3 个干扰项组成 4 选 1。
 * 题目渲染成 CARD_PNG.quiz(按 PID 分离),由派大星窗加载显示(quiz 子窗);
 * 作答 → /pet-quiz.php?action=answer → petMemoryEvents(action:'quiz') → 网页
 * Review.reviewWord 同一条艾宾浩斯链:记住了=推进一档,忘了=回到 20 分钟档。 */
function pickQuizDistractors(library, answer, excludeKeys) {
  const pool = loadWords(library).filter(w => {
    const k = petWordKey(w);
    if (k === petWordKey(answer)) return false;
    if (excludeKeys.has(k)) return false;
    return (w.meaning || '') !== (answer.meaning || '');
  });
  const out = [];
  const seen = new Set();
  const rand = rng(hash(`quiz:${dateKey(new Date())}:${wordKey(answer)}:${Date.now()}`));
  for (let guard = 0; guard < 200 && out.length < 3; guard++) {
    const w = pool[Math.floor(rand() * pool.length)];
    if (!w) break;
    const m = w.meaning || '';
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(withPos(w));
  }
  while (out.length < 3) out.push('（想不起来了）');
  return out;
}
function wordKey(word) { return String((word && word.word) || '') + '|' + String((word && word.meaning) || ''); }
/* 悬停状态气泡渲染:buildStatusBubbleSVG → sips → /tmp/dw_status_bubble-<pid>.png。
 * 桌面词变化(bumpPetWordEpoch)与 SRS 写回后都会触发;另有 5 分钟兜底刷新。 */
let statusBubbleTimer = null;
function renderStatusBubble() {
  try {
    const st = currentWordStatus();
    const svg = buildStatusBubbleSVG(st, petSkin(CFG.uiTheme).dark === true);
    const png = path.join(os.tmpdir(), `dw_status_bubble-${process.pid}.png`);
    const svgPath = png.replace(/\.png$/, '.svg');
    fs.writeFileSync(svgPath, svg);
    execFile('sips', ['-s', 'format', 'png', svgPath, '--out', png], { timeout: 20000 }, (err) => {
      try { fs.unlinkSync(svgPath); } catch {}
      if (err) console.error('[companion] 状态气泡渲染失败:', err.message);
    });
  } catch (e) { console.error('[companion] 状态气泡异常:', e.message); }
}
function currentWordStatus() {
  let srsIndex = new Map();
  try {
    const db = openSrsDb();
    const userId = db && activeUserId(db);
    if (db && userId) {
      const libState = readReviewState(db, userId)[CFG.library];
      Object.values((libState && libState.words) || {}).forEach(item => {
        if (item && item.word && item.word.word) srsIndex.set(String(item.word.word).toLowerCase(), item);
      });
    }
    try { if (db) db.close(); } catch {}
  } catch {}
  const now = Date.now();
  return petFirstPassWords().map(w => {
    const rec = srsIndex.get(String(w.word || '').toLowerCase());
    if (!rec) return { word: w.word, kind: 'new' };
    const due = Number(rec.due) || 0;
    if ((Number(rec.stage) || 0) >= SRS_INTERVALS_MIN.length) return { word: w.word, kind: 'mastered' };
    if (!due || due <= now) return { word: w.word, kind: 'due', stage: Number(rec.stage) || 0 };
    return { word: w.word, kind: 'countdown', stage: Number(rec.stage) || 0, dueInMs: due - now };
  });
}
/* 词页变化/SRS 写回后延迟 2s 重渲(等 sips 空闲),5 分钟兜底 */
function scheduleStatusBubble() {
  if (statusBubbleTimer) return;
  statusBubbleTimer = setTimeout(() => { statusBubbleTimer = null; if (patrickVisible) renderStatusBubble(); }, 2000);
  if (statusBubbleTimer.unref) statusBubbleTimer.unref();
}

/* 把 SRS 间隔(分钟)转成人话:"20 分钟" / "9 小时" / "2 天" */
function fmtIntervalMin(min) {
  const m = Number(min) || 0;
  if (m < 60) return m + ' 分钟';
  if (m < 1440) return Math.round(m / 60) + ' 小时';
  return Math.round(m / 1440) + ' 天';
}

function isQuizReviewDue(word) {
  const due = Number(word && word.due);
  return Number.isFinite(due) && due > 0 && due <= Date.now() && (Number(word.stage) || 0) < SRS_INTERVALS_MIN.length;
}
function quizRoundInfo(stage) {
  stage = Math.max(0, Math.min(SRS_INTERVALS_MIN.length - 1, Number(stage) || 0));
  return { stage, total: SRS_INTERVALS_MIN.length,
    nextIn: stage + 1 < SRS_INTERVALS_MIN.length ? fmtIntervalMin(SRS_INTERVALS_MIN[stage + 1]) : null };
}
function offerQuiz(dueWords, library, srsUserId) {
  // Due reviews (including stage zero), then visible new words, then other new words.
  dueWords = dueWords.filter(w => !Number(w.due) || isQuizReviewDue(w));
  let visibleKeys = new Set();
  try { visibleKeys = new Set(petFirstPassWords().map(petWordKey)); } catch {}
  const isReviewDue = isQuizReviewDue;
  const reviewDue = dueWords.filter(isReviewDue);                                  // ① 复习到期
  const visibleNew = dueWords.filter(w => !isReviewDue(w) && visibleKeys.has(petWordKey(w)));  // ② 屏上新词
  const others = dueWords.filter(w => !isReviewDue(w) && !visibleKeys.has(petWordKey(w)));     // ③ 其它
  const pool = reviewDue.length ? reviewDue : (visibleNew.length ? visibleNew : others);
  if (!pool.length) return false;
  const answer = pool[Math.floor(Math.random() * pool.length)];
  autoQuizLastAt = Date.now();
  const options = pickQuizDistractors(library, answer, new Set(dueWords.map(wordKey)));
  const answerIndex = Math.floor(Math.random() * 4);
  options.splice(answerIndex, 0, withPos(answer));
  patrickQuizState = {
    id: `${process.pid}-${++quizSequence}`, word: answer, options, answerIndex, pickedIndex: -1, library,
    key: wordKey(answer), stage: Number(answer.stage) || 0, askedAt: Date.now(), expand: false,
    // 类别:复习到期(进入艾宾浩斯记忆本)还是桌面新词(还没背第一遍)
    category: isReviewDue(answer) ? 'review' : (visibleKeys.has(petWordKey(answer)) ? 'fresh' : 'other'),
    // 复习类:第几轮 + 答对后的下次间隔(给卡片显示)
    roundInfo: isReviewDue(answer) ? quizRoundInfo(answer.stage) : null,
    srsUserId: srsUserId || null,
  };
  // 上一题的朗读、点击派大星时在念的词/例句 —— 全部立刻掐断。
  // 用户要求:抽查弹出时**只有**这张卡上的这个词可以出声。
  ttsStopNow();
  displayedQuiz = patrickQuizState;
  const isReview = isReviewDue(answer);
  const catLabel = isReview
    ? '⏰ 复习到期（已进艾宾浩斯记忆本）'
    : (visibleKeys.has(petWordKey(answer)) ? '🆕 桌面新词（还没背第一遍）' : '📚 词库新词（还没背第一遍）');
  renderQuizCard(() => pushPatrickCmd({ cmd: 'quiz', lines: [
    { text: catLabel, size: 10, color: 'sub' },
    { text: '「' + answer.word + '」还记得吗？', size: 12, bold: true },
  ], ms: 26000 }));
  // 先把考题词的音频**预合成**好(缓存);等卡片真正滑入上屏、派大星窗回报
  // 'quiz-shown' 的那一刻再播 —— 声音与弹卡同步,且只读这一个词。
  ttsPrewarm(answer.word, () => {});   // 失败也无所谓:上屏那刻会回退到现场合成
  return true;
}
function renderQuizCard(onReady) {
  const q = patrickQuizState || displayedQuiz;
  if (!q) return;
  const out = buildQuizSVG({
    word: q.word.word, phonetic: q.word.phonetic || '', options: q.options,
    answerIndex: q.answerIndex,
    pickedIndex: q.pickedIndex,
    done: q.pickedIndex >= 0,
    correct: q.pickedIndex === q.answerIndex,
    category: q.category || '',      // 'review' 复习到期 / 'fresh' 桌面新词
    roundInfo: q.roundInfo || null,  // {stage,total,nextIn} 仅复习类
    expand: q.expand === true,       // 超长释义点击展开后为 true
  }, q.options, petSkin(CFG.uiTheme).dark === true);
  const revision = ++quizRenderSequence;
  const pngPath = CARD_PNG.quiz.replace(/\.png$/, `-${revision}.png`);
  const svgPath = pngPath.replace(/\.png$/, '.svg');
  fs.writeFileSync(svgPath, out.svg);
  execFile('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath], { timeout: 20000 }, (err) => {
    try { fs.unlinkSync(svgPath); } catch {}
    if (err || revision !== quizRenderSequence || displayedQuiz !== q) {
      try { fs.unlinkSync(pngPath); } catch {}
      if (err) console.error('[companion] quiz render failed:', err.message);
      return;
    }
    try {
      fs.renameSync(pngPath, CARD_PNG.quiz);
      q.geom = Object.assign(out.geom, { id: q.id, revision, hold: !!q.hold });
      if (onReady) onReady();
    } catch (e) { console.error('[companion] quiz publish failed:', e.message); }
  });
}
function scheduleQuizResultDismiss(q, delay) {
  quizResultUntil = q.hold ? Number.MAX_SAFE_INTEGER : Date.now() + delay;
  const deadline = q.dismissAt = quizResultUntil;
  setTimeout(() => {
    if (q.dismissAt !== deadline || patrickQuizState || displayedQuiz !== q || q.hold || speakCardState?.quizId === q.id || sentenceWinChild) return;
    clearQuizCard();
    if (!flushPendingQuiz()) autoQuizTick();
  }, delay).unref?.();
}
function answerQuiz(picked, res) {
  const q = patrickQuizState;
  if (!q) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'no-quiz' })); }
  if (!Number.isInteger(picked) || picked < 0 || picked >= q.options.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'invalid-option' }));
  }
  const correct = picked === q.answerIndex;
  q.pickedIndex = picked;
  q.hold = q.expand === true;
  renderQuizCard();
  const now = Date.now();
  state.petMemorySeq = Math.max(0, Number(state.petMemorySeq) || 0) + 1;
  const event = {
    id: state.petMemorySeq, at: now, library: q.library, word: q.word,
    action: 'quiz', correct, stage: Number.isFinite(Number(q.stage)) ? Number(q.stage) : null,
    page: 0, refilled: false,
    userId: q.srsUserId || undefined,
  };
  // 本地 SRS:伴侣自己推进艾宾浩斯(独立 App 模式,网页没开也生效)。
  if (q.srsUserId) {
    const db = openSrsDb();
    try {
      if (db) db.exec('BEGIN IMMEDIATE');
      const r = db && srsApplyAnswer(db, q.srsUserId, q.library, q.key, correct, q.word);
      if (db) db.exec(r && r.ok ? 'COMMIT' : 'ROLLBACK');
      if (r && (r.ok || r.reason === 'not-due')) {
        event.srsApplied = true;
        event.userId = q.srsUserId;
        if (r.ok) { console.log('[companion] 抽查已写回 SRS:', q.word.word, '→ stage', r.stage); scheduleStatusBubble(); }
      }
    } catch (e) {
      try { if (db) db.exec('ROLLBACK'); } catch {}
      console.error('[companion] SRS 写回异常:', e.message);
    }
    finally { if (db) db.close(); }
  }
  notePatrickStudy(event.at, event.userId || q.srsUserId);
  state.petMemoryEvents.push(event);
  state.petMemoryEvents = state.petMemoryEvents.slice(-160);
  saveState();
  // 作答只放对/错音效,**不念任何词**:这个单词在弹卡时已经读过一遍了。
  // (之前会念 "Nice!/Oops." + 再念一次单词,听起来像多余的声音。)
  ttsStopNow();
  playSfx(correct ? 'correct' : 'wrong');
  const word = q.word;
  patrickQuizState = null;
  // 桌面联动:考完的这个词从桌面当前页**原位换成新词**(与点词卡补位同一套逻辑)。
  // SRS 记忆照旧走数据库——忘了的词 20 分钟后还会回来考,不丢;但桌面空间
  // 永远留给「正要记」的词。换完推新词到派大星窗 + 重渲壁纸(同步开启时)。
  try {
    const deck = ensurePetDeck(q.library);
    const page = deck.pages[deck.index];
    const key = petWordKey(word);
    const idx = page.words.findIndex(item => petWordKey(item) === key);
    if (idx >= 0) {
      const inUse = new Set();
      deck.pages.forEach(p => (p.words || []).forEach(w => inUse.add(petWordKey(w))));
      inUse.delete(key);   // 被换掉的词自己不占坑
      const candidate = drawPetWords(q.library, deck, 1, inUse)[0];
      if (candidate) page.words[idx] = candidate;
      else { page.words.splice(idx, 1); refillPetPage(q.library, deck, page); }
      bumpPetWordEpoch();
      saveState();
      syncWallpaperToPet();
      pushPatrickCmd({ cmd: 'words', words: petWordsForPatrick(), keys: currentPetKeys(), exampleLines: petWordsForPatrick().map(x => x.example).filter(Boolean) });
      console.log('[companion] 桌面已换词:', word.word, '→', candidate ? candidate.word : '(补位)');
    }
  } catch (e) { console.error('[companion] 桌面换词失败:', e.message); }
  // 结果卡要在屏上停留几秒让用户看到对错标记:quiz 子窗轮询 quiz.png 的 mtime,
  // sips 写完新 PNG 自动重绘;2.6s 后撤卡。气泡走 quiz-end 但**不**立刻藏子窗
  // (JXA 侧 quiz-end 只清 st.quiz,子窗由 hideQuizCardTimer 撤)。
  // 作答后把这次考的题记下来:造句窗要用它(词 + 释义 + 这次的对错)。
  state.lastQuiz = {
    word: word.word, meaning: word.meaning || '', pos: word.pos || '',
    phonetic: word.phonetic || '', library: q.library, correct, at: Date.now(),
  };
  saveState();
  pushPatrickCmd({
    cmd: 'quiz-result',
    effect: correct ? 'correct' : 'wrong',   // JXA 侧据此播放对/错动画
    ms: 4500,
    hold: q.hold,
    lines: [{ text: correct ? '答对了！' + q.word.word + ' 已进入下一轮复习' : '没关系，"' + q.word.word + '" 会再回来找你', size: 11 }],
  });
  // 作答后卡片停留一段时间:让用户看对错,并决定「下一个」还是「造个句子」。
  // 停留期间不算空,排队的题不会冒出来(quizBusyReason 会挡住)。
  scheduleQuizResultDismiss(q, QUIZ_RESULT_DWELL_MS);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ ok: true, correct, word: word.word, meaning: word.meaning, queue: quizQueueState() }));
}

/* 按形态分发:CFG.petMode = 'card' | 'patrick'。所有「召唤小词灵」入口都走这里。 */
function startPet() {
  if (CFG.petMode === 'patrick') { startPatrickPet(); return; }
  startCardPet();
}

function startCardPet() {
  stopPet();
  const generation = petGeneration;
  if (!isMac || !CFG.petEnabled) return;
  const closeFile = PET_CLOSED_PATH;
  if (fs.existsSync(closeFile)) { console.log('[companion] 小窗已被关闭（点 ✕），重启伴侣后恢复'); return; }
  // 用上次拉伸保存的尺寸；没有就用默认（紧凑卡片）。旧版本允许
  // 900×900 的巨型面板，自动迁移回舒服的桌面尺寸，用户仍可再手动放大。
  const { w: W, h: H } = resolvePetSize();
  // remember where the user last dragged the pet window
  const posFile = PET_POSITION_PATH;
  let savedPos = '';
  try {
    const p = JSON.parse(fs.readFileSync(posFile, 'utf8'));
    if (p && typeof p.x === 'number' && typeof p.y === 'number') savedPos = JSON.stringify({ x: p.x, y: p.y });
  } catch {}
  renderPetPng(W, H, (err) => {
    if (generation !== petGeneration || fs.existsSync(closeFile)) return;
    if (err) { console.error('[companion] pet render failed:', err.message); return; }
    const pngPath = path.join(os.tmpdir(), `dw_pet-${process.pid}.png`);
    const jxa = buildPetJXA(W, H);
    const scriptPath = path.join(os.tmpdir(), `dw_pet-${process.pid}.jxa.js`);
    fs.writeFileSync(scriptPath, jxa);
    const { spawn } = require('child_process');
    petVisible = true;
    const child = petChild = spawn('osascript', ['-l', 'JavaScript', scriptPath, pngPath, CFG.petCorner || 'top-right', posFile, savedPos, closeFile, String(process.pid)], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', data => console.error('[companion] pet window:', String(data).trim()));
    child.on('error', () => { if (petChild === child) { petChild = null; petVisible = false; } });
    child.on('exit', (code, signal) => {
      if (petChild !== child) return;
      petChild = null; petVisible = false;
      if (code && !fs.existsSync(closeFile)) console.error(`[companion] pet window exited (${code}${signal ? ', ' + signal : ''})`);
    });
    petChild.unref();
    console.log(`[companion] 桌面小词灵已显示（词卡展示中文；点击词卡＝记住；按住空白处可拖动，右下角圆形把手可调大小；每 ${Math.max(5, CFG.intervalMinutes)} 分钟刷新）`);
  });
}

/* 词卡点击 / 翻页后刷新小词灵，但**不重启窗口**：只在原位重渲 PNG，窗口自带的
 * mtime 轮询（buildPetJXA 里 0.6s 定时器）发现文件变了就原地换图。这样点击
 * 标熟时新词直接顶替旧词、窗口纹丝不动——没有 kill+重开带来的闪屏和位置跳动。
 * 仅当可见词数真的变化（词库见底补不满、翻页词数不同）时才重启窗口，因为原生
 * 命中网格的词数 COUNT 是写死的，词数变了不重启就会点到已消失的卡片。 */
function refreshPetInPlace(prevCount, nextCount, done) {
  if (CFG.petMode === 'patrick') {
    // 派大星:词变了推送新词表(气泡/朗读目标立即更新),无命中网格无需重开。
    pushPatrickCmd({ cmd: 'words', words: petWordsForPatrick(), keys: currentPetKeys(), exampleLines: petWordsForPatrick().map(x => x.example).filter(Boolean) });
    return renderPetPng(resolvePetSize().w, resolvePetSize().h, done);   // 同步壁纸词源照旧
  }
  const { w, h } = resolvePetSize();
  if (!petVisible || !petChild) return renderPetPng(w, h, done);
  if (typeof nextCount === 'number' && nextCount !== prevCount) {
    // 词数变了 → 命中网格要按新词数重建，这一扇必须重开。
    startPet();
    if (done) done();
    return;
  }
  renderPetPng(w, h, done);
}

/* 当前小词灵可见词的命中 key 表(与 PNG 同源 petFirstPassWords)。原位换图后窗口
 * 不重开,但窗口里的 KEYS 是创建时写死的静态表;必须随响应回传最新表,让 JXA 更新
 * 自己的 KEYS,否则第二次点击 key 对不上 → stale 拒判 → “点不动”。 */
function currentPetKeys() { return petFirstPassWords().map(petWordKey); }

/* ---------------- set the REAL macOS desktop wallpaper ---------------- */
/* Read-only. setDesktopImageURL is a different script, used only when the
 * desktop is not already one of our stable files. */
// JXA ships with macOS; invoking swift would require developer tools.
const READ_WALLPAPER_JXA = `ObjC.import('AppKit');
ObjC.unwrap($.NSWorkspace.sharedWorkspace.desktopImageURLForScreen($.NSScreen.mainScreen).path) || '';
`;
/* One import of our stable slot. Never points this call at the extension
 * cache: that is the call which stores another 你的照片 card. */
const SET_WALLPAPER_JXA = `ObjC.import('AppKit');
(function () {
  const targetPath = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('WP_TARGET')) || '';
  if (targetPath.includes('/com.apple.wallpaper.extension.image/') || targetPath.includes('/com.apple.wallpaper.caches/')) {
    throw new Error('refusing to import a wallpaper cache file');
  }
  if (!$.NSFileManager.defaultManager.fileExistsAtPath(targetPath)) throw new Error('missing wallpaper file');
  const target = $.NSURL.fileURLWithPath(targetPath);
  const workspace = $.NSWorkspace.sharedWorkspace;
  const screens = $.NSScreen.screens;
  for (let i = 0; i < screens.count; i++) {
    const error = Ref();
    if (!workspace.setDesktopImageURLForScreenOptionsError(target, screens.objectAtIndex(i), $({}), error)) {
      throw new Error(error[0] ? ObjC.unwrap(error[0].localizedDescription) : 'could not set desktop image');
    }
  }
  return ObjC.unwrap(workspace.desktopImageURLForScreen($.NSScreen.mainScreen).path) || '';
})();
`;
function readDesktopImagePath(cb) {
  execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', READ_WALLPAPER_JXA], { timeout: 20000 }, (err, stdout) => {
    if (err) return cb(err);
    cb(null, String(stdout || '').trim());
  });
}
function reloadWallpaperAgent() {
  if (process.env.WORDPAPER_TEST_MODE === '1') return;
  // Same-path setDesktopImageURL does not redraw, and calling it again copies
  // a new UUID into the image extension. Relaunching the agent re-reads the
  // file Index.plist already points at.
  execFile('/usr/bin/killall', ['WallpaperAgent'], () => {});
}
function rememberWallpaperCache(applied, setPath) {
  if (!applied || applied === setPath || !wallpaperFiles.isWallpaperExtensionCachePath(applied)) return;
  if (state.wallpaperCachePath === applied) return;
  state.wallpaperCachePath = applied;
  saveState();
}
function setMacWallpaper(pngPath, cb) {
  if (!isMac) return cb && cb(new Error('not macOS'));
  readDesktopImagePath((err, current) => {
    if (err) return cb && cb(err);
    if (!current) return cb && cb(new Error('could not read the current desktop image'));
    let plan;
    try {
      plan = wallpaperFiles.resolveWallpaperPublish({
        currentPath: current,
        targetPath: pngPath,
        ownedCachePath: state.wallpaperCachePath || '',
        cacheExists: !wallpaperFiles.isWallpaperExtensionCachePath(current) || fs.existsSync(current),
      });
    } catch (e) { return cb && cb(e); }
    const finishReuse = () => {
      reloadWallpaperAgent();
      cb && cb(null, plan.updatePath || pngPath);
    };
    if (plan.mode === 'reuse') {
      if (plan.updatePath && wallpaperFiles.isWallpaperExtensionCachePath(plan.updatePath)
          && (!/\.png$/i.test(plan.updatePath) || !fs.existsSync(plan.updatePath))) {
        // Never create a cache file, and never overwrite a HEIC cache with PNG bytes.
        plan = { mode: 'reuse', setPath: null, updatePath: null };
      }
      if (plan.updatePath) {
        try { wallpaperFiles.writeBufferInPlace(fs, plan.updatePath, fs.readFileSync(pngPath)); }
        catch (e) {
          // The extension cache is TCC-protected. The stable slot already has
          // the new bytes; reloading the agent still shows that file.
          if (!wallpaperFiles.isWallpaperExtensionCachePath(plan.updatePath)) return cb && cb(e);
          console.error('[companion] in-place cache update skipped:', e.message);
        }
      }
      return finishReuse();
    }
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SET_WALLPAPER_JXA], {
      timeout: 45000,
      env: { ...process.env, WP_TARGET: plan.setPath },
    }, (setErr, stdout) => {
      if (setErr) return cb && cb(setErr);
      const applied = String(stdout || '').trim();
      const ok = applied === plan.setPath || wallpaperFiles.isWallpaperExtensionCachePath(applied);
      if (!ok) {
        return cb && cb(new Error(`wallpaper path mismatch (wanted ${path.basename(plan.setPath)}, got ${path.basename(applied || 'empty')})`));
      }
      rememberWallpaperCache(applied, plan.setPath);
      cb && cb(null, plan.setPath);
    });
  });
}

/* push one fresh wallpaper to the desktop */
let lastWallpaperSig = '';
let lastWallpaperPath = '';
function wallpaperSignature(picked, W, H) {
  const words = (picked || []).map(w => [w && w.word, w && w.phonetic, w && w.pos, w && w.meaning].join('\t')).join('\n');
  const s = buildSettings();
  const rems = (CFG.reminders || []).map(r => [r && r.text, r && r.time, r && r.done].join('\t')).join('\n');
  const epoch = CFG.petWallpaperSync ? (state.petWordEpoch || 0) : 0;
  return [W, H, CFG.theme, CFG.layout, CFG.bgPattern, s.anchorWords, s.anchorReminders,
    s.offWords.x, s.offWords.y, s.offReminders.x, s.offReminders.y, s.showReminders, epoch, words, rems].join('|');
}
/* ── 跨进程壁纸互斥(双伴侣保险丝)────────────────────────────────
 * 正常情况下这台机器只有一个伴侣;但误启动/测试残留/看门狗竞态可能同时跑两份,
 * 各持一份内存 state 轮流推壁纸 → 「点了词又被旧词盖回去」。macOS 桌面壁纸是
 * 物理共享资源,这里用 O_EXCL 锁文件保证同一时刻只有一个进程在推:
 * 锁 30s 自动过期(渲染一般 <3s;持锁进程崩溃也不会永久卡死),拿不到锁的
 * 调用直接跳过 —— 正主会推最新状态,跳过者不必补。 */
const WALLPAPER_LOCK_PATH = path.join(os.tmpdir(), 'dw_wallpaper.lock');
const WALLPAPER_LOCK_MS = 30000;
function acquireWallpaperLock() {
  const now = Date.now();
  try {
    fs.writeFileSync(WALLPAPER_LOCK_PATH, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      try {
        const holder = JSON.parse(fs.readFileSync(WALLPAPER_LOCK_PATH, 'utf8'));
        const holderAlive = holder.pid !== process.pid && (() => { try { process.kill(holder.pid, 0); return true; } catch { return false; } })();
        if (now - holder.at > WALLPAPER_LOCK_MS || !holderAlive) {   // 过期锁/持锁进程已死:接管
          try { fs.unlinkSync(WALLPAPER_LOCK_PATH); } catch {}
          try { fs.writeFileSync(WALLPAPER_LOCK_PATH, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx' }); return true; } catch { return false; }
        }
        if (holder.pid === process.pid) {   // 自己持有(串行渲染队列可重入)
          try { fs.writeFileSync(WALLPAPER_LOCK_PATH, JSON.stringify({ pid: process.pid, at: now })); return true; } catch {}
          return true;
      }
      } catch {}
      return false;
    }
    return false;
  }
}
function releaseWallpaperLock() {
  try {
    const holder = JSON.parse(fs.readFileSync(WALLPAPER_LOCK_PATH, 'utf8'));
    if (holder.pid === process.pid) fs.unlinkSync(WALLPAPER_LOCK_PATH);
  } catch {}
}

function pushWallpaper(cb, opts) {
  const force = !!(opts && opts.force);
  // 双伴侣保险丝:拿不到锁 = 另一个伴侣正在/刚刚推过壁纸,跳过本次,
  // 避免两份内存 state 互相覆盖(用户看到「点了词又被旧词盖回去」)。
  if (!acquireWallpaperLock()) {
    console.error('[companion] 另一个伴侣进程正在推壁纸,本次跳过(双实例保护)');
    return cb && cb(null, null);
  }
  const today = dateKey(new Date());
  // 同步开启时壁纸 = 小词灵当前页词（单一事实源）；否则回退原有按日期/种子随机。
  let picked;
  if (CFG.petWallpaperSync) {
    picked = petFirstPassWords();
  } else {
    const words = loadWords(CFG.library);
    picked = pickForDate(words, CFG.wordsPerGroup, todaySeed(), 'random');
  }
  const [W, H] = SIZES[CFG.size] || SIZES['desktop-1920x1080'];
  const sig = wallpaperSignature(picked, W, H);
  // Identical content is already on the stable file. Skip sips and avoid
  // another desktop import — that import is what fills 你的照片.
  // Pet-click sync still forces a render when the epoch changes.
  if (!force && sig === lastWallpaperSig && lastWallpaperPath && fs.existsSync(lastWallpaperPath)) {
    releaseWallpaperLock();
    return cb && cb(null, lastWallpaperPath);
  }
  const settings = buildSettings();
  const svg = buildSVG({
    width: W, height: H, layout: CFG.layout, theme: THEMES[CFG.theme] || THEMES.cream,
    words: picked, reminders: CFG.reminders || [], settings, dateStr: today,
  });
  // Always the same slot file. A new path on each refresh is what made
  // macOS keep a new 你的照片 card.
  const out = freshWallpaperFile('wallpaper');
  rasterizeSVG(svg, out, W, H, (err, png) => {
    if (err) {
      releaseWallpaperLock();
      console.error('[companion] render failed:', err.message);
      return cb && cb(err);
    }
    if (!CFG.autoSetWallpaper) {
      releaseWallpaperLock();
      lastWallpaperSig = sig; lastWallpaperPath = out;
      console.log('[companion] rendered', out, '(autoSet off)');
      return cb && cb(null, out);
    }
    setMacWallpaper(out, (e2) => {
      releaseWallpaperLock();
      cleanupOldWallpapers('wallpaper', out);
      if (e2) console.error('[companion] set wallpaper failed:', e2.message);
      else {
        lastWallpaperSig = sig; lastWallpaperPath = out;
        console.log(`[companion] desktop wallpaper updated ${new Date().toLocaleTimeString()} (${picked.length} words)`);
      }
      cb && cb(e2, out);
    });
  });
}
/* One stable file per kind. slot1 is kept only so an older desktop that
 * already points at it is overwritten in place instead of imported again. */
function freshWallpaperFile(prefix) {
  return wallpaperFiles.slotFile(RUNTIME_ROOT, prefix);
}
function cleanupOldWallpapers(prefix, keepPath) {
  try {
    const keepName = keepPath ? path.basename(keepPath) : '';
    const files = fs.readdirSync(RUNTIME_ROOT).filter(f => f.startsWith(prefix + '-') && f.endsWith('.png'));
    for (const f of files) {
      if (f === keepName || f === `${prefix}-slot0.png` || f === `${prefix}-slot1.png`) continue;
      try { fs.unlinkSync(path.join(RUNTIME_ROOT, f)); } catch {}
    }
  } catch {}
  if (keepPath) pruneMacWallpaperIndex(keepPath);
}
/* Point leftover WordPaper picture paths in the system wallpaper index at the
 * file we just set, so 你的照片 does not grow a new card on every refresh. */
const PRUNE_WALLPAPER_PY = `
import os, plistlib, sys
from pathlib import Path
from urllib.parse import unquote, urlparse
index_path, keep = sys.argv[1], sys.argv[2]
keep_url = Path(keep).as_uri()
root = plistlib.load(open(index_path, "rb"))
changed = 0
STABLE = {
    "wallpaper-slot0.png", "wallpaper-slot1.png",
    "custom-slot0.png", "custom-slot1.png",
}
def ours(url):
    if not isinstance(url, str) or not url.startswith("file:"):
        return False
    path = unquote(urlparse(url).path)
    base = os.path.basename(path)
    if base in STABLE:
        return False
    return "/WordPaper/companion/" in path and base.endswith(".png") and (base.startswith("wallpaper-") or base.startswith("custom-"))
def walk(obj):
    global changed
    if isinstance(obj, dict):
        cfg = obj.get("Configuration")
        if isinstance(cfg, (bytes, bytearray)) and bytes(cfg).startswith(b"bplist"):
            try:
                inner = plistlib.loads(bytes(cfg))
            except Exception:
                inner = None
            if isinstance(inner, dict) and inner.get("type") == "imageFile":
                url = (inner.get("url") or {}).get("relative")
                if ours(url) and url != keep_url:
                    inner["url"] = {"relative": keep_url}
                    obj["Configuration"] = plistlib.dumps(inner, fmt=plistlib.FMT_BINARY)
                    changed += 1
        for v in obj.values():
            walk(v)
    elif isinstance(obj, list):
        for v in obj:
            walk(v)
walk(root)
if changed:
    tmp = index_path + ".wordpaper-tmp"
    with open(tmp, "wb") as f:
        plistlib.dump(root, f, fmt=plistlib.FMT_BINARY)
    os.replace(tmp, index_path)
print(changed)
`;
let pruneQueued = '';
let pruneRunning = false;
let pruneState = { keep: '', mtimeMs: -1 };
const WP_INDEX_URL_RE = /file:\/\/[^\x00-\x1f\s"<>]+WordPaper\/companion\/(?:wallpaper|custom)-[^\x00-\x1f\s"<>]+\.png/g;
function wordpaperUrlsInWallpaperIndex(indexPath) {
  let buf;
  try { buf = fs.readFileSync(indexPath); } catch { return null; }
  return [...new Set(buf.toString('latin1').match(WP_INDEX_URL_RE) || [])];
}
function wallpaperIndexAlreadyFolded(indexPath, keepPath) {
  // Stable slot URLs are already the files we reuse. Only timestamped
  // wallpaper-YYYY… names need folding, and never onto a cache UUID.
  if (!wallpaperFiles.isOurWallpaperFile(keepPath)) return true;
  const urls = wordpaperUrlsInWallpaperIndex(indexPath);
  if (!urls || !urls.length) return true;
  return !urls.some(u => wallpaperFiles.isLegacyWallpaperUrl(u));
}
function pruneMacWallpaperIndex(keepPath) {
  if (!isMac || !keepPath) return;
  pruneQueued = keepPath;
  if (!pruneRunning) pumpWallpaperPrune();
}
function pumpWallpaperPrune() {
  const keep = pruneQueued;
  pruneQueued = '';
  if (!keep) { pruneRunning = false; return; }
  const index = path.join(os.homedir(), 'Library', 'Application Support', 'com.apple.wallpaper', 'Store', 'Index.plist');
  let st;
  try { st = fs.statSync(index); } catch { pruneRunning = false; return; }
  // Already folded onto this file, and WallpaperAgent has not rewritten the
  // index since. Skip the python spawn and the plist write entirely.
  if (pruneState.keep === keep && pruneState.mtimeMs === st.mtimeMs) {
    pruneRunning = false;
    if (pruneQueued) pumpWallpaperPrune();
    return;
  }
  if (wallpaperIndexAlreadyFolded(index, keep)) {
    pruneState = { keep, mtimeMs: st.mtimeMs };
    pruneRunning = false;
    if (pruneQueued) pumpWallpaperPrune();
    return;
  }
  pruneRunning = true;
  execFile('python3', ['-c', PRUNE_WALLPAPER_PY, index, keep], { timeout: 8000 }, (err, stdout) => {
    pruneRunning = false;
    if (err) console.error('[companion] prune wallpaper history failed:', err.message);
    else {
      let mtime = st.mtimeMs;
      try { mtime = fs.statSync(index).mtimeMs; } catch {}
      pruneState = { keep, mtimeMs: mtime };
      const n = String(stdout || '').trim();
      if (n && n !== '0') console.log(`[companion] folded ${n} old wallpaper paths onto ${path.basename(keep)}`);
    }
    if (pruneQueued) pumpWallpaperPrune();
  });
}
function rotationBucket() {
  const now = new Date();
  return Math.floor((now.getHours() * 60 + now.getMinutes()) / Math.max(1, CFG.intervalMinutes));
}

/* One-key advance: bump the pick seed, render + set a fresh wallpaper, and
 * refresh the pet window so it shows the same new group. Renders are serialized
 * (sips is single-threaded enough that overlapping pushes race) — rapid clicks
 * bump immediately and queue one trailing render. */
let advancing = false;
let pendingDir = 0;
let lastAdvanceAt = 0;   // 服务端安全阀：500ms 内重复推进直接吞掉，防幽灵连发
function runAdvance(dir) {
  // 「换一组」= 推动小词灵翻到下一页(pet-page.php 的同一原子操作)。
  // 旧实现只 bump 随机种子:petWallpaperSync 开启时壁纸词源是小词灵当前页,
  // 种子根本不参与选词 → 签名不变 → pushWallpaper 短路 → 热键/菜单点了毫无反应。
  // 翻页语义与网页「换一组」按钮完全一致;同步开启时壁纸跟着换;小词灵没开
  // (或已关闭)时退回旧的种子推进,至少壁纸要换一组。
  if ((petVisible || patrickVisible) && (petChild || patrickChild) && CFG.petEnabled) {
    const prevCount = petFirstPassWords().length;
    navigatePetPage(dir);
    syncWallpaperToPet();
    refreshPetInPlace(prevCount, petFirstPassWords().length);
    return;
  }
  if (petWallpaperTimer) { clearTimeout(petWallpaperTimer); petWallpaperTimer = null; }
  advancing = true;
  pushWallpaper(() => {
    if (!petVisible && !patrickVisible) startPet();
    else refreshPetInPlace(petWords.length, petFirstPassWords().length);
    finishWallpaperJob();
  });
}

/* 小词灵驱动的壁纸同步：点词立刻改小窗（调用方自己 refreshPetInPlace）。
 * 桌面 sips 最多约 1 秒一次，连点合并成一次，停手后再补一帧最终画面。
 * 与 runAdvance 共用 advancing，sips 本身再经 rasterizeSVG 串行。 */
const PET_WALLPAPER_MIN_MS = 1000;
let petWallpaperTimer = null;
let petWallpaperLastAt = 0;
let petWallpaperDirty = false;
let petWallpaperPending = false;
function syncWallpaperToPet() {
  if (!CFG.petWallpaperSync || !CFG.autoSetWallpaper) return;
  petWallpaperDirty = true;
  armPetWallpaperSync();
}
function armPetWallpaperSync() {
  if (advancing) { petWallpaperPending = true; return; }
  if (petWallpaperTimer) { clearTimeout(petWallpaperTimer); petWallpaperTimer = null; }
  const wait = Math.max(0, PET_WALLPAPER_MIN_MS - (Date.now() - petWallpaperLastAt));
  // setTimeout even for wait 0: the click handler queues the pet raster first.
  petWallpaperTimer = setTimeout(runPetWallpaperSync, wait);
  if (petWallpaperTimer.unref) petWallpaperTimer.unref();
}
function runPetWallpaperSync() {
  petWallpaperTimer = null;
  if (advancing) { petWallpaperPending = true; return; }
  if (!petWallpaperDirty && !petWallpaperPending) return;
  const hadPetSync = petWallpaperDirty || petWallpaperPending;
  petWallpaperDirty = false;
  petWallpaperPending = false;
  petWallpaperLastAt = Date.now();
  advancing = true;
  pushWallpaper(err => {
    if (err && hadPetSync) petWallpaperDirty = true;
    finishWallpaperJob();
  }, { force: hadPetSync });
}
function finishWallpaperJob() {
  advancing = false;
  if (pendingDir) { const d = pendingDir; pendingDir = 0; runAdvance(d); return; }
  if (petWallpaperDirty || petWallpaperPending) armPetWallpaperSync();
}
function enqueueWallpaper() {
  if (!CFG.autoSetWallpaper) return;
  if (advancing) { petWallpaperPending = true; return; }
  // Do not cancel a pending pet-click sync — interval refresh can wait.
  if (CFG.petWallpaperSync && (petWallpaperDirty || petWallpaperTimer)) {
    petWallpaperDirty = true;
    armPetWallpaperSync();
    return;
  }
  petWallpaperLastAt = Date.now();
  advancing = true;
  pushWallpaper(finishWallpaperJob);
}

/* ---------------- Apple Vision OCR (zero-dep, via JXA) ---------------- */
function ocrImage(pngPath, cb) {
  if (!isMac) return cb(new Error('OCR only on macOS'));
  const jxa = `
ObjC.import('Vision'); ObjC.import('Quartz');
function run(argv){
  var path = argv[0];
  var url = $.NSURL.fileURLWithPath(path);
  var img = $.CIImage.imageWithContentsOfURL(url);
  if (!img) return '';
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  req.recognitionLanguages = ['en-US','zh-Hans'];
  var handler = $.VNImageRequestHandler.alloc.initWithCIImageOptions(img, $());
  var ok = handler.performRequestsError([req], $());
  var out = [];
  var results = req.results;
  if (results){
    for (var i=0;i<results.count;i++){
      var obs = results.objectAtIndex(i);
      var cand = obs.topCandidates(1);
      if (cand && cand.count>0) out.push(ObjC.unwrap(cand.objectAtIndex(0).string));
    }
  }
  return out.join('\\n');
}`;
  execFile('osascript', ['-l', 'JavaScript', '-e', jxa, pngPath], { timeout: 30000 }, (err, stdout) => {
    if (err) return cb(err);
    cb(null, String(stdout || ''));
  });
}

/* ---------------- HTTP server: serve app + endpoints ---------------- */
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.csv': 'text/csv' };

function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end('Method Not Allowed'); return; }
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { res.writeHead(404); res.end('Not Found'); return; }
  if (decoded.includes('\0') || decoded.includes('\\')) { res.writeHead(404); res.end('Not Found'); return; }
  if (decoded === '/') decoded = '/index.html';
  const segments = decoded.split('/').filter(Boolean);
  // 根目录只放行白名单里的页面:站点首页 + AI 对话浮窗(WebView 加载)。
  const ROOT_PAGES = ['index.html', 'pet-chat.html', 'pet-sentence.html', 'pet-voices.html'];
  const direct = segments.length === 1 && ROOT_PAGES.includes(segments[0]);
  const allowed = segments.length >= 2 && ['css', 'js', 'data'].includes(segments[0])
    && !segments.some(segment => segment === '.' || segment === '..' || segment.startsWith('.'));
  if (!direct && !allowed) { res.writeHead(404); res.end('Not Found'); return; }
  // Keep new pages inside a directory copied by already-released updaters.
  const pagePath = decoded === '/pet-voices.html' ? 'assets/pet-voices.html' : segments[0];
  const file = direct ? path.resolve(ROOT, pagePath) : path.resolve(ROOT, '.' + decoded);
  const allowedRoot = direct ? ROOT : path.resolve(ROOT, segments[0]);
  const rootPage = direct ? path.join(ROOT, pagePath) : null;
  if (file !== rootPage && !file.startsWith(allowedRoot + path.sep)) { res.writeHead(404); res.end('Not Found'); return; }
  const ext = path.extname(file).toLowerCase();
  const allowedExt = direct ? ['.html']
    : segments[0] === 'css' ? ['.css', '.woff', '.woff2', '.png', '.svg']
    : segments[0] === 'js' ? ['.js'] : segments[0] === 'data' ? ['.json'] : ['.html'];
  if (!allowedExt.includes(ext)) { res.writeHead(404); res.end('Not Found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') res.end(); else res.end(data);
  });
}

function readBody(req, cb) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => cb(Buffer.concat(chunks)));
}
function trustedLocalMutation(req) {
  const source = req.headers.origin || req.headers.referer || '';
  if (!source) return true; // 原生 JXA 与本机 server.js 代理不带 Origin
  try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(source).hostname); }
  catch { return false; }
}
function localWebOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password) return '';
    return parsed.origin;
  } catch { return ''; }
}

function validatedAppPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !value.endsWith('.app')) return '';
  try {
    const app = fs.realpathSync(value);
    if (!app.endsWith('.app') || !fs.statSync(path.join(app, 'Contents/Resources/server.js')).isFile()) return '';
    fs.accessSync(path.join(app, 'Contents/MacOS/WordPaper'), fs.constants.X_OK);
    return app;
  } catch { return ''; }
}
function nativeAppPath() {
  return validatedAppPath(CFG.desktopAppPath)
    || validatedAppPath(process.env.WORDPAPER_NATIVE_APP_PATH)
    || (APP_MODE ? validatedAppPath(path.resolve(ROOT, '../..')) : '');
}
function openWorkspace(destination, callback = () => {}) {
  const app = nativeAppPath();
  if (!app && (CFG.desktopAppPath || process.env.WORDPAPER_NATIVE_APP_PATH || process.env.WORDPAPER_NATIVE_UI === '1' || APP_MODE)) {
    callback(new Error('找不到 WordPaper App，请从应用程序重新打开。'));
    return;
  }
  const args = app ? ['-a', app, 'wordpaper://open?path=' + encodeURIComponent(destination)]
    : [(localWebOrigin(CFG.webOrigin) || `http://localhost:${CFG.port}`) + destination];
  // Pin the receiving bundle: LaunchServices may know several old build copies.
  // Registered App navigation must never silently fall back to a browser.
  execFile('/usr/bin/open', args, error => callback(error, app ? 'app' : 'browser'));
}
function nativeLocalRequest(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && req.headers['x-wordpaper-local'] === '1' && !req.headers.origin && !req.headers.referer;
}

/* Same one-click-enable + standalone-zip endpoints as server.js, so the desktop
 * card buttons work whether the page is served from the main site (8770) or
 * from here (8771, the page the companion auto-opens). */
function serveCompanionZip(req, res) {
  const script = path.join(ROOT, 'scripts', 'package_companion.py');
  execFile('python3', [script], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('打包失败：' + (stderr || err.message)); }
    const zipPath = path.join(ROOT, 'scripts', '每日壁纸伴侣.zip');
    fs.readFile(zipPath, (e2, data) => {
      if (e2) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('读取安装包失败'); }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="daily-wallpaper-companion.zip"; filename*=UTF-8\'\'%E6%AF%8F%E6%97%A5%E5%A3%81%E7%BA%B8%E4%BC%B4%E4%BE%A3.zip',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
}

/* naive multipart/form-data parse (enough for a single file field) */
function parseMultipart(buf, boundary) {
  const s = buf.toString('binary');
  const parts = s.split('--' + boundary);
  for (const part of parts) {
    if (!part.includes('filename=')) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    let data = part.slice(headerEnd + 4);
    if (data.endsWith('\r\n')) data = data.slice(0, -2);
    return Buffer.from(data, 'binary');
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // The native launcher registers its actual bundle and selected server port,
  // including when it reuses an already-running companion. Browser pages must
  // not be able to retarget the machine's native workspace.
  if (url === '/desktop/register') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!nativeLocalRequest(req)) { res.writeHead(403); return res.end(); }
    return readBody(req, body => {
      let appPath, webOrigin;
      try {
        if (body.length > 16384) throw new Error('registration-too-large');
        const payload = JSON.parse(body.toString());
        appPath = validatedAppPath(payload.appPath);
        const target = new URL(payload.webOrigin);
        webOrigin = localWebOrigin(payload.webOrigin);
        if (!appPath || !webOrigin || !target.port || target.pathname !== '/' || target.search || target.hash) throw new Error('invalid-registration');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'invalid-registration' }));
      }
      const next = { ...CFG, desktopAppPath: appPath, webOrigin };
      const tmp = CONFIG_PATH + '.register-' + process.pid + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, CONFIG_PATH);
        Object.assign(CFG, next);
      } catch {
        try { fs.unlinkSync(tmp); } catch {}
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'registration-save-failed' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, nativeNavigation: 1 }));
    });
  }

  // OCR endpoint (browser posts an image -> Vision -> text)
  if (url === '/ocr.php') {
    if (req.method === 'HEAD') { res.writeHead(isMac ? 200 : 404); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    return readBody(req, body => {
      const boundary = (req.headers['content-type'] || '').split('boundary=')[1];
      const img = boundary ? parseMultipart(body, boundary) : body;
      if (!img) { res.writeHead(400); return res.end(JSON.stringify({ error: 'no image' })); }
      const tmp = path.join(os.tmpdir(), 'dw_ocr.png');
      fs.writeFileSync(tmp, img);
      ocrImage(tmp, (err, text) => {
        try { fs.unlinkSync(tmp); } catch {}
        if (err) { res.writeHead(500); return res.end(JSON.stringify({ error: err.message })); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text }));
      });
    });
  }

  // set-wallpaper endpoint (browser posts a rendered PNG -> set as desktop)
  if (url === '/set-wallpaper.php') {
    if (req.method === 'HEAD') { res.writeHead(isMac ? 200 : 404); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    return readBody(req, body => {
      const boundary = (req.headers['content-type'] || '').split('boundary=')[1];
      const img = boundary ? parseMultipart(body, boundary) : body;
      if (!img) { res.writeHead(400); return res.end(JSON.stringify({ error: 'no image' })); }
      const out = freshWallpaperFile('custom');
      try { wallpaperFiles.writeBufferInPlace(fs, out, img); }
      catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message || 'wallpaper-write-failed' }));
      }
      setMacWallpaper(out, err => {
        cleanupOldWallpapers('custom', out);
        res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(err ? { error: err.message } : { ok: true }));
      });
    });
  }

  // 网页把当前词库、每组数量和初筛结果同步给伴侣；各词库自己的页历史互不覆盖。
  if (url === '/pet-sync.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    syncQuizUser(req);
    return readBody(req, body => {
      let payload;
      try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'invalid json' })); }
      const library = String(payload.library || '');
      if (!library) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, skipped: true, reason: 'unknown-library' }));
      }
      if (library === 'custom') {
        if (!saveCustomWords(payload.customWords)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'custom-library-write-failed' }));
        }
      } else if (!loadWords(library).length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, skipped: true, reason: 'unknown-library' }));
      }
      const oldDeck = state.petDecksByLibrary[library];
      const oldPage = oldDeck && oldDeck.pages && oldDeck.pages[oldDeck.index];
      const beforeKeys = (oldPage && oldPage.words || []).map(petWordKey);
      const changedLibrary = CFG.library !== library;
      CFG.library = library;
      const webOrigin = nativeAppPath() ? '' : localWebOrigin(payload.webOrigin);
      const changedWebOrigin = Boolean(webOrigin && webOrigin !== CFG.webOrigin);
      if (webOrigin) CFG.webOrigin = webOrigin;
      const requestedUITheme = String(payload.uiTheme || '');
      const changedUITheme = PET_UI_THEMES.has(requestedUITheme) && requestedUITheme !== CFG.uiTheme;
      if (PET_UI_THEMES.has(requestedUITheme)) CFG.uiTheme = requestedUITheme;
      const requestedWallpaperTheme = String(payload.wallpaperTheme || '');
      const changedWallpaperTheme = Object.prototype.hasOwnProperty.call(THEMES, requestedWallpaperTheme) && requestedWallpaperTheme !== CFG.theme;
      if (Object.prototype.hasOwnProperty.call(THEMES, requestedWallpaperTheme)) CFG.theme = requestedWallpaperTheme;
      const requestedPattern = String(payload.bgPattern || '');
      const allowedPatterns = new Set(['none', 'soft', 'dots', 'grid', 'diag', 'waves', 'blobs']);
      const changedPattern = allowedPatterns.has(requestedPattern) && requestedPattern !== CFG.bgPattern;
      if (allowedPatterns.has(requestedPattern)) CFG.bgPattern = requestedPattern;
      // 版面位置(锚点+分数偏移):网页拖拽后同步过来,小词灵翻页/点词重渲壁纸时保持布局。
      const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      const readOff = (o) => {
        if (!o || typeof o !== 'object') return null;
        const x = numOrNull(o.x), y = numOrNull(o.y);
        if (x === null && y === null) return null;
        return {
          x: Math.max(-0.5, Math.min(0.5, x === null ? 0 : x)),
          y: Math.max(-1.0, Math.min(1.0, y === null ? 0 : y)),
        };
      };
      const sameOff = (a, b) => normOff(a).x === normOff(b).x && normOff(a).y === normOff(b).y;
      let changedLayout = false;
      const reqAnchorWords = String(payload.anchorWords || '');
      if (['top', 'center', 'bottom'].includes(reqAnchorWords) && reqAnchorWords !== CFG.anchorWords) { CFG.anchorWords = reqAnchorWords; changedLayout = true; }
      const reqAnchorRem = String(payload.anchorReminders || '');
      if (['top', 'center', 'bottom'].includes(reqAnchorRem) && reqAnchorRem !== CFG.anchorReminders) { CFG.anchorReminders = reqAnchorRem; changedLayout = true; }
      const reqOffWords = readOff(payload.offWords);
      if (reqOffWords && !sameOff(reqOffWords, CFG.offWords)) { CFG.offWords = reqOffWords; changedLayout = true; }
      const reqOffRem = readOff(payload.offReminders);
      if (reqOffRem && !sameOff(reqOffRem, CFG.offReminders)) { CFG.offReminders = reqOffRem; changedLayout = true; }
      // 换词特效:网页下拉选择,pet-sync 同步过来。特效值嵌在小窗 JXA 里,变了必须重建
      // 窗口才生效(否则窗口还按创建时的旧特效跑 → 用户感觉“切换没生效”)。
      const allowedTransitions = new Set(['dissolve', 'pop', 'dissolve-pop', 'none']);
      const requestedTransition = String(payload.petTransition || '');
      const changedTransition = allowedTransitions.has(requestedTransition) && requestedTransition !== CFG.petTransition;
      if (allowedTransitions.has(requestedTransition)) CFG.petTransition = requestedTransition;
      // 壁纸/预览同步总闸：网页推送为准。关→壁纸回退独立随机、预览不跟随。
      if (typeof payload.petWallpaperSync === 'boolean') CFG.petWallpaperSync = payload.petWallpaperSync;
      CFG.wordsPerGroup = Math.max(1, Math.min(36, Number(payload.wordsPerGroup) || CFG.wordsPerGroup || 6));
      state.petKnownByLibrary[library] = Array.isArray(payload.knownWords) ? payload.knownWords.map(String).slice(0, 10000) : [];
      const deck = ensurePetDeck(library);
      refillPetPage(library, deck, deck.pages[deck.index]);
      const afterKeys = (deck.pages[deck.index].words || []).map(petWordKey);
      const changedPageKeys = beforeKeys.length !== afterKeys.length || beforeKeys.some((key, index) => key !== afterKeys[index]);
      if (changedPageKeys) bumpPetWordEpoch();
      saveConfig(); saveState();
      const result = { ok: true, library, uiTheme: CFG.uiTheme, page: deck.index + 1, words: deck.pages[deck.index].words.length, wordEpoch: state.petWordEpoch };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      if ((petVisible || patrickVisible) && (changedLibrary || changedWebOrigin || changedPageKeys || changedTransition || payload.refresh === true)) startPet();
      else if (patrickVisible && (changedPageKeys || changedLibrary)) pushPatrickCmd({ cmd: 'words', words: petWordsForPatrick(), keys: currentPetKeys(), exampleLines: petWordsForPatrick().map(x => x.example).filter(Boolean) });
      else if (petVisible && changedUITheme) {
        const size = resolvePetSize();
        renderPetPng(size.w, size.h);
      }
      // 页词变了或主题/纹理/版面位置变了都要重推壁纸（同步开启时页词即壁纸词源）。
      if (changedPageKeys) syncWallpaperToPet();
      else if ((changedWallpaperTheme || changedPattern || changedLayout) && CFG.autoSetWallpaper) enqueueWallpaper();
    });
  }

  // 小词灵点击词卡：登记首轮、立即补入一个新词；分组更新与同步事件一次原子保存。
  if (url === '/remember.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    let index = -1, expectedKey = '';
    try { const q = new URL(req.url, 'http://localhost').searchParams; index = parseInt(q.get('i') || '-1', 10); expectedKey = q.get('key') || ''; } catch {}
    const word = petWords[index];
    if (!word) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'word not found' })); }
    if (!expectedKey || expectedKey !== petWordKey(word)) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, stale: true, error: 'word changed' })); }
    const prevCount = petFirstPassWords().length;   // 点击前的可见词数（补位前）
    const firstPass = completePetFirstPass(word);
    if (firstPass.duplicate) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, duplicate: true }));
    }
    const event = firstPass.event;
    const respond = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, event, page: firstPass.deck.index + 1, visibleWords: firstPass.page.words.length, refilled: event.refilled, keys: currentPetKeys(), wordEpoch: state.petWordEpoch }));
    };
    // 丝滑刷新：原位重渲 PNG，窗口原地换图不闪不动；仅词数变化时才重启窗口。
    // 同步开启时壁纸跟着小词灵换（throttle 防连击狂刷）。
    syncWallpaperToPet();
    return refreshPetInPlace(prevCount, firstPass.page.words.length, respond);
  }
  if (url === '/pet-page.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    let direction = 1;
    try { direction = Number(new URL(req.url, 'http://localhost').searchParams.get('dir')) < 0 ? -1 : 1; } catch {}
    const prevCount = petFirstPassWords().length;   // 翻页前的可见词数
    const result = navigatePetPage(direction);
    const respond = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, ...result, keys: currentPetKeys(), wordEpoch: state.petWordEpoch })); };
    // 翻页同样丝滑：原位换图，仅当新页词数不同（如最后一页没补满）才重启窗口。
    // 同步开启时壁纸跟着小词灵换。
    syncWallpaperToPet();
    return refreshPetInPlace(prevCount, result.words, respond);
  }
  if (url === '/pet-memory-events.json') {
    let after = 0, stream = '';
    try { const q = new URL(req.url, 'http://localhost').searchParams; after = Math.max(0, parseInt(q.get('after') || '0', 10) || 0); stream = q.get('stream') || ''; } catch {}
    const firstId = state.petMemoryEvents.length ? state.petMemoryEvents[0].id : (state.petMemorySeq || 0) + 1;
    const lastId = state.petMemorySeq || 0;
    const reset = stream !== state.petMemoryStreamId || after > lastId || (after > 0 && after < firstId - 1);
    // reset 时也回传事件(after=0 首拉 = 全量):快照只含首轮 learned,quiz/复习事件
    // 不在其中 —— 丢了它们网页记忆本就漏记抽查结果。app 端 snapshot.concat(events) 已幂等。
    const events = state.petMemoryEvents.filter(event => event.id > after);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ streamId: state.petMemoryStreamId, firstId, lastId, reset, events, snapshot: reset ? learnedSnapshot() : undefined }));
  }
  // 网页轮询：小词灵「当前页词」+ 代际。点词/翻页/补位 bump epoch，网页据此对齐预览。
  // 派大星:优先朗读可见题目;quizId 拒绝已被切走的题目。仅本机回环可触发。
  if (url === '/pet-voices.json') {
    if(req.method!=='GET'){res.writeHead(405);return res.end();}
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    return res.end(JSON.stringify({ok:true,voices:speechModule.VOICES,selected:selectedVoice().id,dark:petSkin(CFG.uiTheme).dark===true}));
  }
  if (url === '/pet-voice.php' || url === '/pet-voice-preview.php') {
    if(req.method!=='POST'){res.writeHead(405);return res.end();}
    if(!trustedLocalMutation(req)){res.writeHead(403);return res.end();}
    const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    return readBody(req,body=>{
      let payload;try{payload=JSON.parse(body.toString());}catch{return reply(400,{ok:false,error:'invalid-request'});}
      if(url==='/pet-voice-preview.php' && payload?.action==='stop') {
        if(payload.id===voicePreviewId){voicePreviewUntil=0;voicePreviewId='';}
        return reply(200,{ok:true});
      }
      const voice=speechModule.voiceById(payload?.voiceId);
      if(!voice)return reply(400,{ok:false,error:'invalid-voice'});
      if(url==='/pet-voice.php') {
        const previous=CFG.speechVoice;CFG.speechVoice=voice.id;
        if(!saveConfig()){CFG.speechVoice=previous;return reply(500,{ok:false,error:'保存失败，请重试'});}
        ttsStopNow();voicePreviewUntil=0;voicePreviewId='';
        return reply(200,{ok:true,selected:voice.id});
      }
      ttsStopNow();
      const id=require('crypto').randomBytes(18).toString('hex');voicePreviewId=id;voicePreviewUntil=Date.now()+60000;
      res.on('close',()=>{if(!res.writableEnded && voicePreviewId===id){voicePreviewUntil=0;voicePreviewId='';}});
      for(const [key,clip] of voicePreviewClips)if(clip.expires<Date.now())voicePreviewClips.delete(key);
      while(voicePreviewClips.size>=8)voicePreviewClips.delete(voicePreviewClips.keys().next().value);
      speechAudio.prepare(speechModule.SAMPLE,voice.id,(err,audio)=>{
        if(voicePreviewId!==id)return reply(409,{ok:false,error:'preview-replaced'});
        if(err){voicePreviewUntil=0;voicePreviewId='';return reply(503,{ok:false,error:'声音暂不可用'});}
        voicePreviewClips.set(id,{...audio,expires:Date.now()+600000});
        reply(200,{ok:true,id,url:'/pet-voice-audio.php?id='+id,cues:audio.cues,fallback:audio.fallback});
      });
    });
  }
  if (url === '/pet-voice-audio.php') {
    if(req.method!=='GET' && req.method!=='HEAD'){res.writeHead(405);return res.end();}
    return serveVoicePreview(req,res,new URL(req.url,'http://localhost').searchParams.get('id'));
  }
  if (url === '/pet-speak.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    let index = 0;
    try { const q = new URL(req.url, 'http://localhost').searchParams; index = parseInt(q.get('i') || '0', 10) || 0; } catch {}
    return readBody(req, body => {
      let payload = {};
      try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch {}
      const result = patrickSpeakWord(index, payload.quizId);
      res.writeHead(result.error === 'stale-quiz' ? 409 : 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    });
  }
  // 图片发布且气泡完成入场后才开始音频,不靠估算时长决定收起。
  if (url === '/pet-speak-shown.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    return readBody(req, body => {
      let payload = {};
      try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch {}
      const spoken = startSpeakCardAudio(payload.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, spoken }));
    });
  }
  if (url === '/pet-speak-finished.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    return readBody(req,body=>{
      let payload={}; try { payload=JSON.parse(body.toString('utf8') || '{}') || {}; } catch {}
      const accepted=completeSpeakPart(payload.id,payload.part,payload.error===true);
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,accepted}));
    });
  }
  // 开关 AI 对话浮窗(点击派大星 / 菜单栏 / 网页都能调)
  if (url === '/pet-chat-window.php') {
    console.error('[companion] chat-window 请求到达:', req.url);
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    let action = 'toggle';
    try { action = new URL(req.url, 'http://localhost').searchParams.get('action') || 'toggle'; } catch {}
    if (action === 'close') { stopChatWindow(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, open: false })); }
    if (action === 'open') {
      const r = startChatWindow();
      console.error('[companion] startChatWindow ->', JSON.stringify(r));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(Object.assign({ open: true }, r)));
    }
    if (chatWinChild) { stopChatWindow(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, open: false })); }
    const r = startChatWindow();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(Object.assign({ open: true }, r)));
  }
  // 抽查卡真正滑入上屏 → 这时才朗读考题词(只有这一个词,其它一律不响)。
  if (url === '/pet-quiz-shown.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    const q = patrickQuizState;
    if (!q || !patrickVisible || speakCardState || Date.now()<voicePreviewUntil) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, spoken: false })); }
    const word = q.word.word;
    const speechGeneration = ttsGen;
    // 到点播报:先让派大星喊一句「该复习了」,再念考题词(卡片此刻正印着它)。
    // 用户要的「到点了直接弹出来 + 播报」就是这条。
    pushPatrickCmd({ cmd: 'bubble', lines: [{ text: '⏰ 到点啦，考你一个词～', size: 11, bold: true }], ms: 3200 });
    playSfx('correct');
    // 卡片已上屏 → 现在正是出声的时刻。先确保音频就绪(命中缓存则同步返回),
    // 就绪后立刻入队;ttsSpeak 会直接从缓存 afplay,音画同步。
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, spoken: true, word }));
    ttsPrewarm(word, () => {
      if (ttsGen !== speechGeneration || speakCardState || !patrickQuizState || patrickQuizState.word !== q.word) return;   // 已作答/换题/手动朗读
      ttsQueue.length = 0;   // 队列里只许有它
      ttsEnqueue([{ text: word, voice: PATRICK_TTS.enVoice, rate: PATRICK_TTS.enRate }], { allow: [word] });
    });
    return;
  }
  // 造句练习:开/关小窗;取当前考题词(网页用它渲染标题);提交句子交给 DeepSeek 批改。
  if (url === '/pet-sentence-window.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    let action = 'toggle';
    try { action = new URL(req.url, 'http://localhost').searchParams.get('action') || 'toggle'; } catch {}
    if (action === 'close') { stopSentenceWindow(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, open: false })); }
    // 只有刚作答过的题才能造句(还没答题 → 没有题可造)
    const lq = state.lastQuiz;
    if (!lq || !lq.word) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, open: false, error: '还没有答过题' }));
    }
    if (action === 'open' || (action === 'toggle' && !sentenceWinChild)) {
      // 造句期间卡片要留在屏上当参考,而且绝不能出下一题。
      quizResultUntil = 0;          // 卡片不再按 8s 计时撤除(改由关窗流程处理)
      // 先立刻 spawn 窗口(感知优先);输入法切换并行做 —— 两次 osascript 启动
      // 各花 300–800ms,放在窗口前会白白挡住开窗。
      const r = startSentenceWindow();
      if (!imeRestoreTo) {
        currentInputSource(cur => { imeRestoreTo = cur || ''; });
        selectInputSource(EN_INPUT_SOURCE);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(Object.assign({ open: true, word: lq.word }, r)));
    }
    stopSentenceWindow();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, open: false }));
  }
  // 造句窗请求把输入法切成英文(页面 focus 时调用)。只切英文,不负责切回 ——
  // 切回由关窗流程统一处理,避免页面反复调用来回跳。
  if (url === '/pet-ime.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    let lang = 'en';
    try { lang = new URL(req.url, 'http://localhost').searchParams.get('lang') || 'en'; } catch {}
    if (!imeRestoreTo) currentInputSource(cur => { imeRestoreTo = cur || ''; });
    if (lang === 'en') selectInputSource(EN_INPUT_SOURCE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, lang }));
  }
  /* 目标达成庆祝:派大星连跳+撒星星+欢呼音效。网页达标打卡时调。 */
  if (url === '/pet-celebrate.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    if (patrickVisible) {
      pushPatrickCmd({ cmd: 'celebrate', ms: 3500 });
      playSfx('correct');     // Glass + Hero,清脆的胜利感
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, celebrated: patrickVisible }));
  }
  /* 造句错题集:列表(GET) / 标星、删除、备注(POST) / 导出(md|json)。
   * 只收「有值得整理之处」的句子(非满分或没用上词),满分不入库。 */
  if (url === '/pet-sentence-notes.json') {
    const kind = (() => { try { return new URL(req.url, 'http://localhost').searchParams.get('kind') || ''; } catch { return ''; } })();
    let notes = state.sentenceNotes || [];
    if (kind) notes = notes.filter(n => n.kind === kind);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, notes, total: (state.sentenceNotes || []).length }));
  }
  if (url === '/pet-sentence-notes.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    return readBody(req, body => {
      let payload = {};
      try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch {}
      const reply = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const list = state.sentenceNotes || (state.sentenceNotes = []);
      const id = Number(payload.id) || 0;
      const note = list.find(n => Number(n.id) === id);
      if (payload.action === 'star') {
        if (!note) return reply({ ok: false, error: '条目不存在' });
        note.starred = payload.starred === undefined ? !note.starred : Boolean(payload.starred);
        saveState();
        return reply({ ok: true, id: note.id, starred: note.starred });
      }
      if (payload.action === 'delete') {
        const idx = list.findIndex(n => Number(n.id) === id);
        if (idx < 0) return reply({ ok: false, error: '条目不存在' });
        list.splice(idx, 1);
        saveState();
        return reply({ ok: true });
      }
      if (payload.action === 'note') {
        if (!note) return reply({ ok: false, error: '条目不存在' });
        note.memo = String(payload.memo || '').slice(0, 500);
        saveState();
        return reply({ ok: true, id: note.id, memo: note.memo });
      }
      return reply({ ok: false, error: 'action must be star|delete|note' });
    });
  }
  /* 错题集导出:md(整理成复习清单) / json(可再处理)。默认全部,?kind= 过滤,?starred=1 只要星标。 */
  if (url === '/pet-sentence-notes-export') {
    let kind = '', starredOnly = false, format = 'md';
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      kind = q.get('kind') || '';
      starredOnly = q.get('starred') === '1';
      format = (q.get('format') || 'md').toLowerCase();
    } catch {}
    let notes = (state.sentenceNotes || []).slice();
    if (kind) notes = notes.filter(n => n.kind === kind);
    if (starredOnly) notes = notes.filter(n => n.starred);
    notes.sort((a, b) => (b.at || 0) - (a.at || 0));
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="wordpaper-sentence-notes-${stamp}.json"`,
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify({ format: 'wordpaper-sentence-notes', schemaVersion: 1, exportedAt: new Date().toISOString(), notes }, null, 2));
    }
    const KIND_LABEL = { error: '❌ 用法/语法问题', awkward: '⚠️ 不够地道', unused: '🚫 没用上这个词' };
    const lines = ['# 造句错题集', '', `> 导出于 ${new Date().toLocaleString('zh-CN')} · 共 ${notes.length} 条`, ''];
    notes.forEach((n, i) => {
      const when = n.at ? new Date(n.at).toLocaleString('zh-CN') : '';
      lines.push(`## ${i + 1}. ${n.word}${n.starred ? ' ⭐' : ''}`);
      lines.push('');
      lines.push(`- ${KIND_LABEL[n.kind] || n.kind}${n.score ? ` · ${n.score}/5` : ''} · ${when}`);
      if (n.meaning) lines.push(`- 释义：${n.pos ? n.pos + ' ' : ''}${n.meaning}`);
      lines.push('');
      lines.push(`**我写的**：${n.mine}`);
      if (n.fixed) lines.push(`**改成**：${n.fixed}`);
      if (n.feedback) lines.push(`**点评**：${n.feedback}`);
      if (n.example) lines.push(`**例句**：${n.example.replace(/\n/g, ' / ')}`);
      if (n.memo) lines.push(`**我的笔记**：${n.memo}`);
      lines.push('');
    });
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="wordpaper-sentence-notes-${stamp}.md"`,
      'Cache-Control': 'no-store',
    });
    res.end(lines.join('\n'));
    return;
  }
  // 造句窗的数据源:当前词 + 本次对错
  if (url === '/pet-sentence.json') {
    const lq = state.lastQuiz || null;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: !!lq, quiz: lq }));
  }
  // 提交造句 → DeepSeek 批改。返回 { ok, feedback, fixed, score }。
  if (url === '/pet-sentence.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    return readBody(req, body => {
      let payload = {};
      try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch {}
      const lq = state.lastQuiz || {};
      const word = String(lq.word || '');
      const sentence = String(payload.sentence || '').trim();
      if (!word) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: '还没有答过题' })); }
      if (!sentence) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: '句子是空的' })); }
      if (sentence.length > 400) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: '句子太长了（400 字符以内）' })); }
      // 要求模型只回 JSON,前端好解析;判分维度固定,方便稳定显示。
      const prompt = [
        '你是英语老师,学生在用单词「' + word + '」(' + (lq.meaning || '') + ')造句子。',
        '请批改这句:' + sentence,
        '',
        '只回一个 JSON 对象,不要任何解释文字、不要 Markdown 代码块,格式:',
        '{"ok": true, "score": 1-5 的整数, "used": 学生是否真的用了这个词(true/false),',
        ' "fixed": "改好的自然英文句子", "feedback": "一两句中文点评,指出问题并说怎么改",',
        ' "example": "再用这个词造一个新的英文例句(不要和学生写的一样),中文翻译另起一行" }',
        '判断标准:语法是否正确、这个词用得是否地道、句子是否自然。如果学生用了别的形式(如复数/时态变化)也算 used=true。',
      ].join(String.fromCharCode(10));
      askMagpie(prompt, reply => {
        const text = String(reply || '').trim();
        if (!text) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'DeepSeek 没有回应（可能被限流，稍后再试）' }));
        }
        // 模型有时会包 ```json ``` 或加前后缀 → 截取第一个 { 到最后一个 }
        let parsed = null;
        try {
          const a = text.indexOf('{'), b = text.lastIndexOf('}');
          if (a >= 0 && b > a) parsed = JSON.parse(text.slice(a, b + 1));
        } catch {}
        const score = parsed && Number.isFinite(Number(parsed.score)) ? Math.max(1, Math.min(5, Math.round(Number(parsed.score)))) : null;
        // 例句:先用本地词典里这个词的原句(离线、可靠),再补模型新造的一句。
        let dictExample = '';
        try {
          const ex = exampleForWord(lq.library || CFG.library, { word });
          if (ex && ex.en) dictExample = ex.zh ? ex.en + '\n' + ex.zh : ex.en;
        } catch {}
        const modelExample = parsed && parsed.example ? String(parsed.example).trim() : '';
        const result = {
          ok: true, word, sentence,
          used: parsed ? parsed.used !== false : null,
          score,
          fixed: parsed && parsed.fixed ? String(parsed.fixed) : '',
          feedback: parsed && parsed.feedback ? String(parsed.feedback) : text,
          // 例句给两条:词典原句(权威)+ DeepSeek 新造(贴近当前语境)
          example: dictExample || modelExample,
          example2: dictExample && modelExample ? modelExample : '',
        };
        // 自动收录到「造句错题集」:只要这次不是满分(有错 / 不够地道 / 没用上词),
        // 就把原句、改好的句子、点评、例句一起存起来,方便日后集中复习。
        // 满分的不收录(没有值得整理的点),避免错题集被冲淡。
        const noteworthy = (score != null && score < 5) || result.used === false;
        if (noteworthy) {
          state.sentenceNoteSeq = Math.max(0, Number(state.sentenceNoteSeq) || 0) + 1;
          state.sentenceNotes.unshift({
            id: state.sentenceNoteSeq,
            at: Date.now(),
            word,
            meaning: lq.meaning || '',
            pos: lq.pos || '',
            library: lq.library || CFG.library,
            // 1 = 语法/用法错误(type: 'error'),2~4 = 不够地道('awkward'),未用上词('unused')
            kind: result.used === false ? 'unused' : (score <= 2 ? 'error' : 'awkward'),
            score,
            used: result.used,
            mine: sentence,
            fixed: result.fixed || '',
            feedback: result.feedback || '',
            example: result.example || '',
            example2: result.example2 || '',
            starred: false,
          });
          // 上限 500 条,超出丢最旧的;星标的不参与淘汰
          if (state.sentenceNotes.length > 500) {
            const starred = state.sentenceNotes.filter(n => n.starred);
            const rest = state.sentenceNotes.filter(n => !n.starred).slice(0, Math.max(0, 500 - starred.length));
            state.sentenceNotes = rest.concat(starred).sort((a, b) => b.at - a.at);
          }
          saveState();
        }
        // 记进事件流,网页记忆本能看到「造句」这条练习记录。
        state.petMemorySeq = Math.max(0, Number(state.petMemorySeq) || 0) + 1;
        state.petMemoryEvents.push({
          id: state.petMemorySeq, at: Date.now(), library: lq.library || CFG.library,
          word: { word, meaning: lq.meaning || '' }, action: 'sentence',
          score, sentence: sentence.slice(0, 200), correct: null, page: 0, refilled: false,
        });
        state.petMemoryEvents = state.petMemoryEvents.slice(-160);
        saveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });
  }
  // 多轮 AI 对话(常驻浮窗用)
  if (url === '/pet-chat.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    return readBody(req, body => {
      let payload = {};
      try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch {}
      if (payload.reset) {
        const sess = activeChatSession(false);
        if (sess) { sess.messages = []; sess.updatedAt = Date.now(); saveState(); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, reset: true }));
      }
      const msg = String(payload.message || '').trim();
      if (!msg) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'empty message' })); }
      chatWithMagpie(msg, (reply, err) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply ? { ok: true, reply } : { ok: false, error: err || 'no-reply' }));
      });
    });
  }
  // 对话历史(浮窗打开时回填)
  if (url === '/pet-chat-history.json') {
    // 可选 ?session=<id> 取指定会话;不带则取当前会话。
    let wantId = '';
    try { wantId = new URL(req.url, 'http://localhost').searchParams.get('session') || ''; } catch {}
    const list = chatSessions();
    let sess = wantId ? list.find(x => x.id === wantId) : activeChatSession(false);
    // 会话被删/不存在 → 退回最近更新的那个
    if (!sess && list.length) sess = list.slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
    if (sess && sess.id !== state.chatSessionId) { state.chatSessionId = sess.id; saveState(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      sessionId: sess ? sess.id : '',
      sessionTitle: sess ? (sess.title || chatTitleFrom(sess.messages)) : '',
      history: sess && Array.isArray(sess.messages) ? sess.messages : [],
      sessions: list.slice()
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        .map(chatSessionSummary),
      // 提问建议:按当前页的词生成(点一下就填进输入框,省得自己组织问题)
      suggestions: chatSuggestions(),
    }));
  }
  /* 对话管理:新建 / 切换 / 重命名 / 删除 / 导出。全部仅本机回环 + Origin 校验。 */
  if (url === '/pet-chat-session.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    return readBody(req, body => {
      let payload = {};
      try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch {}
      const action = String(payload.action || '');
      const list = chatSessions();
      const reply = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (action === 'new') {
        // 必须**新建**一条,不能复用当前会话:复用会把正在聊的内容清空
        // (用户点「新对话」的预期是并存,不是销毁旧对话)。
        // 例外:当前会话本来就是空的新对话 → 直接复用它,避免刷出一堆空条目。
        const cur = activeChatSession(false);
        if (cur && Array.isArray(cur.messages) && cur.messages.length === 0) {
          cur.title = '新对话';
          cur.createdAt = cur.updatedAt = Date.now();
          state.chatSessionId = cur.id;
          saveState();
          return reply({ ok: true, sessionId: cur.id, sessions: list.map(chatSessionSummary), reused: true });
        }
        const sess = {
          id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [],
        };
        list.push(sess);
        state.chatSessionId = sess.id;
        trimChatSessions();
        saveState();
        return reply({ ok: true, sessionId: sess.id, sessions: list.map(chatSessionSummary) });
      }
      if (action === 'select') {
        const id = String(payload.id || '');
        const sess = list.find(x => x.id === id);
        if (!sess) return reply({ ok: false, error: '会话不存在' });
        state.chatSessionId = id;
        saveState();
        return reply({ ok: true, sessionId: id, sessionTitle: sess.title || chatTitleFrom(sess.messages), history: sess.messages || [] });
      }
      if (action === 'rename') {
        const sess = list.find(x => x.id === String(payload.id || ''));
        if (!sess) return reply({ ok: false, error: '会话不存在' });
        const title = String(payload.title || '').trim().slice(0, 60);
        if (!title) return reply({ ok: false, error: '标题不能为空' });
        sess.title = title;
        sess.updatedAt = Date.now();
        saveState();
        return reply({ ok: true, id: sess.id, title });
      }
      if (action === 'delete') {
        const id = String(payload.id || '');
        const idx = list.findIndex(x => x.id === id);
        if (idx < 0) return reply({ ok: false, error: '会话不存在' });
        list.splice(idx, 1);
        if (state.chatSessionId === id) {
          const next = list.slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
          state.chatSessionId = next ? next.id : '';
        }
        saveState();
        return reply({ ok: true, sessions: list.map(chatSessionSummary), sessionId: state.chatSessionId || '' });
      }
      if (action === 'clear') {
        // 只清空当前会话的消息,保留会话本身(等价于「清屏重来」)
        const sess = activeChatSession(false);
        if (sess) { sess.messages = []; sess.updatedAt = Date.now(); saveState(); }
        return reply({ ok: true });
      }
      return reply({ ok: false, error: 'action must be new|select|rename|delete|clear' });
    });
  }
  /* 导出对话:md(默认,好读)或 json(完整)。?id=<sessionId> 导单个,不带导全部。 */
  if (url === '/pet-chat-export') {
    const list = chatSessions();
    let wantId = '', format = 'md';
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      wantId = q.get('id') || '';
      format = (q.get('format') || 'md').toLowerCase();
    } catch {}
    const picked = wantId ? list.filter(x => x.id === wantId) : list.slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    if (!picked.length) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '没有可导出的对话' })); }
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      const data = { format: 'wordpaper-chat', schemaVersion: 1, exportedAt: new Date().toISOString(), sessions: picked };
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="wordpaper-chat-${stamp}.json"`,
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify(data, null, 2));
    }
    const md = chatExportMarkdown(picked);
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="wordpaper-chat-${stamp}.md"`,
      'Cache-Control': 'no-store',
    });
    res.end(md);
    return;
  }
  // 问 DeepSeek(本地 magpie)一个关于当前词的问题,回答显示在气泡里
  if (url === '/pet-ask.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    return readBody(req, body => {
      let payload = {};
      try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch {}
      const words = petFirstPassWords();
      const word = payload.word || (words[payload.index || 0] && words[payload.index || 0].word) || '';
      if (payload.clear) ttsClear();     // 提问时别再念旧词
      const question = String(payload.question || '').trim()
        || (word ? `用简单的话讲讲 "${word}" 这个词,怎么记、常见搭配是什么` : '');
      if (!question) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'empty question' })); }
      askMagpie(question, answer => {
        const text = String(answer || '').trim();
        if (text) {
          answerCardState = { word, answer: text, at: Date.now() };
          renderAnswerCard();
          pushPatrickCmd({ cmd: 'answer-card', ms: 15000 });
          // 不再自动朗读:用户没要求,且容易和卡片上的词不一致。
        } else {
          pushPatrickCmd({ cmd: 'bubble', lines: [{ text: '派大星想不出来…网络不太好', size: 11 }], ms: 6000 });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: Boolean(text), answer: text, word }));
      });
    });
  }
  // 形态切换:card ⇄ patrick(卡片 ⭐ / 派大星菜单 / 网页 / 菜单栏共用)
  if (url === '/pet-mode.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    let mode = '';
    try { mode = new URL(req.url, 'http://localhost').searchParams.get('mode') || ''; } catch {}
    if (!PET_MODES.has(mode)) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'mode must be card|patrick' })); }
    // 同步 POST:切换完成(窗口已重建)才返回,调用方(旧窗口)随后自毁不闪烁。
    setPetMode(mode, (err) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(err ? { ok: false } : { ok: true, mode: CFG.petMode }));
    });
    return;
  }
  // 派大星窗轮询:新命令(seq 之后) + 当前页词快照
  if (url === '/pet-patrick.json') {
    let after = 0;
    try { after = Math.max(0, parseInt(new URL(req.url, 'http://localhost').searchParams.get('after') || '0', 10) || 0); } catch {}
    const commands = patrickCmds.filter(c => c.seq > after);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    // quizGeom:当前抽查卡的点击命中区(按内容算的),子窗拿它调窗口高 + 做行命中。
    return res.end(JSON.stringify({ ok: true, seq: patrickCmdSeq, commands, quizGeom: (displayedQuiz && displayedQuiz.geom) || null, idle: patrickIdleContext() }));
  }
  // 抽查:网页把到期词推来 → 派大星弹 4 选 1 抽查卡;作答落回 petMemoryEvents。
  if (url === '/pet-quiz.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!trustedLocalMutation(req)) { res.writeHead(403); return res.end(); }
    return readBody(req, body => {
      let payload;
      try { payload = JSON.parse(body.toString('utf8') || '{}'); } catch { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'invalid json' })); }
      const action = String(payload.action || '');
      if (payload.quizId && action !== 'offer' && (!displayedQuiz || payload.quizId !== displayedQuiz.id)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'stale-quiz' }));
      }
      if (action === 'offer') {
        if (!featureOn('betaPetQuiz')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, offered: false, reason: 'feature-off' })); }
        syncQuizUser(req);
        const library = String(payload.library || CFG.library);
        let words = Array.isArray(payload.words) ? payload.words.filter(w => w && w.word && w.meaning) : [];
        let userId = null;
        const db = openSrsDb();
        try {
          userId = db && activeUserId(db);
          if (userId) {
            words = refreshQuizCandidates(db, userId, library, words);
          }
        } finally { if (db) db.close(); }
        if (!words.length) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, offered: false, reason: 'no-due-words' })); }
        const quizGateOpen = patrickVisible || process.env.WORDPAPER_TEST_MODE === '1';
        if (CFG.petMode !== 'patrick' || !quizGateOpen) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, offered: false, reason: 'patrick-not-visible' })); }
        if (patrickQuizState && patrickQuizState.category !== 'review' && words.some(isQuizReviewDue) && !sentenceWinChild) {
          clearQuizCard(); pendingQuiz = null;
        }
        // 忙(已有题/正在看结果/正在造句)→ 排队,别打断用户;空了立刻补出。
        const busy = quizBusyReason();
        if (busy) {
          queueQuiz(words.slice(0, 8), library, userId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, offered: false, queued: true, reason: busy }));
        }
        const offered = offerQuiz(words.slice(0, 8), library, userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, offered, word: patrickQuizState && patrickQuizState.word.word }));
      }
      if (action === 'expand' || action === 'collapse') {
        const q = displayedQuiz;
        if (!q) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'no-quiz' })); }
        q.expand = action === 'expand';
        // Once the user reads a result's full text, leave it until Next/Sentence.
        if (q.pickedIndex >= 0) { q.hold = true; quizResultUntil = Number.MAX_SAFE_INTEGER; }
        renderQuizCard();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, expanded: q.expand }));
      }
      if (action === 'answer') {
        const picked = typeof payload.picked === 'number' ? payload.picked : -1;
        return answerQuiz(picked, res);
      }
      // 「下一个」:不造句,收掉卡片。若队列里有题就出;没有则等下一次抽查节拍。
      if (action === 'skip') {
        clearQuizCard();
        quizResultUntil = 0;
        ttsStopNow();
        try { fs.unlinkSync(CARD_PNG.quiz); } catch {}
        pushPatrickCmd({ cmd: 'quiz-end', lines: [{ text: '好，下一个～', size: 11 }] });
        // 稍等一下再出下一题,让撤卡动画走完
        setTimeout(() => { if (!flushPendingQuiz()) autoQuizTick(); }, 700).unref?.();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, skipped: true, queue: quizQueueState() }));
      }
      if (action === 'dismiss') {
        clearQuizCard();
        pendingQuiz = null;
        quizResultUntil = 0;
        ttsStopNow();   // 题目撤了,这个词就"看不见"了 → 立刻停止朗读
        try { fs.unlinkSync(CARD_PNG.quiz); } catch {}
        pushPatrickCmd({ cmd: 'quiz-end', lines: [{ text: '下次再考你', size: 11 }] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'action must be offer|answer|dismiss' }));
    });
  }
  if (url === '/pet-current.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      wordEpoch: state.petWordEpoch,
      library: CFG.library,
      sync: CFG.petWallpaperSync !== false,
      words: petFirstPassWords(),
    }));
  }
  // 快捷键保留为手动换壁纸的独立能力；小词灵界面不再暴露这组重复按钮。
  const handleAdvance = (req, res, dir) => {
    if (req.method === 'HEAD') { res.writeHead(isMac ? 200 : 404); return res.end(); }
    const now = Date.now();
    if (now - lastAdvanceAt < 500) {   // 服务端安全阀：500ms 内重复请求直接吞掉，防幽灵连发
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, bump: state.bump }));
    }
    lastAdvanceAt = now;
    bumpDelta(dir);
    if (advancing) pendingDir = dir; else runAdvance(dir);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, bump: state.bump }));
  };
  if (url === '/next.php') return handleAdvance(req, res, 1);
  if (url === '/prev.php') return handleAdvance(req, res, -1);

  // summon / hide the floating pet (called by the website control panel)
  if (url === '/pet.php') {
    if (req.method === 'HEAD') { res.writeHead(isMac ? 200 : 404); return res.end(); }
    let action = 'status';
    try { action = new URL(req.url, 'http://localhost').searchParams.get('action') || 'status'; } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (action === 'open') {
      try { fs.unlinkSync(PET_CLOSED_PATH); } catch {}   // ✕ 关闭只对本次有效，召唤时清掉标记
      startPet();
      return res.end(JSON.stringify({ ok: true, pet: true }));
    }
    if (action === 'close') {
      try { fs.writeFileSync(PET_CLOSED_PATH, '1'); } catch {}
      stopPetAll();
      return res.end(JSON.stringify({ ok: true, pet: false }));
    }
    if (action === 'card') { setPetMode('card'); return res.end(JSON.stringify({ ok: true, pet: petVisible, mode: 'card' })); }
    if (action === 'patrick') { setPetMode('patrick'); return res.end(JSON.stringify({ ok: true, pet: patrickVisible, mode: 'patrick' })); }
    return res.end(JSON.stringify({ ok: true, pet: petVisible || patrickVisible, mode: CFG.petMode || 'card' }));
  }

  // live re-render during a resize drag: render PNG at the new size and respond
  // ONLY when sips finished, so the pet's synchronous POST + reload gets the new
  // image. No window respawn — stays sharp while dragging.
  if (url === '/pet-render.php') {
    let w = 0, h = 0;
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      w = Math.max(MIN_PET_W, Math.min(MAX_PET, parseInt(q.get('w') || '0', 10) || 0));
      h = Math.max(MIN_PET_H, Math.min(MAX_PET, parseInt(q.get('h') || '0', 10) || 0));
    } catch {}
    const done = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, w, h }));
    };
    if (w > 0 && h > 0) return renderPetPng(w, h, done);
    return done();
  }

  // final resize: save the size to state + re-render crisp, respond when done.
  // The pet reloads the new PNG itself (poll timer) — no window restart.
  if (url === '/pet-size.php') {
    if (req.method === 'HEAD') { res.writeHead(isMac ? 200 : 404); return res.end(); }
    let w = 0, h = 0;
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      w = Math.max(MIN_PET_W, Math.min(MAX_PET, parseInt(q.get('w') || '0', 10) || 0));
      h = Math.max(MIN_PET_H, Math.min(MAX_PET, parseInt(q.get('h') || '0', 10) || 0));
    } catch {}
    const done = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, w, h }));
    };
    if (w > 0 && h > 0) {
      state.petSize = { w, h };
      saveState();
      try { fs.unlinkSync(PET_CLOSED_PATH); } catch {}   // 换形状时把宠物叫回来
      return renderPetPng(w, h, done);
    }
    return done();
  }

  /* 桌面词的复习状态:每个当前页词标注「新词(还没背第一遍)」或
   * 「倒计时中(SRS 已有记录,还差多久到期)」。派大星悬停气泡用。 */
  if (url === '/pet-word-status.json') {
    let srsIndex = new Map();   // word.word(lower) → {stage, due}
    try {
      const db = openSrsDb();
      const userId = db && activeUserId(db);
      if (db && userId) {
        const libState = readReviewState(db, userId)[CFG.library];
        Object.values((libState && libState.words) || {}).forEach(item => {
          if (item && item.word && item.word.word) srsIndex.set(String(item.word.word).toLowerCase(), item);
        });
      }
      try { if (db) db.close(); } catch {}
    } catch {}
    const now = Date.now();
    const words = petFirstPassWords().map(w => {
      const rec = srsIndex.get(String(w.word || '').toLowerCase());
      if (!rec) return { word: w.word, kind: 'new' };
      const due = Number(rec.due) || 0;
      if ((Number(rec.stage) || 0) >= SRS_INTERVALS_MIN.length) return { word: w.word, kind: 'mastered' };
      if (!due || due <= now) return { word: w.word, kind: 'due', stage: Number(rec.stage) || 0 };
      return { word: w.word, kind: 'countdown', stage: Number(rec.stage) || 0, dueInMs: due - now };
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, words }));
  }
  // status endpoint
  if (url === '/status.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ mac: isMac, config: CFG, pet: petVisible || patrickVisible, petMode: CFG.petMode || 'card', hotkey: hotkeyStatus(), menuBar: Boolean(menuBarChild), quizQueue: quizQueueState() }));
  }

  /* /api/export/* 转发给主服务。
   * 页面既可能由主服务(8770)提供,也可能由伴侣自己(8771)提供;伴侣不实现业务 API,
   * 但用户的会话 cookie 在主服务上 —— 原样透传 Cookie/Content-Disposition 即可。 */
  if (url.startsWith('/api/export/')) {
    return proxyToMainApi(req, res);
  }
  // 菜单栏图标的数据源(JXA 子进程 10s 拉一次;密钥头防其它本机进程干扰显示)
  if (url === '/menu-status.json') {
    if (req.headers['x-wordpaper-local'] !== '1') { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(menuStatusPayload()));
  }
  // 小词灵窗口的归属心跳(孤儿窗口靠它发现「伴侣已换人」并自毁)
  if (url === '/pet-owner.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, ownerPid: process.pid }));
  }
  // 菜单栏点击:召唤/隐藏小词灵、换一组、检查更新、一键更新、退出
  if (url === '/menu.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (req.headers['x-wordpaper-local'] !== '1') { res.writeHead(403); return res.end(); }
    let cmd = '';
    try { cmd = new URL(req.url, 'http://localhost').searchParams.get('cmd') || ''; } catch {}
    if (['workspace-home', 'workspace-memory'].includes(cmd) && !nativeLocalRequest(req)) { res.writeHead(403); return res.end(); }
    return handleMenuCommand(cmd, res);
  }

  // one-click enable: this server IS the companion, so it's already running.
  if (url === '/companion/start') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, already: true }));
  }
  // standalone download zip (same as the main server).
  if (url === '/companion.zip') return serveCompanionZip(req, res);

  serveStatic(req, res, url);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${CFG.port} 被占用，先关掉旧的 companion 再试`);
    process.exit(1);
  }
  throw err;
});

server.listen(CFG.port, '127.0.0.1', () => {
  console.log('');
  console.log('  🌱 WordPaper · 桌面伴侣已启动');
  console.log('  ────────────────────────────────');
  console.log(`  网站 + OCR：   http://localhost:${CFG.port}`);
  console.log(`  桌面壁纸自动换：${CFG.autoSetWallpaper ? '开（每 ' + CFG.intervalMinutes + ' 分钟）' : '关'}`);
  console.log(`  配置：         ${CONFIG_PATH}`);
  console.log('');
  if (isMac) {
    // Bring back the registered App; source-only runs retain browser access.
    if (process.env.WORDPAPER_TEST_MODE !== '1' && process.env.WORDPAPER_COMPANION_SILENT !== '1') openWorkspace('/');
    else if (process.env.WORDPAPER_COMPANION_SILENT === '1') console.log('  静默启动（开机自启）：不打开浏览器');
    // push the first wallpaper now, then on the interval
    sweepRasterTemps();
    if (CFG.autoSetWallpaper) {
      enqueueWallpaper();
      setInterval(() => enqueueWallpaper(), Math.max(1, CFG.intervalMinutes) * 60000);
    }
    // floating always-on-top pet window. Later ticks refresh the PNG in place
    // so the window does not get killed and reopened every interval.
    if (CFG.petEnabled) {
      try { fs.unlinkSync(PET_CLOSED_PATH); } catch {} // ✕ 关闭只对本次运行有效，重启伴侣恢复
      startPet();
      setInterval(() => {
        if (!petVisible && !patrickVisible) startPet();
        else refreshPetInPlace(petWords.length, petFirstPassWords().length);
      }, Math.max(5, CFG.intervalMinutes) * 60000);
    }
    // 自主抽查:伴侣自己读 SRS 库出题,不需要浏览器(独立 App 的核心能力)
    if (CFG.quizAutoStart !== false) startAutoQuiz();
    // global hotkey listener (independent of the pet; survives pet ✕ close)
    startHotkey();
    // menu bar status item:「App 在跑」的可见指示 + 召唤/退出/更新入口。
    // 开机静默自启也显示(这正是用户要的「后台运行也看得见」)。
    if (process.env.WORDPAPER_TEST_MODE !== '1') startMenuBar();
    // follow-server:主服务死亡 → 伴侣跟随退出(独立版恒开)
    followServer();
    setInterval(followServer, 5000).unref();
    syncMenuUpdate();
    setInterval(syncMenuUpdate, 5000).unref();
    setInterval(() => { if (process.env.WORDPAPER_TEST_MODE !== '1') startMenuBar(); }, 10000).unref();
    process.on('SIGINT', stopCompanion);
    process.on('SIGTERM', stopCompanion);
  } else {
    console.log('  （非 macOS：只提供网站，不改桌面壁纸 / 不做 OCR）');
  }
});
