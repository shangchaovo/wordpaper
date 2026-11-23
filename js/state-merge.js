/* Merge edits made from the same revision. Keep a review answer (including
 * scheduling, undo and event history) atomic. Ambiguous edits go to recovery. */
(function (root) {
  'use strict';
  const conflict = Symbol('conflict');
  const equal = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function byId(items, keyFor) {
    if (!Array.isArray(items)) return null;
    const map = new Map();
    for (const item of items) {
      const id = keyFor(item);
      if (typeof id !== 'string' || !id || map.has(id)) return null;
      map.set(id, item);
    }
    return map;
  }

  function mergeList(ns, base, local, remote) {
    const keyFor = ns === 'reminders' ? item => item?.id : item =>
      typeof item?.word === 'string' && item.word ? JSON.stringify([item.word, item.phonetic || '']) : null;
    const [before, ours, theirs] = [base, local, remote].map(value => byId(value, keyFor));
    if (!before || !ours || !theirs) return conflict;
    const common = id => before.has(id) && ours.has(id) && theirs.has(id);
    const [initialOrder, localOrder, remoteOrder] = [before, ours, theirs].map(map => [...map.keys()].filter(common));
    if (!equal(localOrder, initialOrder) && !equal(remoteOrder, initialOrder) && !equal(localOrder, remoteOrder)) return conflict;
    const first = equal(localOrder, initialOrder) ? theirs : ours;
    const ids = new Set([...first.keys(), ...ours.keys(), ...theirs.keys()]);
    const merged = [];
    for (const id of ids) {
      const item = combine(ns, before.get(id), ours.get(id), theirs.get(id), 1);
      if (item === conflict) return conflict;
      if (item !== undefined) merged.push(item);
    }
    return merged;
  }

  function combine(ns, base, local, remote, depth) {
    if (equal(local, remote) || equal(base, remote)) return local;
    if (equal(base, local)) return remote;
    // A deletion racing an edit needs the user's decision. Independent changes
    // in other items never restore the deleted key.
    if (local === undefined || remote === undefined || depth >= 32) return conflict;
    if (!depth && (ns === 'customWords' || ns === 'reminders')) return mergeList(ns, base || [], local, remote);
    if (ns === 'review' && depth >= 3) return conflict;
    if ((base !== undefined && !record(base)) || !record(local) || !record(remote)) return conflict;
    const result = Object.create(null);
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const own = value => value && Object.hasOwn(value, key) ? value[key] : undefined;
      const value = combine(ns, own(base), own(local), own(remote), depth + 1);
      if (value === conflict) return conflict;
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  function merge(ns, base, local, remote) {
    if (!['settings', 'review', 'customWords', 'reminders'].includes(ns)) return { conflict: true };
    const value = combine(ns, base === null ? undefined : base, local, remote, 0);
    return value === conflict ? { conflict: true } : { value };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { merge };
  else root.StateMerge = { merge };
})(typeof window !== 'undefined' ? window : globalThis);
