#!/usr/bin/env python3
"""Build an isolated Slim app, then install it with real hdiutil and rsync."""
import hashlib
import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_app', ROOT / 'scripts/package_app.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)

def run(args, **kw):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True, timeout=120, **kw)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout

parser = argparse.ArgumentParser()
parser.add_argument('--baseline-dmg', type=Path, help='Test the updater from a real previously published package')
parser.add_argument('--candidate-dmg', type=Path, help='Install the exact release candidate, without rebuilding it')
parser.add_argument('--speech', action='store_true', help='Verify all four voices using only the installed runtime')
args = parser.parse_args()

def copy_app(dmg, destination, mount):
    run(['hdiutil', 'attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mount, dmg.resolve()])
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        run(['ditto', mount / 'WordPaper.app', destination])
    finally:
        run(['hdiutil', 'detach', mount, '-force'])

with tempfile.TemporaryDirectory(prefix='wordpaper-package-update-') as folder:
    temp = Path(folder)
    package.BUILD = str(temp / 'build'); Path(package.BUILD).mkdir()
    source = temp / 'image/WordPaper.app'
    if args.candidate_dmg:
        copy_app(args.candidate_dmg, source, temp / 'candidate-mount')
    else:
        package.build_app(str(source), None)
    res = source / 'Contents/Resources'
    manifest = json.loads((res / 'RELEASE_SHA256.json').read_text())
    assert (res / 'assets/favicon-32.png').is_file()
    for name, digest in manifest['files'].items():
        assert hashlib.sha256((res / name).read_bytes()).hexdigest() == digest
    for name, digest in manifest['bundleFiles'].items():
        assert hashlib.sha256((source / 'Contents' / name).read_bytes()).hexdigest() == digest
    assert {'arm64', 'x86_64'} <= set(run(['lipo', '-archs', source / 'Contents/MacOS/WordPaper']).split())
    print('PASS built app contains assets, complete manifest and universal stub', flush=True)
    dmg = args.candidate_dmg.resolve() if args.candidate_dmg else temp / 'candidate.dmg'
    if not args.candidate_dmg:
        run(['hdiutil', 'create', '-srcfolder', source.parent, '-fs', 'HFS+', '-format', 'UDZO', dmg])
    installed = temp / 'installed/WordPaper.app/Contents'
    oldres = installed / 'Resources'
    if args.baseline_dmg:
        copy_app(args.baseline_dmg, installed.parent, temp / 'baseline-mount')
        current = (oldres / 'VERSION').read_text().strip()
        updater_root = oldres
        assert not (oldres / 'assets/pet-voices.html').exists(), 'Baseline must predate the new menu page'
        print('PASS using released updater from v' + current, flush=True)
    else:
        oldres.mkdir(parents=True); (installed / 'MacOS').mkdir()
        (installed / 'MacOS/launcher.sh').write_text('#!/bin/bash\necho old\n')
        (installed / 'MacOS/WordPaper').write_text('old native binary')
        (installed / 'MacOS/WordPaper').chmod(0o755)
        (installed / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleVersion': '0.0.1'}))
        (oldres / 'VERSION').write_text('0.0.1')
        (oldres / 'server.js').write_text('old server')
        (oldres / 'RELEASE_SHA256.json').write_text('{"version":"0.0.1","files":{}}')
        current = '0.0.1'; updater_root = ROOT
    state = temp / 'state'; state.mkdir()
    (state / 'user-data.txt').write_text('keep user data')
    runner = temp / 'apply.cjs'
    runner.write_text('''
const fs=require('fs'),{EventEmitter}=require('events'),{Readable}=require('stream'),crypto=require('crypto');
const u=require(process.env.WP_PACKAGE_ROOT+'/lib/updater.js');
u.__setRunningFrom(process.env.WP_PACKAGE_DEST);
u.__setHttpsGet((url, cb)=>{
  const req=new EventEmitter(); let stream; req.destroy=()=>stream?.destroy();
  process.nextTick(()=>{
    const size=fs.statSync(process.env.WP_PACKAGE_DMG).size;
    if(url.startsWith('https://api.github.com/')) {
      const tag='companion-v'+process.env.WP_PACKAGE_VERSION;
      const body=JSON.stringify({tag_name:tag,draft:false,prerelease:false,assets:[{name:u.assetForArch(),state:'uploaded',size,
        digest:'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(process.env.WP_PACKAGE_DMG)).digest('hex'),
        browser_download_url:'https://github.com/shangchaovo/wordpaper/releases/download/'+tag+'/'+u.assetForArch()}]});
      stream=Readable.from([body]);stream.headers={'content-length':Buffer.byteLength(body)};
    } else {stream=fs.createReadStream(process.env.WP_PACKAGE_DMG);stream.headers={'content-length':size};}
    stream.statusCode=200;cb(stream);
  });return req;
});
u.applyUpdate(process.env.WP_PACKAGE_CURRENT,process.env.WP_PACKAGE_VERSION,()=>{}).then(()=>console.log('PASS real hdiutil + rsync install')).catch(e=>{console.error(e);process.exitCode=1;});
''')
    env = {**os.environ, 'WORDPAPER_DATA_DIR': str(state), 'WP_PACKAGE_ROOT': str(updater_root), 'WP_PACKAGE_CURRENT': current,
           'WP_PACKAGE_DEST': str(oldres), 'WP_PACKAGE_DMG': str(dmg), 'WP_PACKAGE_VERSION': package.VERSION}
    print(run(['node', runner], env=env).strip(), flush=True)
    assert (installed / 'MacOS/launcher.sh').read_text() == package.LAUNCHER
    assert (installed / 'MacOS/WordPaper').read_bytes() == (source / 'Contents/MacOS/WordPaper').read_bytes()
    assert (installed / 'MacOS/WordPaper').stat().st_mode & 0o111
    assert plistlib.loads((installed / 'Info.plist').read_bytes())['CFBundleVersion'] == package.VERSION
    assert json.loads((oldres / 'RELEASE_SHA256.json').read_text()) == manifest
    assert (state / 'user-data.txt').read_text() == 'keep user data'
    flag = json.loads((state / 'update-pending.json').read_text())
    assert flag['to'] == package.VERSION and flag['nativeReplaced'] is True
    assert flag['appPath'] == str(installed.parent.resolve())
    for name, digest in manifest['files'].items():
        assert hashlib.sha256((oldres / name).read_bytes()).hexdigest() == digest
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    env.update(PORT=str(port), HOST='127.0.0.1', WORDPAPER_MODE='public', NODE_ENV='test', WORDPAPER_COMPANION_AUTOSTART='0')
    proc = subprocess.Popen(['node', str(oldres / 'server.js')], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        for _ in range(80):
            try:
                health = json.load(opener.open(f'http://127.0.0.1:{port}/healthz', timeout=1)); break
            except OSError: time.sleep(.1)
        else: raise AssertionError('installed server did not start')
        assert health['version'] == package.VERSION
        with opener.open(f'http://127.0.0.1:{port}/assets/favicon-32.png') as response:
            assert response.status == 200 and response.read() == (ROOT / 'assets/favicon-32.png').read_bytes()
        for route, file in [('pet-voices.html', 'assets/pet-voices.html'), ('css/pet-voices.css', 'css/pet-voices.css'), ('js/pet-voices.js', 'js/pet-voices.js')]:
            with opener.open(f'http://127.0.0.1:{port}/' + route) as response:
                assert response.status == 200 and response.read() == (res / file).read_bytes()
        print('PASS installed server, favicon, launcher, Info.plist, manifest and user-data preservation', flush=True)
    finally:
        proc.terminate()
        try: proc.wait(timeout=8)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    if args.baseline_dmg:
        print(run(['python3', ROOT / 'scripts/test_native_app.py'], env={**os.environ, 'WORDPAPER_TEST_APP': str(installed.parent)}).strip(), flush=True)
    if args.speech:
        speech = temp / 'speech.cjs'
        speech.write_text('''
const {createSpeechService,VOICES,SAMPLE}=require(process.env.WP_SPEECH_ROOT+'/lib/speech');
const service=createSpeechService({cacheDir:process.env.WP_SPEECH_CACHE,edgeBin:'/nonexistent/developer/edge-tts',execFile:require('child_process').execFile});
if(!service.available())throw new Error('Installed speech runtime unavailable');
(async()=>{for(const voice of VOICES){
  const audio=await new Promise((resolve,reject)=>service.prepare(SAMPLE,voice.id,(err,value)=>err?reject(err):resolve(value)));
  if(audio.fallback || audio.cues.length!==9)throw new Error('Installed voice failed: '+voice.id);
  console.log('PASS installed '+voice.name+' audio and nine real word boundaries');
}})().catch(error=>{console.error(error);process.exitCode=1});
''')
        print(run(['node', speech], env={**os.environ, 'WP_SPEECH_ROOT': str(oldres), 'WP_SPEECH_CACHE': str(temp / 'speech-cache')}).strip(), flush=True)
