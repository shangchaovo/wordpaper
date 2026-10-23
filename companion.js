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
if (process.env.WORDPAPER_WEB_ORIGIN) {
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
  try { fs.writeFileSync(tmp, JSON.stringify(CFG, null, 2)); fs.renameSync(tmp, CONFIG_PATH); }
  catch { try { fs.unlinkSync(tmp); } catch {} }
}

/* Manual-advance state: each "next" (pet click or global hotkey) bumps the
 * counter, which is mixed into the pick seed so the wallpaper + pet jump to a
 * new word group right away (the auto interval still rotates by bucket). */
const STATE_PATH = process.env.WORDPAPER_STATE_PATH || migratedRuntimePath('companion-state.json');
const STATE_DEFAULTS = { bump: 0, petMemoryEvents: [], petMemorySeq: 0, petMemoryStreamId: '', petLearnedByLibrary: {}, petDecksByLibrary: {}, petKnownByLibrary: {}, petWordEpoch: 0, wallpaperCachePath: '' };
let state = Object.assign({}, STATE_DEFAULTS);
try { state = Object.assign({}, STATE_DEFAULTS, JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))); } catch {}
if (!Array.isArray(state.petMemoryEvents)) state.petMemoryEvents = [];
if (!state.petLearnedByLibrary || typeof state.petLearnedByLibrary !== 'object') state.petLearnedByLibrary = {};
if (!state.petDecksByLibrary || typeof state.petDecksByLibrary !== 'object') state.petDecksByLibrary = {};
if (!state.petKnownByLibrary || typeof state.petKnownByLibrary !== 'object') state.petKnownByLibrary = {};
state.petWordEpoch = Math.max(0, Number(state.petWordEpoch) || 0);
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
function bumpPetWordEpoch() { state.petWordEpoch = Math.max(0, Number(state.petWordEpoch) || 0) + 1; }
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
  'phone-1080x2400': [1080, 2400],
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
  // 右上角关闭按钮（✕），点击可关闭小窗
  const cR = 12 * s;
  const cX = w - padX * s - cR, cY = padY * s + cR;
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
/* crude width estimate + truncate with ellipsis (SVG text doesn't wrap). */
function truncate(str, fs, maxW) {
  let out = '';
  let wid = 0;
  for (const ch of String(str)) {
    const cw = /[　-鿿豈-﫿]/.test(ch) ? fs : (ch === ' ' ? fs * 0.3 : fs * 0.55);
    if (wid + cw > maxW && out) return out.replace(/\s+$/, '') + '…';
    out += ch; wid += cw;
  }
  return out;
}

function buildPetJXA(W, H) {
  const meta = JSON.stringify({ btn: PET_BTN, frame: PET_FRAME, footerH: PET_FOOTER_H, rsz: PET_RESIZE, minW: MIN_PET_W, minH: MIN_PET_H, max: MAX_PET, port: CFG.port, count: petWords.length, wordKeys: petWords.map(petWordKey), dark: petSkin(CFG.uiTheme).dark === true });
  const memoryTarget = localWebOrigin(CFG.webOrigin) || `http://localhost:${CFG.port}`;
  return `
ObjC.import('Cocoa');
ObjC.import('QuartzCore');
function run(argv){
  var pngPath = argv[0], corner = argv[1], posFile = argv[2], savedPos = argv[3], closeFile = argv[4], W = ${W}, H = ${H};
  var TRANSITION = ${JSON.stringify(CFG.petTransition || 'dissolve-pop')};
  var META = ${meta};
  var BTN = META.btn, FRAME = META.frame, FOOTERH = META.footerH, RSZ = META.rsz, MINW = META.minW, MINH = META.minH, MAXS = META.max, PORT = META.port, COUNT = META.count, KEYS = META.wordKeys, skinDark = META.dark === true;
  var rememberUrl = 'http://127.0.0.1:' + PORT + '/remember.php?i=';
  var pageUrl = 'http://127.0.0.1:' + PORT + '/pet-page.php?dir=';
  var memoryUrl = ${JSON.stringify(memoryTarget + '/?openMemory=1')};
  var sizeUrl = 'http://127.0.0.1:' + PORT + '/pet-size.php';
  var renderUrl = 'http://127.0.0.1:' + PORT + '/pet-render.php';
  var img = $.NSImage.alloc.initWithContentsOfFile(pngPath);
  var startX = 0, startY = 0, oX = 0, oY = 0, dragging = false, moved = false, downTime = 0, wordIndex = -1;
  var resizing = false, rStartX = 0, rStartY = 0, rW0 = 0, rH0 = 0, lastRenderAt = 0;
  function postUrl(u){
    var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString(u));
    req.setHTTPMethod('POST');
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
        $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(memoryUrl));
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
  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  $.NSApplication.sharedApplication.run;
}`;
}

