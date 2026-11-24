'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../js/srs-policy');
const activity = require('../js/learning-activity');
const { createMiniSync } = require('./mini-sync');
const createReview = require('../js/review');
const libraries = new Map(require('../data/libraries.json').map(lib => [lib.id, lib.name]));
libraries.set('custom', '我的词库');
const catalog = new Map();
const themes = ['liquid', 'darkliquid', 'editorial', 'anime'];

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}
function key(word) { return word.word + '|' + (word.meaning || ''); }
function digest(value) { return createHash('sha256').update(value).digest('base64url'); }
function idFor(library, word) { return library + '.' + digest(key(word)); }
function dict(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function own(map, id) { return map && Object.hasOwn(map, id) ? map[id] : undefined; }
function goodWord(word) { return typeof word?.word === 'string' && word.word.length > 0; }
function indexWords(library, words) {
  const index = new Map();
  for (const word of Array.isArray(words) ? words : []) if (goodWord(word)) index.set(idFor(library, word), word);
  return index;
}
function readCatalog(library, tx) {
  if (library === 'custom') return { words: indexWords(library, tx.get('customWords', [])), examples: {} };
  if (!libraries.has(library)) return { words: new Map(), examples: {} };
  if (!catalog.has(library)) {
    const directory = path.join(__dirname, '..', 'data');
    const entries = require(path.join(directory, 'words_' + library + '.json'));
    const filename = path.join(directory, 'examples_' + library + '.json');
    catalog.set(library, { words: indexWords(library, entries), examples: fs.existsSync(filename) ? require(filename) : {} });
  }
  return catalog.get(library);
}
function sampleSentence(word, examples) {
  const candidates = Array.isArray(word.examples) && word.examples.length ? word.examples : word.example ? [word.example] :
    own(examples, word.word) || own(examples, word.word.toLowerCase()) || [];
  for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
    if (typeof candidate?.en === 'string' && candidate.en.trim()) return [candidate.en.trim(), String(candidate.zh || '')];
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    // Only split bilingual dictionary rows. A Japanese example may begin with kanji.
    const mixed = candidate.trim().match(/^([^\u3400-\u9fff]*[a-zA-Z][^\u3400-\u9fff]*?)\s*([\u3400-\u9fff][\s\S]*)$/);
    if (mixed) return [mixed[1].trim(), mixed[2].trim()];
    return [candidate.trim(), String(word.translation || word.exampleZh || '')];
  }
  return ['', ''];
}
function roundFor(item) {
  if (!item) return 'new';
  // A grace-period demotion retains this due time and belongs to the same review.
  return digest(JSON.stringify([item.due ?? null, item.scheduledAt ?? item.learnedAt, item.reviewCount || 0, item.miniUndoGeneration || null]));
}
// Existing desktop clients PUT a scored review and its practice event
// separately. If the mobile answer won this same round, cancel only the
// competing notebook event, whether its separate PUT arrived first or later.
function rejectedNotebookEvents(incoming, accepted) {
  const days = {};
  for (const [library, bucket] of Object.entries(dict(incoming))) {
    for (const [key, candidate] of Object.entries(dict(bucket?.words))) {
      const last = candidate?.lastUndo, winner = own(own(accepted, library)?.words, key)?.lastUndo;
      if (typeof last?.activityId !== 'string' || !/^notebook:[a-f0-9]{32}$/.test(last.activityId) ||
          typeof winner?.activityId !== 'string' || !winner.activityId.startsWith('mini:') || !winner.snapshot || !last.snapshot ||
          !Number.isSafeInteger(last.at) || last.at <= 0 || roundFor(last.snapshot) !== roundFor(winner.snapshot)) continue;
      const day = activity.dayKey(last.at);
      (days[day] ||= {})[last.activityId] = { kind: 'review', at: last.at, canceled: true };
    }
  }
  return Object.keys(days).length ? { days } : null;
}
function undoId(item) {
  return item?.lastUndo?.activityId || (item?.reviewCount === 0 && item?.miniFirstLearnId) || null;
}
function localDay(now, options) {
  const raw = options?.timezoneOffset ?? -480;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || Math.abs(minutes) > 840) fail(400, 'invalid_timezone', '无效的时区。');
  return new Date(now - minutes * 60000).toISOString().slice(0, 10);
}

