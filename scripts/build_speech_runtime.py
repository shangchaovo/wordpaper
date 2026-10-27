#!/usr/bin/env python3
"""Prepare relocatable, pinned speech runtimes for release packaging only.

CPython comes from Astral's python-build-standalone release. Both architectures
carry their own standard library, OpenSSL and edge-tts wheels; end users do not
need Homebrew, pip, Xcode Python or a developer checkout. Licenses stay bundled.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
DIST = HERE / 'speech-dist'
RELEASE = '20261026'
PYTHON = '3.12.16'
ARCHES = {
    'arm64': ('aarch64', '353d5f1b4fd2715e7053f12f068435d5bbad16b91e057006b5d01e0925709a7e'),
    'x64': ('x86_64', '37c38fda76fec1fbf310adcbafb7f0d96af13b5511bf8ea954c3aa8eec185734'),
}
REQUIREMENTS = HERE / 'requirements-speech.txt'


def build(arch):
    machine, digest = ARCHES[arch]
    name = f'cpython-{PYTHON}+{RELEASE}-{machine}-apple-darwin-install_only_stripped.tar.gz'
    archive = DIST / name
    destination = DIST / arch
    specification = {'python': PYTHON, 'release': RELEASE, 'sha256': digest,
                     'requirements': REQUIREMENTS.read_text()}
    stamp = destination / 'WORDPAPER_RUNTIME.json'
    if stamp.exists() and json.loads(stamp.read_text()) == specification:
        print(f'PASS cached speech runtime: {arch}', flush=True)
        return
    DIST.mkdir(parents=True, exist_ok=True)
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
        url = f'https://github.com/astral-sh/python-build-standalone/releases/download/{RELEASE}/{name}'
        subprocess.run(['curl', '-fL', '--connect-timeout', '15', '--max-time', '300', '--retry', '2',
                        '--output', str(archive), url], check=True)
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == digest, 'Python download checksum mismatch'
    stage = DIST / (arch + '.staging')
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir()
    with tarfile.open(archive) as source:
        source.extractall(stage, filter='data')
    python = stage / 'python/bin/python3'
    # Running the Intel runtime on this Apple Silicon release host also exercises
    # its native extensions under Rosetta instead of merely inspecting headers.
    subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
                    '--only-binary=:all:', '--requirement', str(REQUIREMENTS)], check=True)
    subprocess.run([str(python), '-c', 'import edge_tts,aiohttp,ssl; print(edge_tts.__version__,ssl.OPENSSL_VERSION)'], check=True)
    (stage / 'python/WORDPAPER_RUNTIME.json').write_text(json.dumps(specification, indent=2))
    shutil.rmtree(destination, ignore_errors=True)
    (stage / 'python').rename(destination)
    shutil.rmtree(stage)
    # Re-run after relocation: absolute developer paths must not be required.
    subprocess.run([str(destination / 'bin/python3'), '-c', 'import edge_tts,aiohttp,ssl'], check=True)
    print(f'PASS relocatable speech runtime: {arch}', flush=True)


if __name__ == '__main__':
    for architecture in ARCHES:
        build(architecture)
