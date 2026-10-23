#!/usr/bin/env python3
import os, socket, subprocess, tempfile, time, shutil, urllib.request
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p
port = free_port()
data_dir = tempfile.mkdtemp(prefix="wp-ast-")
env = dict(os.environ, PORT=str(port), HOST="127.0.0.1", WORDPAPER_MODE="public",
           WORDPAPER_DATA_DIR=data_dir, NODE_ENV="test")
server = subprocess.Popen(["node", "server.js"], cwd=ROOT,
                          env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
try:
    base = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try: urllib.request.urlopen(base + "/login.html", timeout=1); break
        except Exception: time.sleep(0.2)
    r = urllib.request.urlopen(base + "/assets/favicon-32.png", timeout=5)
    print("PASS favicon-32 served:", r.status, r.headers['Content-Type'], len(r.read()), "bytes")
    try:
        urllib.request.urlopen(base + "/assets/icon.icns", timeout=5)
        raise AssertionError("icns should be rejected")
    except urllib.error.HTTPError as e:
        print("PASS icns rejected:", e.code)
    # trailing-dot / traversal still blocked
    try:
        urllib.request.urlopen(base + "/assets/../server.js", timeout=5)
        raise AssertionError("traversal should be rejected")
    except urllib.error.HTTPError as e:
        print("PASS traversal blocked:", e.code)

finally:
    server.terminate()
    try: server.wait(timeout=5)
    except Exception: server.kill()
    shutil.rmtree(data_dir, ignore_errors=True)
