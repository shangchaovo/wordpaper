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

function createSpeechService({ cacheDir, edgeBin = '', execFile, runtimeDir = path.join(__dirname,'tts-runtime',process.arch), rate = '+0%' }) {
  const pending = new Map();
  let sequence = 0;
  const bundledPython = path.join(runtimeDir, 'bin', 'python3');
  const python = fs.existsSync(bundledPython) ? bundledPython : path.join(path.dirname(edgeBin), 'python');
  const available = () => fs.existsSync(python) && (python === bundledPython || fs.existsSync(edgeBin));
  function cacheFile(text, selection) {
    const identity = typeof selection === 'string' ? ['word-boundary-v1', selection, rate, text]
      : ['api-speech-v1', selection.userId, selection.baseUrl, selection.model, selection.voice, text];
    const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    return path.join(cacheDir, key + '.json');
  }
  function prepare(text, selection, done) {
    text = String(text || '').trim();
    const remote = selection && typeof selection === 'object';
    const voiceId = remote ? selection.id : selection;
    const voice = remote ? selection : voiceById(voiceId);
    if (!voice || !text) return done(new Error('invalid speech request'));
    const metaFile = cacheFile(text, selection), file = metaFile.slice(0,-5) + '.mp3';
    try {
      const data = JSON.parse(fs.readFileSync(metaFile,'utf8'));
      if (data.text === text && data.file === file && Array.isArray(data.cues) && fs.statSync(file).size > 0) {
        done(null, { ...data, voiceId }); return;
      }
    } catch {}
    if (pending.has(metaFile)) { pending.get(metaFile).push(done); return; }
    pending.set(metaFile, [done]);
    const temp = file + '.' + process.pid + '.' + (++sequence);
    const rawMetadata = temp + '.json', mp3 = temp + '.mp3';
    async function synthesize() {
      fs.mkdirSync(cacheDir,{recursive:true,mode:0o700});
      let cues = [];
      if (remote) {
        const audio = await require('./speech-provider').generateSpeech(selection, text);
        fs.writeFileSync(mp3, audio, {mode:0o600});
      } else {
        if (!available()) throw new Error('微软语音运行时不可用');
        await new Promise((resolve,reject) => execFile(python,
          [path.join(__dirname,'tts_edge.py'),voice.voice,rate,text,mp3,rawMetadata],
          {timeout:25000}, err => err ? reject(err) : resolve()));
        cues = alignWordCues(text, JSON.parse(fs.readFileSync(rawMetadata,'utf8')).cues);
      }
      if (!fs.statSync(mp3).size) throw new Error('empty speech audio');
      const data = {file,voiceId,text,cues,fallback:false};
      fs.writeFileSync(rawMetadata, JSON.stringify(data), {mode:0o600});
      fs.renameSync(mp3, file);
      fs.renameSync(rawMetadata, metaFile);
      return data;
    }
    function settle(error, data) {
      for (const tempFile of [mp3,rawMetadata]) { try { fs.unlinkSync(tempFile); } catch {} }
      const callbacks = pending.get(metaFile);
      pending.delete(metaFile);
      for (const callback of callbacks) callback(error, data);
    }
    synthesize().then(data => settle(null,data), err => settle(err));
  }
  return {prepare,available,cacheFile};
}

module.exports = { VOICES, SAMPLE, voiceById, alignWordCues, cueAtTime, createSpeechService };
