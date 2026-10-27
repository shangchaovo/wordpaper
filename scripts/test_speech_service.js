'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createSpeechService,alignWordCues,cueAtTime}=require('../lib/speech');
const {mouthTarget,advanceMouth}=require('../lib/patrick-mouth');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wordpaper-speech-service-'));
const boundaries=words=>words.map((text,i)=>({text,start:i*.5,end:i*.5+.4}));
const prepare=(service,text,voice)=>new Promise((resolve,reject)=>service.prepare(text,voice,(err,value)=>err?reject(err):resolve(value)));
(async()=>{
  const text='Go, go! Don’t miss café — 𐐀test.';
  const cues=alignWordCues(text,boundaries(['go','go',"don't",'miss','cafe','𐐀test']));
  assert.deepEqual(cues.map(c=>text.slice(c.from,c.to)),['Go','go','Don’t','miss','café','𐐀test']);
  assert.equal(cueAtTime(cues,.45),null,'silence must not highlight a guessed word');
  assert.equal(cueAtTime(cues,.55),cues[1]);
  assert.equal(cueAtTime(cues,999),null);
  console.log('PASS repeated words / punctuation / Unicode / genuine cue boundaries');
  const cue={text:'you',start:0,end:1};
  assert.equal(mouthTarget(-160,cue,true,true,false).open,0);
  assert.equal(mouthTarget(-12,null,true,true,false).open,0,'lips close between timed words');
  assert.equal(mouthTarget(-12,cue,true,false,false).open,0);
  assert.equal(mouthTarget(-12,cue,true,true,true).open,0);
  assert.ok(mouthTarget(-12,cue,true,true,false).open>mouthTarget(-37,cue,true,true,false).open);
  assert.ok(mouthTarget(-20,null,false,true,false).open>0,'offline audio still has a real envelope');
  let mouth={open:0,round:0},target=mouthTarget(-18,cue,true,true,false);
  mouth=advanceMouth(mouth,target,50);assert.ok(mouth.open>0 && mouth.open<target.open);
  for(let i=0;i<5;i++)mouth=advanceMouth(mouth,{open:0,round:0},50);
  assert.equal(mouth.open,0,'a pause must settle to a closed mouth within 250 ms');
  console.log('PASS lips follow amplitude / timed silence / smooth attack-release / fallback / reduced motion');

  const bin=path.join(temp,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'edge-tts'),'');fs.writeFileSync(path.join(bin,'python'),'');
  const jobs=[];
  const service=createSpeechService({cacheDir:path.join(temp,'cache'),edgeBin:path.join(bin,'edge-tts'),
    execFile:(...args)=>jobs.push(args)});
  const a=prepare(service,'Hello world.','aria'),duplicate=prepare(service,'Hello world.','aria'),b=prepare(service,'Hello world.','guy');
  assert.equal(jobs.length,2,'same voice prewarm and click must share synthesis');
  function finish(job){const [,args,,cb]=job;fs.writeFileSync(args[4],'audio');fs.writeFileSync(args[5],JSON.stringify({cues:boundaries(['Hello','world'])}));cb(null);}
  finish(jobs[1]);finish(jobs[0]);
  const [one,two,other]=await Promise.all([a,duplicate,b]);
  assert.equal(one.file,two.file);assert.notEqual(one.file,other.file);
  assert.equal(one.cues[1].text,'world');assert.equal(one.cues[1].start,.5);
  assert.deepEqual(await prepare(service,'Hello world.','aria'),one);assert.equal(jobs.length,2);
  console.log('PASS concurrent synthesis / voice-specific cache / timing survives cache');

  const failed=prepare(service,'Offline sample','sonia');
  jobs.at(-1)[3](new Error('offline'));
  const fallback=jobs.at(-1);assert.equal(fallback[0],'/usr/bin/say');
  fs.writeFileSync(fallback[1][fallback[1].indexOf('-o')+1],'aiff');fallback[3](null);
  const offline=await failed;assert.equal(offline.fallback,true);assert.deepEqual(offline.cues,[]);
  assert.equal(fs.existsSync(service.cacheFile('Offline sample','sonia')),false);
  const retry=prepare(service,'Offline sample','sonia');finish(jobs.at(-1));
  assert.equal((await retry).fallback,false);
  await assert.rejects(prepare(service,'anything','not-a-voice'));
  console.log('PASS honest offline fallback / online recovery / voice allowlist');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
