import subprocess, pathlib, tempfile, plistlib, hashlib, json
ROOT=pathlib.Path('/Users/xieshangchao/daily-wallpaper')
version=(ROOT/'VERSION').read_text().strip()
files=['server.js','companion.js','package.json','index.html','login.html','VERSION']
for d in ['lib','css','js','data']:
    files += [str(p.relative_to(ROOT)) for p in (ROOT/d).rglob('*') if p.is_file()]
for label in ['AppleSilicon','Intel','Slim']:
    image=ROOT/f'scripts/dist/WordPaper-macOS-{label}.dmg'
    subprocess.run(['hdiutil','verify',str(image)],check=True,stdout=subprocess.DEVNULL)
    with tempfile.TemporaryDirectory(prefix='wp-audit-dmg-') as td:
        mount=pathlib.Path(td)/'mount';mount.mkdir()
        subprocess.run(['hdiutil','attach','-readonly','-nobrowse','-mountpoint',str(mount),str(image)],check=True,stdout=subprocess.DEVNULL)
        try:
            app=mount/'WordPaper.app';res=app/'Contents/Resources'
            info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
            assert info['CFBundleShortVersionString']==version
            mismatches=[f for f in files if not (res/f).exists() or (res/f).read_bytes()!=(ROOT/f).read_bytes()]
            manifest=json.loads((res/'RELEASE_SHA256.json').read_text())
            assert manifest['version']==version
            assert all(hashlib.sha256((res/f).read_bytes()).hexdigest()==h for f,h in manifest['files'].items())
            print(json.dumps({'variant':label,'version':version,'payload_files':len(files),'mismatches':mismatches,'favicon_present':(res/'assets/favicon-32.png').exists(),'universal_stub':subprocess.check_output(['lipo','-archs',str(app/'Contents/MacOS/WordPaper')],text=True).strip()},ensure_ascii=False),flush=True)
        finally:
            subprocess.run(['hdiutil','detach',str(mount)],check=True,stdout=subprocess.DEVNULL)