let petChild = null;
let petVisible = false;   // whether the floating pet window is currently shown
let petWords = [];        // 当前小词灵实际展示的词，供点击命中和记忆事件使用
function stopPet() {
  petVisible = false;
  if (petChild) { try { petChild.kill(); } catch {} petChild = null; }
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
function run(argv){
  var PORT = '${port}';
  var OWNER = '${ownerPid || ''}';   // 派生本脚本的伴侣 PID;menu-status 回来对不上号就自毁
  var item = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
  var btn = item.button;
  btn.toolTip = 'WordPaper · 每日壁纸(点击打开菜单)';
  // 图标:黑描边小圆点+词签,走 template 模式自动适配明暗菜单栏;渲染失败退化为文字「词」
  (function(){
    try {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="7.2" fill="none" stroke="black" stroke-width="1.6"/><rect x="5" y="6.4" width="8" height="1.7" rx="0.85" fill="black"/><rect x="5" y="9.9" width="5.2" height="1.7" rx="0.85" fill="black"/></svg>';
      var b64 = $.NSString.stringWithString(svg).dataUsingEncodingAllowLossyConversion($.NSUTF8StringEncoding, true);
      var img = $.NSImage.alloc.initWithData(b64);
      if (img && !img.isNil()) { img.setSize($.NSMakeSize(16, 16)); img.setTemplate(true); btn.image = img; }
      else btn.title = '词';
    } catch (e) { btn.title = '词'; }
  })();

  var lastMenuSig = '', lastGoodAt = Date.now();
  var LOCAL_HEADER = 'X-WordPaper-Local';
  function markLocal(req){ req.setValueForHTTPHeaderField('1', LOCAL_HEADER); }
  function post(cmd){
    var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + PORT + '/menu.php?cmd=' + cmd));
    req.setHTTPMethod('POST');
    markLocal(req);
    req.setTimeoutInterval(8);
    $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){
      rebuildMenu(true);
    });
  }
  function openURL(u){
    $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(u));
  }
  var MenuTarget = ObjC.registerSubclass({ name: 'DWMenuBarTarget', methods: {
    // JXA 无法从 JS 函数推断 ObjC 签名,必须显式 types(['void', ['id']]),否则 -2700
    'fire:': { types: ['void', ['id']], implementation: function(sender) {
      var cmd = ObjC.unwrap(sender.representedObject) || '';
      if (cmd === '') return;
      if (cmd.indexOf('open:') === 0) { openURL(cmd.slice(5)); return; }
      if (cmd === 'quit') {
        item.menu = $();             // 先摘菜单再退出,图标立刻消失(nil 用 $())
        $.NSStatusBar.systemStatusBar.removeStatusItem(item);
        post('quit');
        return;
      }
      post(cmd);
    } }
  }});
  var target = $.DWMenuBarTarget.alloc.init;   // 注册类挂在 $ 全局,返回值不可用(与 DWGrip 同)

  function addItem(menu, title, cmd, disabled){
    var it = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, cmd === '' ? $() : 'fire:', '');
    if (cmd !== '') { it.setTarget(target); it.setRepresentedObject($.NSString.stringWithString(cmd)); }
    if (disabled) it.setEnabled(false);
    menu.addItem(it);
    return it;
  }
  function sep(menu){ menu.addItem($.NSMenuItem.separatorItem); }

  function rebuildMenu(force){
    var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + PORT + '/menu-status.json'));
    markLocal(req);
    req.setTimeoutInterval(4);
    $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){
      var st = null;
      if (data) {
        lastGoodAt = Date.now();
        try { st = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js); } catch (e) {}
      }
      // 归属校验:端口上的服务不是「派生我的那个伴侣」时(比如我被杀后别的
      // 实例占了同一端口),继续活着只会变成幽灵图标 —— 立即自毁。
      if (OWNER && st && st.ownerPid && String(st.ownerPid) !== OWNER) {
        try { $.NSStatusBar.systemStatusBar.removeStatusItem(item); } catch (e2) {}
        $.NSApplication.sharedApplication.terminate($());
        return;
      }
      var sig = data ? $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js : '';
      if (!force && sig === lastMenuSig) return;
      lastMenuSig = sig;
      if (!st || !st.ok) {          // 服务不可达:降级为「重启 WordPaper」
        var m2 = $.NSMenu.alloc.init;
        addItem(m2, 'WordPaper 暂时没有响应…', '', true);
        addItem(m2, '重新打开 WordPaper', 'open:' + (st && st.web ? st.web : 'http://localhost:8770'), false);
        item.menu = m2;
        return;
      }
      var menu = $.NSMenu.alloc.init;
      menu.setAutoenablesItems(false);
      if (st.pet) addItem(menu, '隐藏小词灵', 'pet-close', false);
      else addItem(menu, '召唤小词灵', 'pet-open', false);
      addItem(menu, '换一组词', 'next', false);
      addItem(menu, '记忆复习本…', 'open:' + st.web + '/?openMemory=1', false);
      addItem(menu, '打开控制面板…', 'open:' + st.web, false);
      sep(menu);
      var u = st.update || {};
      if (u.applying) {
        addItem(menu, '正在更新到 v' + (u.target || '…') + '…', '', true);
      } else if (u.error) {
        addItem(menu, '更新失败:' + String(u.error).slice(0, 40), '', true);
        addItem(menu, '重试检查更新', 'update-check', false);
      } else if (u.available && u.latest) {
        addItem(menu, '一键更新到 v' + u.latest, 'update-apply', false);
        addItem(menu, '当前 v' + u.current, '', true);
      } else if (u.current) {
        addItem(menu, u.checked ? '当前 v' + u.current + '(已是最新)' : '检查更新…', u.checked ? '' : 'update-check', false);
      }
      if (u.available || u.applying) sep(menu);
      sep(menu);
      addItem(menu, '退出 WordPaper', 'quit', false);
      item.menu = menu;
    });
  }
  rebuildMenu(true);
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(10, true, function(){ rebuildMenu(false); });
  // 伴侣进程崩溃/被杀后图标绝不能残留:连续 15s 拿不到状态就自我了断
  // (正常周期 10s;0.5s 一轮 runUntilDate 保证能走到这里)。退出必须用
  // stdlib exit —— terminate 在管道冻结等场景可能抛异常,而任何写向已死
  // 父进程 stderr 管道的数据都会把本脚本冻死(64KB 缓冲写满即阻塞,
  // 定时器全停 → 图标永远消失不掉,真实事故)。
  ObjC.import('stdlib');
  function selfDestruct(){
    try { $.NSStatusBar.systemStatusBar.removeStatusItem(item); } catch (e) {}
    try { $.NSApplication.sharedApplication.terminate($()); } catch (e) {}
    try { $.exit(0); } catch (e) {}
  }
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(5, true, function(){
    if (Date.now() - lastGoodAt > 15000) selfDestruct();
  });
  while (true) { $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.5)); }
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
  menuBarChild = spawn('osascript', ['-l', 'JavaScript', scriptPath], { stdio: ['ignore', 'ignore', 'ignore'] });
  menuBarChild.on('exit', () => { menuBarChild = null; });
  menuBarChild.unref();
  console.log('[companion] 菜单栏图标已显示:小词灵/换一组/记忆本/检查更新/退出 都在这里');
}

