#!/usr/bin/env python3
"""Real isolated native App -> DMG installation -> LaunchServices App relaunch.

Only HTTPS responses are fixtures. Both package launchers and test-only native
constructors pin the sandbox environment, including after open discards the
original environment. No installed WordPaper or personal data is selected.
"""
import hashlib
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
OLD_VERSION, TARGET_VERSION = '0.0.1', '0.0.2'
spec = importlib.util.spec_from_file_location('package_app', ROOT / 'scripts/package_app.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


def run(args, timeout=120, **kwargs):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True, timeout=timeout, **kwargs)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def events(report):
    if not report.exists(): return []
    return [json.loads(line) for line in report.read_text().splitlines() if line]


def wait_for(predicate, timeout=45):
    end = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < end:
        try:
            result = predicate()
            if result: return result
        except (OSError, ValueError) as error:
            last_error = error
        time.sleep(.1)
    raise AssertionError(f'Timed out waiting for native update: {last_error}')


with tempfile.TemporaryDirectory(prefix='wordpaper-native-update-') as directory:
    temp = Path(directory).resolve()
    data, logs, scratch = temp / 'data', temp / 'logs', temp / 'tmp'
    for folder in (data, logs, scratch): folder.mkdir()
    installed = temp / 'installed/WordPaper.app'
    candidate = temp / 'image/WordPaper.app'
    dmg = temp / 'candidate.dmg'
    preload = temp / 'https-fixture.cjs'
    commands = temp / 'real-commands.jsonl'
    bundle_id = 'org.wordpaper.nativeupdatetest.' + uuid.uuid4().hex
    port, companion_port = free_port(), free_port()
    config = temp / 'companion-config.json'
    config.write_text(json.dumps({'autoSetWallpaper': False, 'petEnabled': False,
                                 'hotkeyEnabled': False, 'autoStart': False}))
    isolated = {
        'NODE_ENV': 'test', 'NODE_OPTIONS': '--require=' + str(preload),
        'PATH': str(Path(shutil.which('node')).parent) + ':/usr/bin:/bin:/usr/sbin:/sbin',
        'PORT': str(port), 'HOST': '127.0.0.1', 'WORDPAPER_MODE': 'local',
        'WORDPAPER_DATA_DIR': str(data), 'WORDPAPER_LOG_DIR': str(logs),
        'WORDPAPER_RUNTIME_DIR': str(temp / 'runtime'), 'TMPDIR': str(scratch),
        'WORDPAPER_COMPANION_DATA_DIR': str(temp / 'companion'),
        'WORDPAPER_CONFIG_PATH': str(config), 'WORDPAPER_STATE_PATH': str(temp / 'companion-state.json'),
        'WORDPAPER_CUSTOM_WORDS_PATH': str(temp / 'custom-words.json'),
        'WORDPAPER_COMPANION_PORT': str(companion_port), 'WORDPAPER_COMPANION_SILENT': '1',
        'WORDPAPER_COMPANION_AUTOSTART': '0', 'WORDPAPER_TEST_MODE': '1', 'WORDPAPER_PUBLIC_ORIGIN': '',
        'WP_UPDATE_FIXTURE_DMG': str(dmg), 'WP_UPDATE_FIXTURE_VERSION': TARGET_VERSION,
        'WP_UPDATE_FIXTURE_COMMANDS': str(commands),
    }
    removed = ['WORDPAPER_SKIP_COMPANION', 'WORDPAPER_SELFTEST', 'WORDPAPER_FORCE_DOWNLOAD',
               'WORDPAPER_NATIVE_TEST_URL', 'WORDPAPER_NATIVE_TEST_EXIT', 'WORDPAPER_NATIVE_TEST_REPORT',
               'WORDPAPER_NATIVE_TEST_RELAUNCHER', 'WORDPAPER_NATIVE_TEST_OPEN_PANEL_FILES']
    preload.write_text(r'''
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {EventEmitter}=require('events'),{Readable}=require('stream');
const cp=require('child_process');
const u=require(path.join(process.cwd(),'lib/updater.js'));
u.__setExecFile((command,args,...rest)=>{
  fs.appendFileSync(process.env.WP_UPDATE_FIXTURE_COMMANDS,JSON.stringify({command,args})+'\n');
  return cp.execFile(command,args,...rest);
});
u.__setHttpsGet((url,cb)=>{
  const request=new EventEmitter();let response;request.destroy=()=>response?.destroy();
  process.nextTick(()=>{
    const file=process.env.WP_UPDATE_FIXTURE_DMG,size=fs.statSync(file).size;
    const tag='companion-v'+process.env.WP_UPDATE_FIXTURE_VERSION;
    if(url.startsWith('https://api.github.com/repos/shangchaovo/wordpaper/releases/')){
      const body=JSON.stringify({tag_name:tag,draft:false,prerelease:false,assets:[{
        name:u.assetForArch(),state:'uploaded',size,
        digest:'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        browser_download_url:'https://github.com/shangchaovo/wordpaper/releases/download/'+tag+'/'+u.assetForArch()
      }]});
      response=Readable.from([body]);response.headers={'content-length':Buffer.byteLength(body)};
    }else if(url==='https://github.com/shangchaovo/wordpaper/releases/download/'+tag+'/'+u.assetForArch()){
      response=fs.createReadStream(file);response.headers={'content-length':size};
    }else{request.emit('error',new Error('Unexpected fixture network request: '+url));return;}
    response.statusCode=200;cb(response);
  });return request;
});
''')

    def build_fixture(app, version):
        package.VERSION = version
        package.build_app(str(app), None)
        contents, resources = app / 'Contents', app / 'Contents/Resources'
        plist_path = contents / 'Info.plist'
        plist = plistlib.loads(plist_path.read_bytes())
        plist['CFBundleIdentifier'] = bundle_id
        plist['CFBundleName'] = 'WordPaper Isolated Update Test'
        plist['CFBundleDisplayName'] = 'WordPaper Isolated Update Test'
        plist.pop('CFBundleURLTypes', None)
        plist_path.write_bytes(plistlib.dumps(plist))
        (resources / 'VERSION').write_text(version)
        fixed_env = {**isolated, 'WORDPAPER_NATIVE_NAVIGATION_REPORT': str(temp / f'native-{version}.jsonl')}
        exports = '\n'.join('export ' + key + '=' + shlex.quote(value) for key, value in fixed_env.items())
        wrapper = 'unset ' + ' '.join(removed) + '\n' + exports + '\n'
        (contents / 'MacOS/launcher.sh').write_text(package.LAUNCHER.replace('set -u\n', 'set -u\n' + wrapper, 1))
        # LaunchServices does not inherit NODE_ENV/report paths. Compile the same
        # real native source with an isolated test environment set before main.
        bootstrap = '#include <stdlib.h>\n__attribute__((constructor)) static void WPFixtureEnvironment(void) {\n'
        bootstrap += ''.join('unsetenv(' + json.dumps(key) + ');\n' for key in removed)
        bootstrap += ''.join('setenv(' + json.dumps(key) + ',' + json.dumps(value) + ',1);\n' for key, value in fixed_env.items())
        bootstrap += '}\n'
        source = temp / f'native-{version}.m'
        source.write_text(bootstrap + (ROOT / 'scripts/native_app.m').read_text())
        run(['clang', '-arch', 'arm64', '-arch', 'x86_64', '-O2', '-fobjc-arc',
             '-mmacosx-version-min=13.0', '-framework', 'Cocoa', '-framework', 'WebKit',
             '-o', contents / 'MacOS/WordPaper', source])
        manifest_path = resources / 'RELEASE_SHA256.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['version'] = version
        for name in manifest['files']:
            manifest['files'][name] = hashlib.sha256((resources / name).read_bytes()).hexdigest()
        for name in manifest['bundleFiles']:
            manifest['bundleFiles'][name] = hashlib.sha256((contents / name).read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        return manifest

    build_fixture(installed, OLD_VERSION)
    target_manifest = build_fixture(candidate, TARGET_VERSION)
    assert hashlib.sha256((installed / 'Contents/MacOS/WordPaper').read_bytes()).hexdigest() != target_manifest['bundleFiles']['MacOS/WordPaper']
    run(['hdiutil', 'create', '-srcfolder', candidate.parent, '-fs', 'HFS+', '-format', 'UDZO', dmg])
    print('PASS stage 1: isolated old/new native bundles and real target DMG built', flush=True)

    # Read OS window metadata, without Accessibility or screen-content access.
    count_source = temp / 'window-count.c'
    count_source.write_text(r'''
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc,char **argv){
  int wanted=atoi(argv[1]),count=0;
  CFArrayRef windows=CGWindowListCopyWindowInfo(kCGWindowListOptionAll,kCGNullWindowID);
  for(CFIndex i=0;windows && i<CFArrayGetCount(windows);i++){
    CFDictionaryRef row=CFArrayGetValueAtIndex(windows,i);int pid=0,layer=0;
    CFNumberRef p=CFDictionaryGetValue(row,kCGWindowOwnerPID),l=CFDictionaryGetValue(row,kCGWindowLayer);
    if(p)CFNumberGetValue(p,kCFNumberIntType,&pid);if(l)CFNumberGetValue(l,kCFNumberIntType,&layer);
    CFBooleanRef shown=CFDictionaryGetValue(row,kCGWindowIsOnscreen);
    if(pid==wanted && layer==0 && shown && CFBooleanGetValue(shown))count++;
  }
  if(windows)CFRelease(windows);printf("%d\n",count);return 0;
}
''')
    count_windows = temp / 'window-count'
    run(['clang', '-framework', 'ApplicationServices', count_source, '-o', count_windows])
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    base = f'http://localhost:{port}'

    def request(route, body=None, method=None, headers=None):
        sent_headers = {'Content-Type': 'application/json', **(headers or {})}
        req = urllib.request.Request(base + route, data=None if body is None else json.dumps(body).encode(),
            method=method, headers=sent_headers)
        return json.load(opener.open(req, timeout=3))

    def native_pids():
        output = run(['ps', '-axo', 'pid=,command='])
        executable = str(installed / 'Contents/MacOS/WordPaper')
        return [int(line.strip().split(None, 1)[0]) for line in output.splitlines()
                if len(line.strip().split(None, 1)) == 2 and line.strip().split(None, 1)[1] == executable]

    old_report, new_report = temp / f'native-{OLD_VERSION}.jsonl', temp / f'native-{TARGET_VERSION}.jsonl'
    sentinel = data / 'preserve-me.txt'; sentinel.write_text('durable user data')
    app_log = (temp / 'native.log').open('wb')
    original = subprocess.Popen([str(installed / 'Contents/MacOS/WordPaper')], stdout=app_log, stderr=app_log)
    new_pid = None
    try:
        wait_for(lambda: request('/healthz')['version'] == OLD_VERSION)
        initial = wait_for(lambda: next((e for e in events(old_report) if e['event'] == 'loaded'), None))
        assert initial['pid'] == original.pid and initial['visible'], initial
        account = request('/api/auth/register', {'username': 'native_update_fixture', 'password': 'isolated-update-password'}, headers={'Origin': base})
        csrf_headers = {'Origin': base, 'X-CSRF-Token': account['csrfToken']}
        reminders = [{'id': 'keep-this', 'text': '保留我的学习记录', 'done': False}]
        review = {'ielts': {'words': {'anchor|锚': {'word': {'word': 'anchor', 'meaning': '锚'},
            'learnedAt': 1234567890000, 'stage': 3, 'due': 9999999999999, 'learnedCount': 2, 'reviewCount': 4, 'events': []}}}}
        for namespace, value in [('reminders', reminders), ('review', review)]:
            request('/api/state/' + namespace, {'value': value, 'expectedRevision': 0}, method='PUT', headers=csrf_headers)
        before = request('/api/state')
        print(f'PASS stage 2: real old native PID {original.pid} loaded; account/reminders/review saved', flush=True)

        result = request('/api/update/apply-local', {}, headers={'X-WordPaper-Local': '1'})
        assert result['started'], result

        def relaunched():
            original.poll()  # Reap the old PID so the real relaunch helper can proceed.
            loaded = next((e for e in events(new_report) if e['event'] == 'loaded'), None)
            return loaded if loaded and original.returncode is not None else None

        try:
            loaded = wait_for(relaunched, timeout=80)
        except AssertionError:
            try: print('Update status:', request('/api/update/status-local', headers={'X-WordPaper-Local': '1'}))
            except OSError: pass
            raise
        new_pid = loaded['pid']
        assert original.returncode == 0 and new_pid != original.pid and loaded['visible'], loaded
        wait_for(lambda: request('/healthz')['version'] == TARGET_VERSION)
        assert native_pids() == [new_pid], native_pids()
        wait_for(lambda: int(run([count_windows, str(new_pid)]).strip()) == 1, timeout=5)
        assert len({e['windowNumber'] for e in events(new_report)}) == 1
        print(f'PASS stage 3: old PID exited; LaunchServices opened new native PID {new_pid} with exactly one window', flush=True)

        after = request('/api/state')
        assert after['user']['id'] == before['user']['id']
        assert after['state'] == before['state'], (before, after)
        assert after['state']['reminders'] == reminders and after['state']['review'] == review
        assert sentinel.read_text() == 'durable user data'
        assert not (data / 'update-pending.json').exists(), 'New App did not consume successful restart marker'
        assert json.loads((installed / 'Contents/Resources/RELEASE_SHA256.json').read_text()) == target_manifest
        for name, digest in target_manifest['bundleFiles'].items():
            assert hashlib.sha256((installed / 'Contents' / name).read_bytes()).hexdigest() == digest
        actual_commands = events(commands)
        mount = next(e for e in actual_commands if e['command'] == '/usr/bin/hdiutil' and e['args'][0] == 'attach')
        assert '-nobrowse' in mount['args'] and '-noautoopen' in mount['args']
        assert any(e['command'] == '/usr/bin/rsync' for e in actual_commands)
        assert any(e['command'] == '/usr/bin/hdiutil' and e['args'][0] == 'detach' for e in actual_commands)
        print('PASS stage 4: target service/binary healthy, real silent mount/install/unmount completed, all learning data retained', flush=True)
    except Exception:
        for log in logs.glob('*.log'):
            print(log.name + ':\n' + log.read_text(errors='replace')[-6000:], flush=True)
        print('native.log:\n' + (temp / 'native.log').read_text(errors='replace')[-4000:], flush=True)
        raise
    finally:
        for pid in set(native_pids() + ([original.pid] if original.poll() is None else [])):
            try: os.kill(pid, signal.SIGTERM)
            except ProcessLookupError: pass
        try: original.wait(timeout=8)
        except subprocess.TimeoutExpired: original.kill(); original.wait()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and native_pids(): time.sleep(.1)
        # Kill only processes whose cwd belongs to this test's exact bundle.
        for selected_port in (port, companion_port):
            found = subprocess.run(['lsof', '-nP', f'-tiTCP:{selected_port}', '-sTCP:LISTEN'], capture_output=True, text=True)
            for pid in found.stdout.split():
                cwd = subprocess.run(['lsof', '-a', '-p', pid, '-d', 'cwd', '-Fn'], capture_output=True, text=True).stdout
                if str(installed / 'Contents/Resources') in cwd:
                    try: os.kill(int(pid), signal.SIGTERM)
                    except ProcessLookupError: pass
        app_log.close()
        register = Path('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister')
        if register.exists():
            subprocess.run([str(register), '-u', str(installed)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
