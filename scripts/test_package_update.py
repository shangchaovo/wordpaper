#!/usr/bin/env python3
"""Build an isolated Slim app, then install it with real hdiutil and rsync."""
import hashlib
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

with tempfile.TemporaryDirectory(prefix='wordpaper-package-update-') as folder:
    temp = Path(folder)
    package.BUILD = str(temp / 'build'); Path(package.BUILD).mkdir()
    source = temp / 'image/WordPaper.app'
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
    dmg = temp / 'candidate.dmg'
    run(['hdiutil', 'create', '-srcfolder', source.parent, '-fs', 'HFS+', '-format', 'UDZO', dmg])
    installed = temp / 'installed/WordPaper.app/Contents'
    oldres = installed / 'Resources'; oldres.mkdir(parents=True)
    (installed / 'MacOS').mkdir()
    (installed / 'MacOS/launcher.sh').write_text('#!/bin/bash\necho old\n')
    (installed / 'MacOS/WordPaper').write_text('old native binary')
    (installed / 'MacOS/WordPaper').chmod(0o755)
    (installed / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleVersion': '0.0.1'}))
    (oldres / 'VERSION').write_text('0.0.1')
    (oldres / 'server.js').write_text('old server')
    (oldres / 'RELEASE_SHA256.json').write_text('{"version":"0.0.1","files":{}}')
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
u.applyUpdate('0.0.1',process.env.WP_PACKAGE_VERSION,()=>{}).then(()=>console.log('PASS real hdiutil + rsync install')).catch(e=>{console.error(e);process.exitCode=1;});
''')
    env = {**os.environ, 'WORDPAPER_DATA_DIR': str(state), 'WP_PACKAGE_ROOT': str(ROOT),
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
        print('PASS installed server, favicon, launcher, Info.plist, manifest and user-data preservation', flush=True)
    finally:
        proc.terminate()
        try: proc.wait(timeout=8)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
