#!/usr/bin/env python3
"""Exercise the actual settings markup/scripts with an isolated companion fixture."""
import json
import mimetypes
import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect, Error as PlaywrightError

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'scripts/build/shortcut-check'
OUT.mkdir(parents=True, exist_ok=True)
defaults=json.loads(subprocess.check_output(['node','-e',"console.log(JSON.stringify(require('./js/patrick-shortcuts').normalize({})))"],cwd=ROOT,text=True))
state={'bindings':defaults,'fail':False,'writes':0}
errors=[]
html=(ROOT/'index.html').read_text()
html=re.sub(r'<script\b[^>]*src="(?!js/(?:patrick-shortcuts|pet-shortcut-settings)\.js)[^"]*"[^>]*>\s*</script>','',html)

def handle(route):
    path=urlparse(route.request.url).path
    if path=='/pet-shortcuts.php':
        if route.request.method=='POST':
            state['writes']+=1
            if state['fail']:
                return route.fulfill(status=503,content_type='application/json',body=json.dumps({'ok':False,'error':'保存失败，请重试'}))
            state['bindings']=route.request.post_data_json['bindings']
        return route.fulfill(content_type='application/json',body=json.dumps({'ok':True,'bindings':state['bindings']}))
    if path=='/':return route.fulfill(content_type='text/html',body=html)
    file=ROOT/path.lstrip('/')
    if file.is_file():return route.fulfill(content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream',body=file.read_bytes())
    route.fulfill(status=404)

with sync_playwright() as p:
    try:browser=p.chromium.launch(headless=True)
    except PlaywrightError as error:
        if "Executable doesn't exist" not in str(error):raise
        browser=p.chromium.launch(channel='chrome',headless=True)
    page=browser.new_page(viewport={'width':1280,'height':900},device_scale_factor=2)
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('http://wordpaper.test/**',handle)
    page.goto('http://wordpaper.test/')
    page.locator('#btn-pet-shortcuts').click()
    expect(page.locator('.shortcut-key')).to_have_count(23)
    expect(page.locator('[data-action="answer0"]')).to_have_text('A')
    expect(page.locator('[data-action="answer1"]')).to_have_text('S')
    expect(page.locator('[data-action="answer2"]')).to_have_text('D')
    expect(page.locator('[data-action="answer3"]')).to_have_text('F')
    page.locator('[data-action="answer0"]').click();page.keyboard.press('s')
    expect(page.locator('#pet-shortcuts-status')).to_contain_text('冲突')
    expect(page.locator('#pet-shortcuts-save')).to_be_disabled()
    assert state['writes']==0
    page.locator('[data-action="answer0"]').click();page.keyboard.press('j')
    page.locator('#pet-shortcuts-save').click()
    expect(page.locator('#pet-shortcuts-status')).to_contain_text('已保存')
    assert state['bindings']['answer0']=={'code':'KeyJ','mods':0}
    page.locator('#pet-shortcuts-close').click();page.locator('#btn-pet-shortcuts').click()
    expect(page.locator('[data-action="answer0"]')).to_have_text('J')
    page.locator('[data-action="answer0"]').click();page.keyboard.press('Control+j')
    expect(page.locator('[data-action="answer0"]')).to_have_text('⌃J')
    page.locator('#pet-shortcuts-save').click();expect(page.locator('#pet-shortcuts-status')).to_contain_text('已保存')
    assert state['bindings']['answer0']['mods']==2
    page.locator('[data-action="remember"]').click();page.keyboard.press('Backspace')
    expect(page.locator('[data-action="remember"]')).to_have_text('Delete')
    expect(page.locator('#pet-shortcuts-dialog')).to_be_visible()
    page.locator('[data-action="answer1"]').click();page.locator('#pet-shortcuts-cancel-key').click()
    expect(page.locator('[data-action="answer1"]')).to_have_text('S')
    state['fail']=True
    page.locator('#pet-shortcuts-save').click();expect(page.locator('#pet-shortcuts-status')).to_contain_text('保存失败')
    expect(page.locator('#pet-shortcuts-save')).to_be_enabled()
    state['fail']=False
    page.locator('#pet-shortcuts-reset').click()
    expect(page.locator('[data-action="answer0"]')).to_have_text('A')
    page.locator('#pet-shortcuts-save').click();expect(page.locator('#pet-shortcuts-status')).to_contain_text('已保存')
    assert state['bindings']==defaults
    page.locator('#pet-shortcuts-close').click()
    page.goto('http://wordpaper.test/#shortcuts')
    expect(page.locator('#pet-shortcuts-dialog')).to_be_visible()
    expect(page.locator('[data-action="answer0"]')).to_have_text('A')
    page.locator('#pet-shortcuts-dialog').screenshot(path=str(OUT/'settings-desktop.png'))
    page.set_viewport_size({'width':390,'height':844})
    page.locator('#pet-shortcuts-dialog').screenshot(path=str(OUT/'settings-mobile.png'))
    assert page.locator('#pet-shortcuts-dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1'),'settings overflow on small screens'
    assert not errors,errors
    print('PASS settings ASDF defaults / conflict blocking / recording / modifier keys / save and reopen / failure recovery / reset / keyboard deep link / narrow layout')
    browser.close()