/* 菜单栏命令与状态(仅本机回环,见 /menu.php) */
let updateState = { applying: false, target: '', error: '', checked: false, available: false, latest: '', checkedAt: 0 };
function menuStatusPayload() {
  return {
    ok: true,
    ownerPid: process.pid,   // 菜单栏 JXA 靠它校验归属:对不上号 = 我是幽灵,自毁
    pet: petVisible,
    appMode: APP_MODE,
    version: BUNDLED_VERSION,
    web: localWebOrigin(CFG.webOrigin) || `http://localhost:${serverWebPort()}`,
    update: updateState,
  };
}
function serverWebPort() {
  try { return Number(new URL(CFG.webOrigin).port) || 8770; } catch { return 8770; }
}
/* 向主服务查询更新状态(/api/update/check 是免登录只读端点)。 */
function fetchServerUpdate(cb) {
  const req = http.get(`${serverBase()}/api/update/check?refresh=1`, { timeout: 15000 }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      try {
        const d = JSON.parse(body);
        cb(null, { available: !!d.available, latest: d.latest || '', current: d.current || '' });
      } catch (e) { cb(e); }
    });
  });
  req.on('error', err => cb(err));
  req.on('timeout', () => { req.destroy(new Error('超时')); });
}
function handleMenuCommand(cmd, res) {
  const jsonOut = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  switch (cmd) {
    case 'pet-open':
      try { fs.unlinkSync(PET_CLOSED_PATH); } catch {}
      startPet();
      return jsonOut({ ok: true, pet: petVisible });
    case 'pet-close':
      try { fs.writeFileSync(PET_CLOSED_PATH, '1'); } catch {}
      stopPet();
      return jsonOut({ ok: true, pet: false });
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
          updateState.current = info.current || BUNDLED_VERSION; updateState.checked = true; updateState.checkedAt = Date.now();
        }
      });
      return jsonOut({ ok: true, checking: true });
    }
    case 'update-apply': {
      if (!APP_MODE || !BUNDLED_VERSION) return jsonOut({ ok: false, error: '开发模式不支持内置更新' });
      if (updateState.applying) return jsonOut({ ok: true, applying: true });
      fetchServerUpdate((err, info) => {
        if (err || !info.available) { updateState.error = err ? '无法连接主服务' : '没有可用的新版本'; updateState.checked = true; return; }
        updateState.applying = true; updateState.error = ''; updateState.target = info.latest;
        const req = http.request(`${serverBase()}/api/update/apply-local`, { method: 'POST', timeout: 15000, headers: { 'X-WordPaper-Local': '1' } }, resp => {
          resp.resume();
          resp.on('end', () => {
            if (resp.statusCode !== 200) { updateState.applying = false; updateState.error = '主服务拒绝更新(' + resp.statusCode + ')'; }
          });
        });
        req.on('error', () => { updateState.applying = false; updateState.error = '更新请求失败'; });
        req.end();
        // server 落盘重启旗标后 hardExit;follow-server 会让本进程跟随退出,
        // launcher 重入后新链接管 —— 菜单栏图标短暂消失再回来属预期。
        setTimeout(() => { if (updateState.applying) updateState.error = '更新超时(6 分钟无进展)'; updateState.applying = false; }, 6 * 60 * 1000).unref();
      });
      return jsonOut({ ok: true, applying: true });
    }
    case 'quit': {
      console.log('[companion] 收到菜单栏退出命令:请求主服务一同退出');
      const req = http.request(`${serverBase()}/api/quit`, { method: 'POST', timeout: 8000, headers: { 'X-WordPaper-Local': '1' } }, resp => resp.resume());
      req.on('error', () => {});
      req.end();
      // server 会自行 shutdown;无论如何本进程稍后自杀,避免孤儿图标
      setTimeout(() => process.exit(0), 1500).unref();
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
      try { fs.writeFileSync(PET_CLOSED_PATH, '1'); } catch {}   // 跟随时收起小词灵,重启后由新链恢复
      process.exit(0);
    }
  });
  req.on('timeout', () => req.destroy(new Error('healthz 超时')));
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
    const pngPath = path.join(os.tmpdir(), 'dw_pet.png');
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

