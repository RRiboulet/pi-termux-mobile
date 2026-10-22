#!/usr/bin/env python3
"""Package the mobile runtime before every Android build."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'runtime'
ASSETS = ROOT / 'android/app/src/main/assets'
FILES = ['server.mjs', 'common.mjs', 'models-config.mjs', 'node-bin.mjs', 'gate.mjs',
         'package.json', 'package-lock.json', 'public', 'node_modules']

if not (RUNTIME / 'node_modules/@earendil-works/pi-durable').is_dir():
    raise SystemExit('Mobile runtime dependencies missing; install the locked runtime dependencies first')
if not (ASSETS / 'rootfs.bin').is_file():
    raise SystemExit('Termux rootfs.bin is missing; run: node scripts/package-rootfs.ts')

# The rootfs is built for one package id: the Termux binaries have the prefix compiled in, and the builder rewrites
# it in place. A rootfs built for another id half works -- the libraries load, and the shebangs and the global
# prefix do not -- so refuse to package it instead of shipping a runtime that breaks on the phone.
manifest_path = ASSETS / 'termux-packages.json'
# A MISSING manifest is not a pass: the check exists so a rootfs built for another package id
# cannot ship, and without the manifest there is nothing to compare against.
if not manifest_path.is_file():
    raise SystemExit(f'{manifest_path} is missing; rebuild the rootfs: node scripts/package-rootfs.ts')
if True:
    built_for = json.loads(manifest_path.read_text()).get('applicationId')
    gradle = (ROOT / 'android' / 'app' / 'build.gradle').read_text()
    ids = re.findall(r"^\s*applicationId\s+['\"]([^'\"]+)['\"]", gradle, re.M)
    current = ids[0] if ids else None
    if built_for != current:
        raise SystemExit(f'rootfs.bin was built for {built_for!r} but the app id is {current!r}: '
                         'run: node scripts/package-rootfs.ts')
for name in FILES:
    if not (RUNTIME / name).exists():
        raise SystemExit(f'Required runtime input missing: {name}')

def entries(path):
    if path.name == '.bin':
        return
    # A path that is not there is not packaged; the optional inputs are absent in a clean checkout.
    if not path.exists() and not path.is_symlink():
        return
    # Retain valid links, exclude broken links without deleting developer files.
    if path.is_symlink():
        if path.exists():
            yield path
        return
    yield path
    if path.is_dir():
        for child in sorted(path.iterdir()):
            yield from entries(child)

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.digest()

def replace_if_changed(source, target):
    if target.is_file() and digest(source) == digest(target):
        source.unlink()
    else:
        source.replace(target)

ASSETS.mkdir(parents=True, exist_ok=True)
temporary = None
try:
    with tempfile.NamedTemporaryFile(dir=ASSETS, suffix='.tmp', delete=False) as raw:
        temporary = Path(raw.name)
        with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for name in FILES:
                    for path in entries(RUNTIME / name):
                        info = archive.gettarinfo(str(path), 'runtime/' + path.relative_to(RUNTIME).as_posix())
                        info.uid = info.gid = info.mtime = 0
                        info.uname = info.gname = ''
                        if info.isfile():
                            with path.open('rb') as stream:
                                archive.addfile(info, stream)
                        else:
                            archive.addfile(info)
    replace_if_changed(temporary, ASSETS / 'runtime.bin')
    temporary = None
    # Both payloads determine extraction; RuntimeInstaller's version still covers installer changes.
    fingerprint = hashlib.sha256(digest(ASSETS / 'rootfs.bin') + digest(ASSETS / 'runtime.bin')).hexdigest()
    with tempfile.NamedTemporaryFile(dir=ASSETS, suffix='.tmp', delete=False) as raw:
        temporary = Path(raw.name)
        raw.write((fingerprint + '\n').encode('ascii'))
    replace_if_changed(temporary, ASSETS / 'payload.sha256')
    temporary = None
    print(f'Mobile assets prepared; payload {fingerprint}')
finally:
    if temporary:
        temporary.unlink(missing_ok=True)