// Accept recent offline answers. The server validates the round and due time,
// and clamps a slightly fast phone clock before computing any schedule.
function occurredAt(body, now) {
  if (body.occurredAt === undefined) return now;
  const at = body.occurredAt;
  if (!Number.isSafeInteger(at) || at < now - 7 * 86400000 || at > now + 120000) {
    fail(409, 'invalid_event_time', '离线记录的时间已失效，请刷新后重做。');
  }
  return Math.min(at, now);
}
// A desktop refresh or background worker may have applied the old round's
// automatic demotion while the phone was offline. An answer actually given
// within its grace period is scored from the stage at that instant. Explicit
// answers/undos still require an exact round match.
function restoreGradeTime(item, at) {
  const missed = item.overdue;
  if (!missed || missed.version !== policy.VERSION || missed.due !== item.due ||
      missed.toStage !== item.stage || !(at < missed.deadline)) return;
  item.stage = missed.fromStage;
  delete item.overdue;
  if (missed.fromStage > missed.toStage && Array.isArray(item.events)) {
    item.events = item.events.filter(event => !(event.type === 'overdue-demotion' &&
      event.due === missed.due && event.deadline === missed.deadline && event.at === missed.appliedAt));
  }
}
function sentenceKey(eventId, id, text) {
  if (typeof eventId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(eventId) ||
      typeof id !== 'string' || id.length > 144 || typeof text !== 'string' || !text.trim() || text.trim().length > 400) {
    fail(400, 'invalid_sentence', '请输入 1 至 400 字的句子。');
  }
  return digest(JSON.stringify(['sentence', id, text.trim()]));
}
function savedSentence(tx, eventId, fingerprint) {
  const previous = tx.receipt(eventId);
  if (!previous) return null;
  if (previous.fingerprint !== fingerprint || (!previous.result_json && !previous.owner_token)) fail(409, 'event_reused', '造句编号已用于其他操作。');
  return previous.result_json ? JSON.parse(previous.result_json) : null;
}