function startPet() {
  stopPet();
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
    if (err) { console.error('[companion] pet render failed:', err.message); return; }
    const pngPath = path.join(os.tmpdir(), 'dw_pet.png');
    const jxa = buildPetJXA(W, H);
    const scriptPath = path.join(os.tmpdir(), 'dw_pet.jxa.js');
    fs.writeFileSync(scriptPath, jxa);
    const { spawn } = require('child_process');
    petVisible = true;
    const child = petChild = spawn('osascript', ['-l', 'JavaScript', scriptPath, pngPath, CFG.petCorner || 'top-right', posFile, savedPos, closeFile], { stdio: ['ignore', 'ignore', 'pipe'] });
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
        if (now - holder.at > WALLPAPER_LOCK_MS) {   // 过期锁:接管
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
  if (petVisible && petChild && CFG.petEnabled) {
    const prevCount = petFirstPassWords().length;
    navigatePetPage(dir);
    syncWallpaperToPet();
    refreshPetInPlace(prevCount, petFirstPassWords().length);
    return;
  }
  if (petWallpaperTimer) { clearTimeout(petWallpaperTimer); petWallpaperTimer = null; }
  advancing = true;
  pushWallpaper(() => {
    if (!petVisible || !petChild) startPet();
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
  const direct = segments.length === 1 && segments[0] === 'index.html';
  const allowed = segments.length >= 2 && ['css', 'js', 'data'].includes(segments[0])
    && !segments.some(segment => segment === '.' || segment === '..' || segment.startsWith('.'));
  if (!direct && !allowed) { res.writeHead(404); res.end('Not Found'); return; }
  const file = path.resolve(ROOT, '.' + decoded);
  const allowedRoot = direct ? ROOT : path.resolve(ROOT, segments[0]);
  if (file !== path.join(ROOT, 'index.html') && !file.startsWith(allowedRoot + path.sep)) { res.writeHead(404); res.end('Not Found'); return; }
  const ext = path.extname(file).toLowerCase();
  const allowedExt = segments[0] === 'css' ? ['.css', '.woff', '.woff2', '.png', '.svg']
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
    if (parsed.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) return '';
    return parsed.origin;
  } catch { return ''; }
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
      const webOrigin = localWebOrigin(payload.webOrigin);
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
      if (petVisible && (changedLibrary || changedWebOrigin || changedPageKeys || changedTransition || payload.refresh === true)) startPet();
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
    const events = reset ? [] : state.petMemoryEvents.filter(event => event.id > after);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ streamId: state.petMemoryStreamId, firstId, lastId, reset, events, snapshot: reset ? learnedSnapshot() : undefined }));
  }
  // 网页轮询：小词灵「当前页词」+ 代际。点词/翻页/补位 bump epoch，网页据此对齐预览。
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
      stopPet();
      return res.end(JSON.stringify({ ok: true, pet: false }));
    }
    return res.end(JSON.stringify({ ok: true, pet: petVisible }));
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

  // status endpoint
  if (url === '/status.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ mac: isMac, config: CFG, pet: petVisible, hotkey: hotkeyStatus(), menuBar: Boolean(menuBarChild) }));
  }

  // 菜单栏图标的数据源(JXA 子进程 10s 拉一次;密钥头防其它本机进程干扰显示)
  if (url === '/menu-status.json') {
    if (req.headers['x-wordpaper-local'] !== '1') { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(menuStatusPayload()));
  }
  // 菜单栏点击:召唤/隐藏小词灵、换一组、检查更新、一键更新、退出
  if (url === '/menu.php') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (req.headers['x-wordpaper-local'] !== '1') { res.writeHead(403); return res.end(); }
    let cmd = '';
    try { cmd = new URL(req.url, 'http://localhost').searchParams.get('cmd') || ''; } catch {}
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
    // open the site in the default browser (skipped on silent/autostart launches,
    // Wallpaper-Engine-style: boot → wallpaper appears, no windows pop up)
    if (process.env.WORDPAPER_TEST_MODE !== '1' && process.env.WORDPAPER_COMPANION_SILENT !== '1') execFile('open', [CFG.webOrigin || `http://localhost:${CFG.port}`], () => {});
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
        if (!petVisible || !petChild) startPet();
        else refreshPetInPlace(petWords.length, petFirstPassWords().length);
      }, Math.max(5, CFG.intervalMinutes) * 60000);
    }
    // global hotkey listener (independent of the pet; survives pet ✕ close)
    startHotkey();
    // menu bar status item:「App 在跑」的可见指示 + 召唤/退出/更新入口。
    // 开机静默自启也显示(这正是用户要的「后台运行也看得见」)。
    if (process.env.WORDPAPER_TEST_MODE !== '1') startMenuBar();
    // follow-server:主服务死亡 → 伴侣跟随退出(独立版恒开)
    followServer();
    setInterval(followServer, 5000).unref();
    const cleanup = () => {
      stopPet();
      stopMenuBar();
      if (hotkeyChild) { try { hotkeyChild.kill(); } catch {} }
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  } else {
    console.log('  （非 macOS：只提供网站，不改桌面壁纸 / 不做 OCR）');
  }
});
