/* review.js — 单词级艾宾浩斯记忆记录。
 * 每个被点击「记住」的单词都有独立阶段、下次到期时间与学习事件；
 * 20分钟 / 1小时 / 9小时 / 1天 / 2天 / 3天 / 6天 / 12天后再出现。 */
(function () {
  'use strict';

  var INTERVALS_MIN = window.SrsPolicy.INTERVALS_MIN;
  function nowMs() { return Date.now(); }
  function wordKey(w) { return (w && w.word ? String(w.word) : '') + '|' + (w && w.meaning ? String(w.meaning) : ''); }
  function groupKeyFor(words) { return (words || []).map(wordKey).sort().join(';;'); }

  function getLib(lib) {
    var all = window.Store.getReview();
    var L = all[lib];
    if (!L || typeof L !== 'object') L = { cursor: 0, groups: {}, words: {} };
    if (!L.groups) L.groups = {};
    if (!L.words) L.words = {};
    if (typeof L.cursor !== 'number') L.cursor = 0;
    // 兼容旧版「整组记住」数据：首次读到时按原到期时间拆成单词记录。
    Object.keys(L.groups).forEach(function (key) {
      var group = L.groups[key];
      (group && group.words || []).forEach(function (word) {
        var wk = wordKey(word);
        if (!wk || L.words[wk]) return;
        L.words[wk] = {
          word: word, learnedAt: group.learnedAt || nowMs(), stage: Number(group.stage) || 0,
          due: group.due || null, learnedCount: group.learnedCount || 1,
          reviewCount: Math.max(0, Number(group.stage) || 0), successCount: Math.max(0, Number(group.stage) || 0), failCount: 0,
          events: (group.learnedLog || []).map(function (at) { return { at: at, type: 'legacy' }; }),
        };
      });
    });
    return L;
  }
  function saveLib(lib, L) { var all = window.Store.getReview(); all[lib] = L; window.Store.saveReview(all); }
  function currentGroupKey(sel) { return sel && sel.words && sel.words.length ? groupKeyFor(sel.words) : ''; }

  function activeWords(lib) {
    var L = getLib(lib);
    return Object.keys(L.words).map(function (key) { return L.words[key]; }).filter(function (item) {
      return item && item.word && item.stage < INTERVALS_MIN.length;
    }).sort(function (a, b) { return (a.due || Infinity) - (b.due || Infinity); });
  }
  function dueWords(lib, now) {
    var t = now == null ? nowMs() : now;
    return activeWords(lib).filter(function (item) { return item.due && item.due <= t; });
  }
  function soonestDue(lib) { var list = activeWords(lib).filter(function (item) { return item.due; }); return list.length ? list[0].due : null; }

  /* 小词灵点击只登记「首次学习」，绝不推进复习阶段。这样即使同步事件重复、
   * 或事件恰好在到期时送达，也不会被误判成用户已经通过本轮检测。 */
  function rememberWord(lib, word) {
    var L = getLib(lib), key = wordKey(word), t = nowMs();
    if (!key) return null;
    var item = L.words[key];
    var action = 'seen';
    if (!item) {
      item = L.words[key] = { word: word, learnedAt: t, stage: 0, due: t + INTERVALS_MIN[0] * 60000, learnedCount: 1, reviewCount: 0, successCount: 0, failCount: 0, events: [{ at: t, type: 'learn' }] };
      window.SrsPolicy.scheduled(item, t, INTERVALS_MIN[0]);
      action = 'learn';
    } else {
      // 快照补偿、断线重放与重复请求都必须真正幂等，不增长计数或事件历史。
      return { item: item, action: action };
    }
    item.word = word || item.word;
    item.lastSeenAt = t;
    saveLib(lib, L);
    return { item: item, action: action };
  }

  /* 记忆本中的明确作答。只有到期词可以作答：
   * - 记住了：推进一档；跑完全部 8 档后才 mastered。
   * - 还没记住：记录一次遗忘，并从 20 分钟档重新开始整条周期。 */
  /* 分档作答:除了「记住了 / 还没记住」,还支持「模糊」。
   *  - remembered(背过了): 推进一档
   *  - fuzzy(模糊):         停在**当前档**再练一次(不从零重来,也不前进)
   *  - forgot(不会):        回到第一档
   * 第二参数兼容旧的布尔写法(true/false)。
   * opts.activityId 将作答与每日次数关联，撤销时扣回同一次练习。 */
  function reviewWord(lib, word, remembered, opts) {
    var grade = remembered;
    if (typeof remembered === 'boolean') grade = remembered ? 'remembered' : 'forgot';
    if (grade == null) grade = 'remembered';
    var L = getLib(lib), key = wordKey(word), t = nowMs(), item = L.words[key];
    if (!item) return { action: 'missing', item: null };
    window.SrsPolicy.applyItem(item, t);
    if (item.stage >= INTERVALS_MIN.length) return { action: 'mastered', item: item };
    if (!item.due || item.due > t) return { action: 'early', item: item };
    if (grade !== 'remembered' && grade !== 'fuzzy' && grade !== 'forgot') grade = 'remembered';
    // 撤销快照:变更前完整复制,供 undoReview 恢复(防误触)。随 saveReview 持久化。
    var snapshot = JSON.parse(JSON.stringify(item)); delete snapshot.lastUndo;
    item.events = item.events || [];
    item.reviewCount = (item.reviewCount || 0) + 1;
    if (grade === 'fuzzy') {
      // 模糊:不前进也不归零,保持当前档,缩短一点再来一次(档位间隔的一半,最少 20 分钟)
      var stageNow = Math.max(0, Math.min(INTERVALS_MIN.length - 1, Number(item.stage) || 0));
      var wait = Math.max(INTERVALS_MIN[0], Math.round(INTERVALS_MIN[stageNow] / 2));
      window.SrsPolicy.scheduled(item, t, wait);
      item.fuzzyCount = (item.fuzzyCount || 0) + 1;
      item.events.push({ at: t, type: 'fuzzy' }); item.events = item.events.slice(-64);
      item.lastSeenAt = t;
      item.lastUndo = { snapshot: snapshot, activityId: opts && opts.activityId, action: 'fuzzy', at: t };
      saveLib(lib, L);
      return { action: 'fuzzy', item: item };
    }
    if (grade === 'remembered') {
      item.stage = Math.min((Number(item.stage) || 0) + 1, INTERVALS_MIN.length);
      item.successCount = (item.successCount || 0) + 1;
      window.SrsPolicy.scheduled(item, t, item.stage < INTERVALS_MIN.length ? INTERVALS_MIN[item.stage] : null);
      item.events.push({ at: t, type: item.due ? 'review-pass' : 'mastered' }); item.events = item.events.slice(-64);
      item.lastSeenAt = t;
      item.lastUndo = { snapshot: snapshot, activityId: opts && opts.activityId, action: item.due ? 'review' : 'mastered', at: t };
      saveLib(lib, L);
      return { action: item.due ? 'review' : 'mastered', item: item };
    }
    item.stage = 0;
    item.failCount = (item.failCount || 0) + 1;
    window.SrsPolicy.scheduled(item, t, INTERVALS_MIN[0]);
    item.events.push({ at: t, type: 'forgot' }); item.events = item.events.slice(-64);
    item.lastSeenAt = t;
    item.lastUndo = { snapshot: snapshot, activityId: opts && opts.activityId, action: 'forgot', at: t };
    saveLib(lib, L);
    return { action: 'forgot', item: item };
  }

  /* 撤销上一次「记住了/还没记住」:把单词恢复到点击前状态(防误触)。
   * 返回 {action:'undo', item} 或 {action:'none'|'missing'}。 */
  function undoReview(lib, word) {
    var L = getLib(lib), key = wordKey(word), item = L.words[key];
    if (!item) return { action: 'missing', item: null };
    if (!item.lastUndo || !item.lastUndo.snapshot) return { action: 'none', item: item };
    var snap = item.lastUndo.snapshot;
    L.words[key] = snap;                 // 完整恢复快照(已剔除 lastUndo,不可二次撤销)
    saveLib(lib, L);
    return { action: 'undo', item: L.words[key] };
  }
  function canUndo(lib, word) { var item = getLib(lib).words[wordKey(word)]; return !!(item && item.lastUndo && item.lastUndo.snapshot); }

  function rememberWords(lib, words) {
    var records = (words || []).map(function (word) { return rememberWord(lib, word); }).filter(Boolean);
    var L = getLib(lib); L.cursor = (L.cursor || 0) + 1; saveLib(lib, L);
    return { records: records, cursor: L.cursor };
  }

  /* 给词条打「派大星考过」标记(幂等)。first=true 表示这是它第一次被考 ——
   * 记忆本据此显示「🐾 派大星考过」;若它是从记忆本之外(伴侣本地 SRS)第一次
   * 出现在这条链上,还会显示「新词」。 */
  function markPetQuiz(lib, word, correct) {
    var L = getLib(lib), key = wordKey(word), item = L.words[key];
    if (!item) return null;
    if (!item.petQuiz) item.petQuiz = { count: 0, lastAt: 0, lastCorrect: null, firstAt: 0 };
    var pq = item.petQuiz;
    pq.count += 1;
    pq.lastAt = nowMs();
    pq.lastCorrect = !!correct;
    if (!pq.firstAt) pq.firstAt = pq.lastAt;
    saveLib(lib, L);
    return item;
  }

  function getWord(lib, word) { return getLib(lib).words[wordKey(word)] || null; }
  function allWords(lib) {
    var L = getLib(lib);
    return Object.keys(L.words).map(function (key) { return L.words[key]; }).filter(function (item) { return item && item.word; });
  }
  function masteredWords(lib) { return allWords(lib).filter(function (item) { return item.stage >= INTERVALS_MIN.length; }); }
  function stats(lib) {
    var L = getLib(lib), total = 0, pending = 0, done = 0, due = 0, reviews = 0, failures = 0;
    Object.keys(L.words).forEach(function (key) {
      var item = L.words[key]; if (!item) return;
      total++; reviews += item.reviewCount || 0; failures += item.failCount || 0;
      if (item.stage >= INTERVALS_MIN.length) done++; else { pending++; if (item.due && item.due <= nowMs()) due++; }
    });
    return { total: total, pending: pending, done: done, due: due, reviews: reviews, failures: failures, cursor: L.cursor || 0 };
  }
  function recentWords(lib, limit) {
    var L = getLib(lib);
    return Object.keys(L.words).map(function (key) { return L.words[key]; }).filter(Boolean)
      .sort(function (a, b) { return (b.lastSeenAt || b.learnedAt || 0) - (a.lastSeenAt || a.learnedAt || 0); }).slice(0, limit || 4);
  }
  function reset(lib) { var all = window.Store.getReview(); delete all[lib]; window.Store.saveReview(all); }

  window.Review = { INTERVALS_MIN: INTERVALS_MIN, wordKey: wordKey, groupKeyFor: groupKeyFor, currentGroupKey: currentGroupKey,
    getLib: getLib, getWord: getWord, allWords: allWords, masteredWords: masteredWords,
    activeWords: activeWords, dueWords: dueWords, soonestDue: soonestDue,
    rememberWord: rememberWord, rememberWords: rememberWords, reviewWord: reviewWord, markPetQuiz: markPetQuiz,
    undoReview: undoReview, canUndo: canUndo,
    stats: stats, recentWords: recentWords, reset: reset };
})();
