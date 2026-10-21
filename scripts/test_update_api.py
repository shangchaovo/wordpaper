#!/usr/bin/env python3
"""In-app self-update endpoint tests: ratchet 409, CSRF 403, public-mode guard."""
import os, socket, subprocess, tempfile, time, shutil, json

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

import http.cookiejar
from urllib.request import Request, build_opener, HTTPCookieProcessor
opener = build_opener()   # replaced by cookie-processor opener inside main()

def http_post(base, path, headers, body):
    req = Request(base + path, method="POST", data=body, headers=headers)
    try:
        r = opener.open(req, timeout=10)
        return r.status, json.loads(r.read() or b'{}')
    except Exception as e:
        code = getattr(e, 'code', None)
        try: return code, json.loads(e.read() or b'{}')
        except Exception: return code, {}

port = free_port()
data_dir = tempfile.mkdtemp(prefix="wp-upd-local-")
env = dict(os.environ, PORT=str(port), HOST="127.0.0.1", WORDPAPER_MODE="local", WORDPAPER_DATA_DIR=data_dir, NODE_ENV="test")
env.pop("WORDPAPER_COMPANION_ENABLED", None)
results = []
server = subprocess.Popen(["node", "server.js"], cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
def check(name, ok):
    results.append((name, bool(ok)))
    print(("PASS  " if ok else "FAIL  ") + name)
try:
    base = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try: urlopen(base + "/login.html", timeout=1); break
        except Exception: time.sleep(0.2)
    # register + login
    import http.cookiejar as _cj
    from urllib.request import HTTPCookieProcessor as _HCP
    globals()['opener'] = build_opener(_HCP(_cj.CookieJar()))
    req = Request(base + "/api/auth/register", method="POST", data=json.dumps({"username": "upd_user", "password": "update-test-pw"}).encode(), headers={"Content-Type": "application/json", "Origin": base})
    r = opener.open(req, timeout=10)
    check("注册成功", r.status == 201)
    # GET /api/session to obtain csrf
    r = opener.open(base + "/api/session", timeout=10)
    sdata = json.loads(r.read())
    csrf = sdata["csrfToken"]
    check("session 提供 csrf", bool(csrf))
    # ratchet: latestVersion is '' in test (raw.githubusercontent reachable?) — apply must 409
    code, data = http_post(base, "/api/update/apply", {"X-CSRF-Token": csrf, "Origin": base}, b"{}")
    check("无可用版本时 apply=409/404", code in (409, 404))
    # CSRF: bad token → 403
    code, data = http_post(base, "/api/update/apply", {"X-CSRF-Token": "WRONG", "Origin": base}, b"{}")
    check("CSRF 校验拒绝=403", code == 403)
    # status endpoint with login
    r = opener.open(base + "/api/update/status", timeout=10)
    st = json.loads(r.read())
    check("status 响应结构完整", "applying" in st and "current" in st)
except Exception as e:
    check("全程无异常:" + str(e), False)
finally:
    server.terminate()
    try: server.wait(timeout=5)
    except Exception: server.kill()
    shutil.rmtree(data_dir, ignore_errors=True)


# ── 公网部署下的 update 端点:check 可读但 supported=False,apply 拒绝 ──
import urllib.request
def free_port2():
    s2 = socket.socket(); s2.bind(("127.0.0.1", 0)); p2 = s2.getsockname()[1]; s2.close(); return p2
port2 = free_port2()
data_dir2 = tempfile.mkdtemp(prefix="wp-upd-api2-")
env2 = dict(os.environ, PORT=str(port2), HOST="127.0.0.1", WORDPAPER_MODE="public", WORDPAPER_DATA_DIR=data_dir2, NODE_ENV="test")
server2 = subprocess.Popen(["node", "server.js"], cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))), env=env2, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
try:
    from urllib.request import urlopen
    base2 = f"http://127.0.0.1:{port2}"
    for _ in range(50):
        try: urlopen(base2 + "/login.html", timeout=1); break
        except Exception: time.sleep(0.2)
    data = json.loads(urlopen(base2 + "/api/update/check", timeout=10).read())
    check("check 响应含 supported/available/current", "supported" in data and "available" in data)
    check("public 模式 supported=false", data["supported"] is False)
    code, _ = http_post(base2, "/api/update/apply", {"Origin": base2}, b"{}")
    check("public 模式 apply 拒绝", code in (401, 404))
finally:
    server2.terminate()
    try: server2.wait(timeout=5)
    except Exception: server2.kill()
    shutil.rmtree(data_dir2, ignore_errors=True)

passed = sum(1 for _, ok in results if ok)
print(f"通过 {passed}/{len(results)}")
import sys; sys.exit(0 if passed == len(results) else 1)
