'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'wordpaper-voices-'));
let child;
(async()=>{
  const portServer=http.createServer();portServer.listen(0,'127.0.0.1');await once(portServer,'listening');
  const port=portServer.address().port;portServer.close();await once(portServer,'close');
  const base='http://127.0.0.1:'+port;
  const clip=path.join(temp,'fixture.mp3');fs.writeFileSync(clip,Buffer.from('0123456789abcdef'));
  // Replace only external synthesis. HTTP validation, persistence and range
  // streaming still run through the real companion in an isolated data dir.
  const preload=path.join(temp,'audio.cjs');
  fs.writeFileSync(preload,`const speech=require(${JSON.stringify(path.join(root,'lib/speech.js'))});
    speech.createSpeechService=()=>({prepare(text,voice,done){setTimeout(()=>done(null,{file:${JSON.stringify(clip)},
      cues:speech.alignWordCues(text,text.split(' ').map((text,i)=>({text,start:i*.2,end:i*.2+.18}))),fallback:false}),voice==='ryan'?150:0);}});`);
  async function start(){
    child=spawn(process.execPath,['--require',preload,path.join(root,'companion.js')],{stdio:'ignore',env:{...process.env,
      WORDPAPER_TEST_MODE:'1',WORDPAPER_PORT:String(port),WORDPAPER_COMPANION_DATA_DIR:temp,
      WORDPAPER_CONFIG_PATH:path.join(temp,'config.json'),WORDPAPER_STATE_PATH:path.join(temp,'state.json'),
      WORDPAPER_CUSTOM_WORDS_PATH:path.join(temp,'custom.json')}});
    for(let i=0;i<80;i++){try{if((await fetch(base+'/pet-voices.json')).ok)return;}catch{}await new Promise(r=>setTimeout(r,30));}
    throw new Error('isolated companion did not start');
  }
  async function request(url,body,headers={}){
    const r=await fetch(base+url,body?{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}:{headers});
    return {status:r.status,data:await r.json().catch(()=>({}))};
  }
  await start();
  const initial=await request('/pet-voices.json');assert.equal(initial.data.voices.length,4);assert.equal(initial.data.selected,'aria');
  assert.equal((await fetch(base+'/pet-voice.php')).status,405);
  assert.equal((await request('/pet-voice.php',{voiceId:'guy'},{Origin:'https://example.com'})).status,403);
  assert.equal((await request('/pet-voice.php',{voiceId:'arbitrary-command'})).status,400);
  assert.equal((await request('/pet-voice.php',{voiceId:'sonia'})).data.selected,'sonia');
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp,'config.json'))).speechVoice,'sonia');
  const menu=await fetch(base+'/menu-status.json',{headers:{'X-WordPaper-Local':'1'}});
  assert.equal((await menu.json()).selectedVoice,'sonia');
  assert.equal((await fetch(base+'/menu.php?cmd=voice-settings',{method:'POST',headers:{'X-WordPaper-Local':'1'}})).status,400);
  console.log('PASS inline menu state / no standalone voice window / 4 voices / validated persistent selection');

  const preview=await request('/pet-voice-preview.php',{voiceId:'guy'});assert.equal(preview.status,200);assert.equal(preview.data.cues.length,9);
  assert.equal((await request('/pet-voices.json')).data.selected,'sonia','audition must not change selected voice');
  const partial=await fetch(base+preview.data.url,{headers:{Range:'bytes=2-5'}});
  assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),'bytes 2-5/16');assert.equal(await partial.text(),'2345');
  assert.equal((await fetch(base+preview.data.url,{headers:{Range:'bytes=99-100'}})).status,416);
  assert.equal((await fetch(base+'/pet-voice-audio.php?id=../../config.json')).status,404);
  assert.equal((await fetch(base+'/lib/speech.js')).status,404);
  assert.equal((await fetch(base+'/lib/tts_edge.py')).status,404);
  for(const file of ['/pet-voices.html','/css/pet-voices.css','/js/pet-voices.js'])assert.equal((await fetch(base+file)).status,200);
  const old=request('/pet-voice-preview.php',{voiceId:'ryan'});
  await new Promise(r=>setTimeout(r,30));
  const latest=await request('/pet-voice-preview.php',{voiceId:'aria'});assert.equal(latest.status,200);assert.equal((await old).status,409);
  console.log('PASS audition / actual cue payload / audio range / no file exposure / stale preview rejected');
  const exit=once(child,'exit');child.kill();await exit;await start();
  assert.equal((await request('/pet-voices.json')).data.selected,'sonia');
  console.log('PASS voice survives companion restart');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(child && child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
  fs.rmSync(temp,{recursive:true,force:true});
});
