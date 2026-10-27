'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VOICES = [
  { id:'aria', name:'Aria', voice:'en-US-AriaNeural', accent:'美式英语', tone:'清澈 · 亲切', gender:'女声', color:'rose' },
  { id:'guy', name:'Guy', voice:'en-US-GuyNeural', accent:'美式英语', tone:'温暖 · 沉稳', gender:'男声', color:'sage' },
  { id:'sonia', name:'Sonia', voice:'en-GB-SoniaNeural', accent:'英式英语', tone:'柔和 · 从容', gender:'女声', color:'lilac' },
  { id:'ryan', name:'Ryan', voice:'en-GB-RyanNeural', accent:'英式英语', tone:'明朗 · 自然', gender:'男声', color:'amber' },
];
const SAMPLE = 'Every little step brings you closer to your goal.';
function voiceById(id) { return VOICES.find(v => v.id === id) || null; }
function cueAtTime(cues, time) {
  for (var i = 0; i < cues.length; i++) {
    if (cues[i].start > time) return null;
    if (time >= cues[i].start && time < cues[i].end) return cues[i];
  }
  return null;
}

// Map spoken boundaries back to UTF-16 character ranges. Normalization tolerates
// typographic apostrophes, punctuation, entities and accents without guessing a
// timestamp. Searching forward disambiguates repeated words.
function alignWordCues(text, boundaries) {
  let normalized = '', cursor = 0, offset = 0;
  const positions = [];
  const normalize = s => String(s).normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  for (const ch of text) {
    const normalizedChar = normalize(ch);
    normalized += normalizedChar;
    for (let i=0;i<normalizedChar.length;i++) positions.push({start:offset,end:offset+ch.length});
    offset += ch.length;
  }
  const cues = [];
  for (const boundary of boundaries || []) {
    const word = normalize(boundary.text || '');
    const start = Number(boundary.start), end = Number(boundary.end);
    if (!word || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    const at = normalized.indexOf(word,cursor);
    if (at < 0 || !positions[at+word.length-1]) continue;
    const from = positions[at].start, to = positions[at+word.length-1].end;
    cues.push({start,end,from,to,text:text.slice(from,to)});
    cursor = at + word.length;
  }
  return cues.sort((a,b)=>a.start-b.start);
}

function createSpeechService({ cacheDir, edgeBin = '', execFile, runtimeDir = path.join(__dirname,'tts-runtime',process.arch), rate = '+0%', fallbackVoice = 'Samantha', fallbackRate = 165 }) {
  const pending = new Map();
  let sequence = 0;
  const bundledPython = path.join(runtimeDir, 'bin', 'python3');
  const python = fs.existsSync(bundledPython) ? bundledPython : path.join(path.dirname(edgeBin), 'python');
  const available = () => fs.existsSync(python) && (python === bundledPython || fs.existsSync(edgeBin));
  function cacheFile(text, voiceId) {
    const key = crypto.createHash('sha256').update(JSON.stringify(['word-boundary-v1',voiceId,rate,text])).digest('hex');
    return path.join(cacheDir,key+'.json');
  }
  function prepare(text, voiceId, done) {
    const voice = voiceById(voiceId);
    if (!voice || !String(text).trim()) { done(new Error('invalid speech request')); return; }
    text = String(text).trim();
    const metaFile = cacheFile(text,voiceId);
    try {
      const data = JSON.parse(fs.readFileSync(metaFile,'utf8'));
      if (data.voiceId === voiceId && data.text === text && data.file === metaFile.slice(0,-5)+'.mp3'
          && Array.isArray(data.cues) && fs.statSync(data.file).size > 0) { done(null,data); return; }
    } catch {}
    if (pending.has(metaFile)) { pending.get(metaFile).push(done); return; }
    pending.set(metaFile,[done]);
    fs.mkdirSync(cacheDir,{recursive:true,mode:0o700});
    const stem = metaFile.slice(0,-5), temp = `${stem}.${process.pid}.${++sequence}`;
    const rawMetadata = temp+'.json', mp3 = temp+'.mp3', aiff = temp+'.aiff';
    const settle = (err,data) => {
      for (const file of [rawMetadata,mp3,aiff]) { try { fs.unlinkSync(file); } catch {} }
      const callbacks = pending.get(metaFile) || []; pending.delete(metaFile);
      for (const callback of callbacks) callback(err,data);
    };
    const publish = (audio,extension,cues,fallback) => {
      try {
        if (!fs.statSync(audio).size) throw new Error('empty speech audio');
        const file = stem+extension;
        fs.renameSync(audio,file);
        const data = {file,voiceId,text,cues:alignWordCues(text,cues),fallback};
        // Offline fallbacks are intentionally not cached as an online voice.
        if (!fallback) { fs.writeFileSync(rawMetadata,JSON.stringify(data)); fs.renameSync(rawMetadata,metaFile); }
        settle(null,data);
      } catch (err) { settle(err); }
    };
    const fallback = () => execFile('/usr/bin/say',['-v',fallbackVoice,'-r',String(fallbackRate),'-o',aiff,text],{timeout:20000},err=>{
      if (err) settle(err); else publish(aiff,'.aiff',[],true);
    });
    if (!available()) { fallback(); return; }
    execFile(python,[path.join(__dirname,'tts_edge.py'),voice.voice,rate,text,mp3,rawMetadata],{timeout:25000},err=>{
      if (err) { fallback(); return; }
      try { publish(mp3,'.mp3',JSON.parse(fs.readFileSync(rawMetadata,'utf8')).cues,false); }
      catch { fallback(); }
    });
  }
  return {prepare,available,cacheFile};
}

module.exports = { VOICES, SAMPLE, voiceById, alignWordCues, cueAtTime, createSpeechService };