function createMiniLearning(storage, { clock = Date.now } = {}) {
  const sync = createMiniSync(storage, libraries, themes);
  function run(userId, work) {
    let publish;
    const result = storage.miniLearningTransaction(userId, tx => {
      const now = clock();
      const all = dict(tx.get('review', {}));
      if (policy.apply(all, now).length) tx.put('review', all, now);
      const entries = new Map();
      for (const [library, bucket] of Object.entries(all)) {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(library) || ['__proto__', 'constructor', 'prototype'].includes(library)) continue;
        for (const item of Object.values(dict(bucket?.words))) {
          if (goodWord(item?.word)) entries.set(idFor(library, item.word), { library, word: item.word, item });
        }
      }
      const cache = new Map();
      function vocab(library) {
        if (!cache.has(library)) cache.set(library, readCatalog(library, tx));
        return cache.get(library);
      }
      function lookup(id) {
        if (typeof id !== 'string') return null;
        if (entries.has(id)) return entries.get(id);
        const library = id.split('.')[0];
        if (!libraries.has(library)) return null;
        const word = vocab(library).words.get(id);
        if (!word || isKnown(library, word)) return null;
        return { library, word, item: null };
      }
      let known;
      const screenedWords = new Map();
      function isKnown(library, word) {
        known ||= dict(tx.get('knownWords', {}));
        if (!screenedWords.has(library)) {
          const values = own(known, library);
          screenedWords.set(library, new Set(Array.isArray(values) ? values : []));
        }
        return screenedWords.get(library).has(word.word + '\u0000' + (word.phonetic || ''));
      }
      function view(entry) {
        const { library, word, item } = entry;
        const id = idFor(library, word);
        const source = vocab(library);
        const original = source.words.get(id);
        const richWord = original ? { ...original, ...word } : word;
        const [example, translation] = sampleSentence(richWord, source.examples);
        const stage = Number(item?.stage) || 0;
        return { id, library, libraryName: libraries.get(library) || library, word: word.word,
          ipa: String(richWord.phonetic || ''), pos: String(richWord.pos || ''), meaning: String(word.meaning || ''),
          example, translation, stage, due: item?.due || null, kind: !item ? 'new' : stage >= policy.INTERVALS_MIN.length ? 'mastered' : 'learning',
          round: roundFor(item), undoId: undoId(item) };
      }
      function listCatalog(options = {}) {
        const { query = '', kind = 'all' } = options;
        const offset = Number(options.offset ?? 0), limit = Number(options.limit ?? 40);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
            typeof query !== 'string' || query.length > 200 || !['all', 'new', 'learning', 'mastered', 'due', 'future'].includes(kind)) {
          fail(400, 'invalid_catalog_query', '无效的词库查询。');
        }
        const library = options.library || storage.getMiniPresentation(userId).library || 'ielts';
        if (library !== 'all' && !libraries.has(library) && !Object.hasOwn(all, library)) fail(404, 'library_missing', '找不到这个词库。');
        const filter = query.trim().normalize('NFKC').toLowerCase();
        const sourceIds = library === 'all' ? new Set([...libraries.keys(), ...[...entries.values()].map(e => e.library)]) : [library];
        const words = [];
        let total = 0;
        function add(entry) {
          const { word, item } = entry;
          const state = !item ? 'new' : Number(item.stage) >= policy.INTERVALS_MIN.length ? 'mastered' : 'learning';
          const due = state === 'learning' && Number(item.due) > 0;
          if (kind !== 'all' && kind !== state && !(kind === 'due' && due && item.due <= now) &&
              !(kind === 'future' && due && item.due > now)) return;
          if (filter && ![word.word, word.meaning, word.phonetic].some(value =>
            typeof value === 'string' && value.normalize('NFKC').toLowerCase().includes(filter))) return;
          if (total >= offset && words.length < limit) words.push(view(entry));
          total++;
        }
        for (const lib of sourceIds) {
          const source = vocab(lib);
          for (const [id, word] of source.words) {
            const entry = entries.get(id);
            if (entry || !isKnown(lib, word)) add(entry || { library: lib, word, item: null });
          }
          // Imported word records remain usable after their source list changes.
          for (const [id, entry] of entries) if (entry.library === lib && !source.words.has(id)) add(entry);
        }
        return { words, total, nextOffset: offset + words.length < total ? offset + words.length : null };
      }
      function snapshot(options = {}) {
        const day = localDay(now, options);
        // Read the versions after any mutations or policy reconciliation, in
        // the same transaction as the source rows used for this response.
        const context = sync.context(userId, options, day);
        const { library, theme, offset } = context;
        const plan = activity.plan(tx.get('dailyPlan', {}));
        const counts = activity.totals(tx.get('learningActivity', {}), day, plan.learnedByDay[day]);
        const current = [...entries.values()].sort((a, b) => (a.item.due || Infinity) - (b.item.due || Infinity));
        const words = current.map(view);
        let added = 0;
        for (const [id, word] of vocab(library).words) {
          if (entries.has(id) || isKnown(library, word)) continue;
          words.push(view({ library, word, item: null }));
          if (++added >= 24) break;
        }
        let validUntil = Date.parse(day + 'T00:00:00Z') + 86400000 + offset * 60000;
        for (const { item } of current) {
          const timing = policy.status(item, now);
          if (!timing) continue;
          if (timing.due > now) validUntil = Math.min(validUntil, timing.due);
          if (!timing.handled && timing.deadline > now) validUntil = Math.min(validUntil, timing.deadline);
        }
        const full = { now, day, validUntil, target: plan.dailyGoal, metric: plan.metric, counts, theme, library,
          libraries: Array.from(libraries, ([id, name]) => ({ id, name })), words,
          dueCount: words.filter(w => w.kind === 'learning' && w.due && w.due <= now).length,
          nextDue: words.find(w => w.kind === 'learning' && w.due > now)?.due || null };
        publish = () => sync.publish(context, options.since, full);
        return full;
      }
      return work({ tx, now, all, entries, lookup, view, listCatalog, snapshot });
    });
    return publish ? publish() : result;
  }

  function readSnapshot(userId, options = {}) {
    if (typeof options.since === 'string' && options.since.length === 43) {
      const now = clock(), day = localDay(now, options);
      const current = sync.unchanged(sync.context(userId, options, day), options.since, now);
      if (current) return current;
    }
    return run(userId, ctx => ctx.snapshot(options));
  }

  function mutate(userId, body, authorize) {
    const { id, action, grade, eventId, round } = body || {};
    if (typeof eventId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(eventId) ||
        typeof id !== 'string' || id.length > 144 || typeof round !== 'string' || round.length > 100 ||
        !['learn', 'grade', 'undo'].includes(action) || (action === 'grade' && !['forgot', 'fuzzy', 'remembered'].includes(grade))) {
      fail(400, 'invalid_event', '学习操作无效，请重新打开词卡。');
    }
    const fingerprint = digest(JSON.stringify([id, action, grade || null, round, body.undoId || null]));
    return run(userId, ({ tx, now, all, entries, lookup, snapshot }) => {
      authorize?.();
      const receipt = tx.receipt(eventId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail(409, 'event_reused', '学习操作编号已使用。');
        return snapshot(body);
      }
      const at = occurredAt(body, now);
      const entry = lookup(id);
      if (!entry) fail(404, 'word_missing', '当前账号中找不到这条单词。');
      if (round !== roundFor(entry.item)) fail(409, 'stale_round', '另一台设备已更新这张词卡，请刷新。');
      const { library, word } = entry;
      const store = { getReview: () => all, saveReview: () => {} };
      const review = createReview({ Store: store, SrsPolicy: policy }, () => at);
      let daily = tx.get('learningActivity', {});
      const activityId = 'mini:' + eventId;
      if (action === 'undo') {
        if (!entry.item || !body.undoId || body.undoId !== undoId(entry.item)) fail(409, 'stale_undo', '这次操作已无法撤销。');
        if (entry.item.lastUndo?.snapshot) {
          const restored = review.undoReview(library, word).item;
          restored.miniUndoGeneration = activityId;
          policy.applyItem(restored, now);
          entries.set(id, { library, word, item: restored });
        } else {
          delete all[library].words[key(word)];
          entries.delete(id);
        }
        const canceled = Object.entries(daily.days || {}).find(([, events]) => own(events, body.undoId));
        if (canceled) {
          const [day, events] = canceled;
          const old = events[body.undoId];
          daily = activity.merge(daily, { days: { [day]: { [body.undoId]: { ...old, canceled: true } } } }, now);
          const plan = activity.plan(tx.get('dailyPlan', {})), check = plan.checkins[day];
          if (check && activity.totals(daily, day, plan.learnedByDay[day])[check.metric] < check.target) {
            delete plan.checkins[day];
            tx.put('dailyPlan', plan, now);
          }
        }
      } else {
        if (action === 'learn' && entry.item) fail(409, 'already_learned', '该词已进入复习计划。');
        if (action === 'grade' && (!entry.item?.due || entry.item.due > at || Number(entry.item.stage) >= policy.INTERVALS_MIN.length)) {
          fail(409, 'not_due', '这张词卡当前没有到期。');
        }
        if (action === 'grade') restoreGradeTime(entry.item, at);
        const result = action === 'learn' ? review.rememberWord(library, word) : review.reviewWord(library, word, grade, { activityId });
        const item = result.item;
        if (action === 'learn') item.miniFirstLearnId = activityId;
        policy.applyItem(item, now);
        entries.set(id, { library, word, item });
        const day = localDay(at, body);
        daily = activity.merge(daily, { days: { [day]: { [activityId]: { kind: action === 'learn' ? 'learn' : 'review', at,
          library, word: { word: word.word, meaning: word.meaning || '' }, nextDue: item.due } } } }, now);
      }
      tx.put('review', all, now);
      tx.put('learningActivity', daily, now);
      tx.remember(eventId, fingerprint);
      return snapshot(body);
    });
  }

  return {
    snapshot: readSnapshot,
    catalog: (userId, options) => run(userId, ctx => ctx.listCatalog(options)),
    mutate,
    getSentenceResult(userId, eventId, id, text) {
      const fingerprint = sentenceKey(eventId, id, text);
      return storage.miniLearningTransaction(userId, tx => savedSentence(tx, eventId, fingerprint));
    },
    claimSentence(userId, body, owner) {
      const { id, eventId, text } = body;
      const fingerprint = sentenceKey(eventId, id, text);
      return storage.miniLearningTransaction(userId, tx => {
        const saved = savedSentence(tx, eventId, fingerprint);
        if (saved) return saved;
        const prior = tx.receipt(eventId), now = clock();
        if (prior && prior.lease_until > now) return 'pending';
        tx.claim(eventId, fingerprint, owner, now + 60000);
        return 'claimed';
      });
    },
    releaseSentence(userId, eventId, owner) {
      return storage.miniLearningTransaction(userId, tx => tx.release(eventId, owner));
    },
    recordSentence(userId, body, result, owner, authorize) {
      const { id, text, eventId } = body;
      const fingerprint = sentenceKey(eventId, id, text);
      return run(userId, ({ tx, now, lookup }) => {
        authorize?.();
        const saved = savedSentence(tx, eventId, fingerprint);
        if (saved) return saved;
        const entry = lookup(id);
        if (!entry) fail(404, 'word_missing', '当前账号中找不到这条单词。');
        const day = localDay(now, body);
        const event = { kind: 'sentence', at: now, library: entry.library,
          word: { word: entry.word.word, meaning: entry.word.meaning || '' }, nextDue: entry.item?.due || null };
        const daily = activity.merge(tx.get('learningActivity', {}), { days: { [day]: { ['mini:' + eventId]: event } } }, now);
        tx.put('learningActivity', daily, now);
        if (owner) {
          if (!tx.finish(eventId, owner, result)) fail(409, 'sentence_expired', '批改已过期，请重试。');
        } else tx.remember(eventId, fingerprint, result);
        return result;
      });
    },
    goal(userId, body, authorize) {
      const target = body?.target, metric = body?.metric;
      if (!Number.isInteger(target) || target < 1 || target > 1000 || !['total', 'recite', 'sentence'].includes(metric)) {
        fail(400, 'invalid_goal', '请输入 1 至 1000 的整数并选择目标类型。');
      }
      return run(userId, ({ tx, now, snapshot }) => {
        authorize?.();
        const plan = activity.plan(tx.get('dailyPlan', {}));
        if (plan.dailyGoal !== target || plan.metric !== metric) tx.put('dailyPlan', { ...plan, dailyGoal: target, metric }, now);
        return snapshot(body);
      });
    },
    word: (userId, id) => run(userId, ctx => { const entry = ctx.lookup(id); return entry ? ctx.view(entry) : null; }),
    schedules: userId => run(userId, ({ entries }) => [...entries].filter(([, { item }]) => item.due > 0 && Number(item.stage) < policy.INTERVALS_MIN.length)
      .map(([id, { library, item }]) => ({ id, library, due: item.due, round: roundFor(item) })).sort((a, b) => a.due - b.due)),
  };
}
module.exports = { createMiniLearning, rejectedNotebookEvents };
