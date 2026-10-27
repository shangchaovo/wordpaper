'use strict';

// Coordinates are in the original 192×208 sprite cell (top-left origin).
// Each reading pose has a different face position; never anchor lips to the window.
const FRAMES = {
  0:  {x:70,y:93,w:53,h:16,cx:97,cy:101},
  2:  {x:70,y:97,w:55,h:16,cx:98,cy:105},
  5:  {x:62,y:97,w:52,h:17,cx:86,cy:105},
  14: {x:67,y:97,w:54,h:17,cx:93,cy:105},
  21: {x:72,y:86,w:48,h:15,cx:96,cy:94},
};

// These two pure functions are embedded in the JXA player too. Real metering
// controls articulation; word boundaries only influence a gentle rounded/wide
// mouth shape. This is expressive lip motion, not estimated phoneme timing.
function mouthTarget(db, cue, hasCues, playing, reduced) {
  if (!playing || reduced || !isFinite(db) || db < -47 || (hasCues && !cue)) return {open:0,round:0};
  var energy=Math.max(0,Math.min(1,(db+47)/31));
  var word=String(cue && cue.text || '').toLowerCase();
  var rounded=/oo|ou|ow|[ouw]/.test(word), wide=/ee|ea|[ei]/.test(word);
  return {open:Math.pow(energy,.85)*.92,round:rounded ? .78 : wide ? .12 : .38};
}
function advanceMouth(previous, target, dt) {
  var elapsed=Math.max(0,Math.min(120,dt));
  var attack=target.open>previous.open ? 38 : 65;
  var open=previous.open+(target.open-previous.open)*(1-Math.exp(-elapsed/attack));
  var round=previous.round+(target.round-previous.round)*(1-Math.exp(-elapsed/100));
  if(target.open===0 && open<.025)open=0;
  return {open:open,round:round};
}

module.exports={FRAMES,mouthTarget,advanceMouth};
