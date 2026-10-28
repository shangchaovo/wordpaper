'use strict';

// Self-contained ES5 factory: the same clock runs in Node tests and JXA.
function createIdleClock(saved) {
  saved = saved || {};
  var elapsed = Math.max(0, Number(saved.elapsedMs) || 0);
  var userKey = String(saved.userKey || ''), studyAt = Number(saved.studyAt) || 0;
  var previous = 0, eligible = false;
  function context(value) {
    var key = String(value.userKey || '');
    // A temporarily unavailable account/database pauses, rather than erasing
    // the saved clock. A verified different account still starts its own clock.
    if (!key) { eligible = false; return; }
    if (key !== userKey) { elapsed = 0; studyAt = 0; userKey = key; }
    var latest = Number(value.studyAt) || 0;
    if (latest > studyAt) { elapsed = 0; studyAt = latest; }
    eligible = !!value.eligible;
  }
  function tick(now, suspended) {
    var delta = previous ? now - previous : 0;
    previous = now;
    // A delayed run-loop callback must never charge sleep/lock time.
    if (eligible && !suspended && delta > 0 && delta <= 2000) elapsed += delta;
    return snapshot();
  }
  function snapshot() {
    return { elapsedMs: elapsed, userKey: userKey, studyAt: studyAt,
      phase: elapsed >= 900000 ? 2 : elapsed >= 300000 ? 1 : 0, eligible: eligible };
  }
  function format() {
    var total = Math.floor(elapsed / 1000), h = Math.floor(total / 3600);
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return (h ? pad(h) + ':' : '') + pad(Math.floor(total % 3600 / 60)) + ':' + pad(total % 60);
  }
  return { context: context, tick: tick, snapshot: snapshot, format: format };
}

module.exports = { createIdleClock };
