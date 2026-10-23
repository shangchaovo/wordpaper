const fs=require('fs'),os=require('os'),path=require('path'),{EventEmitter}=require('events');
const root='/Users/xieshangchao/daily-wallpaper';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wp-real-install-audit-'));
os.homedir=()=>path.join(temp,'home');
const res=path.join(temp,'WordPaper.app','Contents','Resources');fs.mkdirSync(res,{recursive:true});
for(const name of ['server.js','companion.js','package.json','index.html','login.html','VERSION','lib','css','js','data']) fs.cpSync(path.join(root,name),path.join(res,name),{recursive:true});
fs.writeFileSync(path.join(res,'VERSION'),'2.4.4\n');
fs.writeFileSync(path.join(res,'RELEASE_SHA256.json'),JSON.stringify({version:'2.4.4',files:{}}));
const macos=path.join(res,'..','MacOS');fs.mkdirSync(macos);fs.writeFileSync(path.join(macos,'launcher.sh'),'OLD LAUNCHER SENTINEL');
const u=require(path.join(res,'lib/updater.js'));
u.__setHttpsGet((url,cb)=>{
  const req=new EventEmitter();let stream;
  req.destroy=()=>stream?.destroy();
  process.nextTick(()=>{
    const dmg=path.join(root,'scripts/dist/WordPaper-macOS-AppleSilicon.dmg');
    stream=fs.createReadStream(dmg);stream.statusCode=200;stream.headers={'content-length':fs.statSync(dmg).size};cb(stream);
  });return req;
});
(async()=>{
  console.log('ARTIFACT_DIR',temp);
  const result=await u.applyUpdate('2.4.4','2.4.5',()=>{});
  console.log(JSON.stringify({result,version:fs.readFileSync(path.join(res,'VERSION'),'utf8').trim(),manifestVersion:JSON.parse(fs.readFileSync(path.join(res,'RELEASE_SHA256.json'),'utf8')).version,launcher:fs.readFileSync(path.join(macos,'launcher.sh'),'utf8'),flag:JSON.parse(fs.readFileSync(path.join(os.homedir(),'.wordpaper/update-pending.json'),'utf8')),faviconPresent:fs.existsSync(path.join(res,'assets/favicon-32.png'))}));
})().catch(e=>{console.error(e);process.exitCode=1;});
