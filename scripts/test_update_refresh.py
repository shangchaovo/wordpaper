#!/usr/bin/env python3
"""refresh=1 endpoint test: forces a fresh probe; when a newer version exists upstream, check reports it."""
import os, socket, subprocess, tempfile, time, shutil, json, http.cookiejar
from urllib.request import Request, urlopen, build_opener, HTTPCookieProcessor
from urllib.error import HTTPError

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

port = free_port()
data_dir = tempfile.mkdtemp(prefix="wp-upd-ref-")
env = dict(os.environ, PORT=str(port), HOST="127.0.0.1", WORDPAPER_MODE="local",
           WORDPAPER_DATA_DIR=data_dir, NODE_ENV="test")
env["WORDPAPER_FAKE_BUNDLED_VERSION"] = ""   # not wired; bundle version comes from VERSION file
results = []
def check(name, ok):
    results.append((name, bool(ok)))
    print(("PASS  " if ok else "FAIL  ") + name)

server = subprocess.Popen(["node", "server.js"], cwd="/Users/xieshangchao/daily-wallpaper", env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
try:
    base = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try: urlopen(base + "/login.html", timeout=1); break
        except Exception: time.sleep(0.2)
    jar = http.cookiejar.CookieJar()
    opener = build_opener(HTTPCookieProcessor(jar))
    opener.open(Request(base + "/api/auth/register", method="POST", data=json.dumps({"username": "ref1", "password": "refresh-test-1"}).encode(), headers={"Content-Type": "application/json", "Origin": base}), timeout=10)

    # current=2.3.1 (repo VERSION) → upstream 2.3.1 → NOT available
    d = json.loads(opener.open(base + "/api/update/check?refresh=1", timeout=20).read())
    check("refresh=1 正常返回", "available" in d)
    check("当前版本=2.3.1 时不提示更新", d["available"] is False and d["current"] == "2.3.1")
    # second refresh within 30s rate limit — should not crash, still fine
    d2 = json.loads(opener.open(base + "/api/update/check?refresh=1", timeout=20).read())
    check("refresh 限速内重复调用不崩", "available" in d2)
    # status endpoint still works
    d3 = json.loads(opener.open(base + "/api/update/status", timeout=10).read())
    check("status 端点无 applying 状态", d3["applying"] is False)
except Exception as e:
    check("全程无异常:" + str(e), False)
finally:
    server.terminate()
    try: server.wait(timeout=5)
    except Exception: server.kill()
    shutil.rmtree(data_dir, ignore_errors=True)

passed = sum(1 for _, ok in results if ok)
print(f"通过 {passed}/{len(results)}")
import sys; sys.exit(0 if passed == len(results) else 1)
