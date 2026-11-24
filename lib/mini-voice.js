'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {promisify} = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const ai = require('./ai-model');
const speech = require('./speech');
const provider = require('./speech-provider');

const macCandidates = [
  {id:'aria',language:'en_US',accent:'美式英语',names:['Samantha','Ava','Allison','Flo','Kathy']},
  {id:'guy',language:'en_US',accent:'美式英语',names:['Alex','Tom','Evan','Eddy','Fred']},
  {id:'sonia',language:'en_GB',accent:'英式英语',names:['Serena','Kate','Stephanie','Flo','Shelley']},
  {id:'ryan',language:'en_GB',accent:'英式英语',names:['Daniel','Oliver','Eddy','Reed']}
];
async function systemInventory() {
  if (process.platform === 'darwin') {
    const {stdout} = await exec('/usr/bin/say',['-v','?'],{timeout:5000});
    const installed = stdout.split('\n').flatMap(line => {
      const match = /^\s*(.+?)\s+(en_US|en_GB)\s+#/.exec(line);
      if (!match) return [];
      const selector = match[1].trim();
      return [{selector, language:match[2], name:selector.replace(/\s*[（(].*$/, '')}];
    });
    const choices = [];
    for (const slot of macCandidates) {
      for (const name of slot.names) {
        const actual=installed.find(row=>row.language===slot.language && row.name===name);
        if (actual) { choices.push({id:slot.id,name,accent:slot.accent,selector:actual.selector}); break; }
      }
    }
    return {engine:choices.length?'macos':'unavailable', choices};
  }
  const {stdout} = await exec('espeak-ng',['--voices'],{timeout:5000});
  const languages=new Set(stdout.split('\n').flatMap(line=>{
    const m=/^\s*\d+\s+(\S+)/.exec(line); return m?[m[1].toLowerCase()]:[];
  }));
  const choices=[];
  if(languages.has('en-us')) choices.push({id:'aria',name:'eSpeak NG',accent:'美式英语',selector:'en-us'});
  if(languages.has('en-gb')) choices.push({id:'sonia',name:'eSpeak NG',accent:'英式英语',selector:'en-gb'});
  // Older eSpeak inventories expose a single default English entry.
  if(!choices.length && languages.has('en')) choices.push({id:'aria',name:'eSpeak NG',accent:'英语',selector:'en'});
  return {engine:choices.length?'espeak':'unavailable',choices};
}

function createMiniVoice({storage, learning, dataDir, allowPrivate = false}) {
  const edge = speech.createSpeechService({cacheDir:path.join(dataDir,'mini-audio'),edgeBin:process.env.WORDPAPER_MINI_EDGE_BIN || path.join(__dirname,'../.venv-tts/bin/edge-tts'),execFile:require('node:child_process').execFile});
  const examples = storage.createMiniExamples((messages, opts) => ai.complete(storage.models.get(opts.userId),messages,{allowPrivate, maxTokens:opts.maxTokens}));
  const active = new Map(), cache = new Map();
  let bytes = 0;
  let inventory, scanAt = 0;
  function getInventory() {
    if (edge.available()) return Promise.resolve({
      engine: 'edge', choices: speech.VOICES.map(({id,name,accent}) => ({id,name,accent,selector:id}))
    });
    if (!inventory || Date.now() - scanAt > 300000) {
      scanAt = Date.now();
      inventory = systemInventory().catch(() => ({engine:'unavailable',choices:[]}));
    }
    return inventory;
  }
  function effectivePreset(choices, saved) {
    const previous = speech.voiceById(saved);
    return choices.find(v => v.id === saved) || choices.find(v => v.accent === previous?.accent) || choices[0];
  }
  async function settings(userId) {
    const prefs = storage.getState(userId).state.settings?.miniSpeech || {};
    const s = storage.speech.summary(userId);
    const {engine, choices} = s.configured ? {engine:'account',choices:[]} : await getInventory();
    return {
      configured: s.configured, model: s.configured ? s.model : '', voice: s.configured ? s.voice : '', engine,
      preset: effectivePreset(choices,prefs.preset)?.id || null,
      rate: [0.85,1,1.15].includes(prefs.rate) ? prefs.rate : 1,
      voices: choices.map(({id,name,accent}) => ({id,name,accent})), textModel: storage.models.summary(userId).configured
    };
  }
  async function set(userId, prefs, access = {}) {
    if (![0.85,1,1.15].includes(prefs?.rate)) throw ai.failure('invalid_voice','请选择有效的播放速度。');
    // Older clients may submit an Edge preset while an account provider is active.
    const supplied = prefs.preset != null && prefs.preset !== '';
    if (supplied && !speech.voiceById(prefs.preset)) throw ai.failure('invalid_voice','请选择有效的音色。');
    const selection = supplied ? effectivePreset((await getInventory()).choices,prefs.preset) : null;
    storage.miniLearningTransaction(userId, tx => {
      access.authorize?.();
      const previous = tx.get('settings', {}) || {};
      const next = {...previous, miniSpeech:{...previous.miniSpeech,rate:prefs.rate}};
      if (selection) next.miniSpeech.preset = selection.id;
      tx.put('settings', next, Date.now());
    });
    return settings(userId);
  }
  function entry(userId,id) {
    const word=learning.word(userId,id);
    if(!word) throw ai.failure('word_missing','词条已变更，请刷新记忆本。',404);
    return word;
  }
  function example(userId,id,access = {}) {
    const w=entry(userId,id);
    if(w.example) return Promise.resolve({en:w.example,zh:w.translation||''});
    return examples.ensure(userId,w.library,{...w,phonetic:w.ipa},access);
  }
  async function presetAudio(text, engine, choice) {
    if(!choice) throw ai.failure('voice_unavailable','当前服务没有可用的英语声音，请配置账号 AI 语音。',503);
    if(engine==='edge') {
      const result=await new Promise((resolve,reject)=>edge.prepare(text,choice.selector,(err,value)=>err?reject(err):resolve(value)));
      return {buffer:await fs.promises.readFile(result.file), type:'audio/mpeg'};
    }
    // System voices are also available offline in the DevTools simulator.
    const folder=await fs.promises.mkdtemp(path.join(os.tmpdir(),'wp-speech-'));
    const filename=path.join(folder,'word.wav');
    try {
      if(process.platform==='darwin') await exec('/usr/bin/say',['-v',choice.selector,'-o',filename,'--file-format=WAVE','--data-format=LEI16@22050','--',text],{timeout:15000});
      else await exec('espeak-ng',['-v',choice.selector,'-s','155','-w',filename,'--',text],{timeout:15000});
      return {buffer:await fs.promises.readFile(filename),type:'audio/wav'};
    } finally {await fs.promises.rm(folder,{recursive:true,force:true});}
  }
  async function audio(userId,id,part,access = {}) {
    if(!['word','sentence'].includes(part)) throw ai.failure('invalid_part','发音类型无效。');
    const w=entry(userId,id);
    const text=part==='word'?w.word:(await example(userId,id,access)).en;
    access.authorize?.();
    if(!text || text.length>1200) throw ai.failure('invalid_text','词条文字过长或为空。');
    const config=storage.speech.get(userId);
    const inventory=config?{engine:'account',choices:[]}:await getInventory();
    const preset=storage.getState(userId).state.settings?.miniSpeech?.preset;
    const selected=effectivePreset(inventory.choices,preset);
    const key=JSON.stringify([userId,config?.baseUrl,config?.voice,config?.model,inventory.engine,selected?.selector,text]);
    if(cache.has(key))return cache.get(key);
    if(active.has(userId)) {
      const other=active.get(userId);
      if(other.key===key)return other.promise;
      throw ai.failure('voice_busy','上一段正在合成，请稍后重试。',429);
    }
    const promise=(async()=>{
      let result;
      try {
        result=config?{buffer:await provider.generateSpeech(config,text,{allowPrivate}),type:'audio/mpeg'}:await presetAudio(text,inventory.engine,selected);
      }catch(err){if(err.status)throw err;throw ai.failure('voice_unavailable','暂时无法生成音频，请检查账号的朗读设置。',503);}
      access.authorize?.();
      cache.set(key,result);bytes+=result.buffer.length;
      while(bytes>16*1024*1024 && cache.size){const first=cache.keys().next().value;bytes-=cache.get(first).buffer.length;cache.delete(first);}
      return result;
    })().finally(()=>active.delete(userId));
    active.set(userId,{key,promise});
    return promise;
  }
  return {settings,set,example,audio};
}
module.exports={createMiniVoice};
