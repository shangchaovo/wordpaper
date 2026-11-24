'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function hash(value) { return createHash('sha256').update(value).digest('base64url'); }

// Keep tokens stable across replicas serving identical built-in vocabulary,
// and force a full read after a change to the shipped dictionaries/examples.
let catalogVersion;
function catalogStamp() {
  if (!catalogVersion) {
    const dir = path.join(__dirname, '..', 'data'), h = createHash('sha256');
    for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
      h.update(name).update(hash(fs.readFileSync(path.join(dir, name))));
    }
    catalogVersion = h.digest('base64url');
  }
  return catalogVersion;
}

function remember(cache, key, value, limit) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value);
}

function createMiniSync(storage, libraries, themes) {
  // heads and settings contain only bounded, non-content metadata. Baselines
  // contain word IDs and fingerprints, never examples, text, or account keys.
  const heads = new Map(), settings = new Map(), baselines = new Map();
  const maxStoredWords = 48000, maxBaselineWords = 8000;
  let storedWords = 0;

  function context(userId, options, day) {
    const rows = storage.getMiniLearningVersions(userId);
    const study = [], presentation = [];
    for (const row of rows) {
      const fields = [row.namespace, Number(row.revision), Number(row.updated_at)];
      if (row.namespace === 'settings' || row.namespace === 'uiTheme') presentation.push(fields);
      else study.push(fields);
    }
    const profileKey = JSON.stringify(presentation);
    let profile = settings.get(userId);
    if (!profile || profile.key !== profileKey) {
      const actual = storage.getMiniPresentation(userId);
      profile = { key: profileKey, library: libraries.has(actual.library) ? actual.library : 'ielts',
        theme: themes.includes(actual.theme) ? actual.theme : 'liquid' };
      remember(settings, userId, profile, 256);
    }
    const offset = Number(options.timezoneOffset ?? -480);
    const requested = options.library ? (libraries.has(options.library) ? options.library : 'ielts') : null;
    const library = requested || profile.library;
    const scope = JSON.stringify([userId, requested, library, offset]);
    const stamp = hash(JSON.stringify([1, catalogStamp(), scope, day, profile.theme, study]));
    return { scope, stamp, library, theme: profile.theme, offset };
  }

  function unchanged(ctx, since, now) {
    const h = heads.get(ctx.scope);
    if (h && h.syncToken === since && h.stamp === ctx.stamp && h.builtAt <= now && now < h.validUntil) {
      remember(heads, ctx.scope, h, 512);
      return { unchanged: true, now, syncToken: since, validUntil: h.validUntil };
    }
    return null;
  }

  function discardOldest() {
    const token = baselines.keys().next().value;
    storedWords -= baselines.get(token).signatures.size;
    baselines.delete(token);
  }

  function publish(ctx, since, full) {
    const { now, validUntil, words, libraries: list, ...summary } = full;
    const syncToken = hash(JSON.stringify([ctx.stamp, validUntil]));
    const head = { stamp: ctx.stamp, builtAt: now, validUntil, syncToken };
    remember(heads, ctx.scope, head, 512);

    const previous = since && baselines.get(since);
    if (words.length > maxBaselineWords) return { ...full, syncToken };
    let current = baselines.get(syncToken);
    if (!current) {
      const signatures = new Map(words.map(w => [w.id, hash(JSON.stringify(w))]));
      current = { scope: ctx.scope, signatures };
      baselines.set(syncToken, current);
      storedWords += signatures.size;
      while (baselines.size > 128 || storedWords > maxStoredWords) discardOldest();
    }
    if (!previous || previous.scope !== ctx.scope) return { ...full, syncToken };
    // Even forced full/identical responses are retained as a future baseline.
    if (since === syncToken) return { unchanged: true, now, syncToken, validUntil };

    const removed = [], upserts = [], positions = [];
    const oldStable = [];
    for (const [id, signature] of previous.signatures) {
      if (!current.signatures.has(id)) removed.push(id);
      else if (current.signatures.get(id) === signature) oldStable.push(id);
    }
    let stable = 0;
    for (let index = 0; index < words.length; index++) {
      const w = words[index];
      if (current.signatures.get(w.id) !== previous.signatures.get(w.id)) {
        upserts.push(w);
        positions.push({ id: w.id, index });
      } else if (oldStable[stable++] !== w.id) return { ...full, syncToken };
      if (upserts.length + removed.length > 48) return { ...full, syncToken };
    }
    const delta = { ...summary, delta: true, now, validUntil, syncToken, baseToken: since, upserts, removed, positions };
    if (Buffer.byteLength(JSON.stringify(delta)) > 64 * 1024) return { ...full, syncToken };
    return delta;
  }
  return { context, unchanged, publish };
}

module.exports = { createMiniSync };
