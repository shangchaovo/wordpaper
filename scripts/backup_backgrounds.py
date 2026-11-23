"""Immutable, account-scoped Supabase Storage objects referenced by a WordPaper snapshot."""
import hashlib
import json
import os
import re
import shutil
import urllib.error
import urllib.request
from urllib.parse import urlsplit

REF = re.compile(r'wp-image:v1:(png|jpeg|webp|gif):([0-9a-f]{64})')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def object_parts(owner, ref):
    match = REF.fullmatch(ref)
    if not re.fullmatch(r'[1-9][0-9]{0,15}', owner) or int(owner) > 2**53 - 1 or not match:
        raise ValueError('Malformed account-scoped background reference.')
    extension, digest = match.groups()
    return f'{owner}/{digest}.{extension}', 'image/' + extension, digest


class PrivateBucket:
    def __init__(self):
        origin = os.getenv('WORDPAPER_STORAGE_ORIGIN', '')
        secret = os.getenv('WORDPAPER_STORAGE_SECRET', '')
        url = urlsplit(origin)
        self.bucket = os.getenv('WORDPAPER_STORAGE_BUCKET', '') or 'wordpaper-backgrounds'
        if (url.scheme != 'https' or not url.hostname or url.username is not None or url.password is not None
                or url.path or url.query or url.fragment or not secret
                or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}', self.bucket)):
            raise ValueError('Private background references require the trusted Storage HTTPS origin, secret and bucket.')
        self.base = origin + '/storage/v1'
        self.headers = {'apikey': secret}
        if not secret.startswith('sb_secret_'):
            self.headers['Authorization'] = 'Bearer ' + secret
        self.opener = urllib.request.build_opener(NoRedirect())
        with self.request('/bucket/' + self.bucket) as response:
            if json.load(response).get('public') is not False:
                raise ValueError('The Storage bucket must be private.')

    def request(self, path, **kwargs):
        headers = {**self.headers, **kwargs.pop('headers', {})}
        return self.opener.open(urllib.request.Request(self.base + path, headers=headers, **kwargs), timeout=30)

    def download(self, path):
        return self.request('/object/authenticated/' + self.bucket + '/' + path)

    def matches(self, path, expected_hash):
        try:
            with self.download(path) as response:
                actual = hashlib.file_digest(response, 'sha256').hexdigest()
            if actual != expected_hash:
                raise ValueError('Destination contains inconsistent bytes at a content-addressed object path.')
            return True
        except urllib.error.HTTPError as err:
            # Storage may report an absent object with HTTP 400 and a 404 body.
            if err.code == 404:
                return False
            if err.code == 400:
                try:
                    body = json.loads(err.read(16384))
                except ValueError:
                    body = {}
                if str(body.get('statusCode')) == '404' or body.get('code') == 'NoSuchKey':
                    return False
            raise


def backup(base, references):
    bucket = PrivateBucket() if references else None
    objects = []
    for owner, ref in references:
        key, _, digest = object_parts(owner, ref)
        dest = base / 'objects' / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        with bucket.download(key) as response, dest.open('xb') as output:
            shutil.copyfileobj(response, output)
        with dest.open('rb') as f:
            if hashlib.file_digest(f, 'sha256').hexdigest() != digest:
                raise ValueError('Background content does not match the database reference.')
        objects.append({'ownerId': owner, 'ref': ref, 'bytes': dest.stat().st_size})
    return objects


def restore(base, records):
    verified = []
    seen = set()
    for row in records:
        key, mime, digest = object_parts(row['ownerId'], row['ref'])
        file = base / 'objects' / key
        if key in seen or file.stat().st_size != row['bytes']:
            raise ValueError('Background manifest size or uniqueness check failed.')
        with file.open('rb') as f:
            if hashlib.file_digest(f, 'sha256').hexdigest() != digest:
                raise ValueError('Background backup checksum mismatch.')
        seen.add(key)
        verified.append((file, key, mime, digest))
    bucket = PrivateBucket() if verified else None
    for file, key, mime, digest in verified:
        if bucket.matches(key, digest):
            continue
        with file.open('rb') as f:
            try:
                with bucket.request('/object/' + bucket.bucket + '/' + key, method='POST', data=f,
                                    headers={'Content-Type': mime, 'Content-Length': str(file.stat().st_size)}) as response:
                    response.read(16384)
            except urllib.error.HTTPError as err:
                # Another restore may have already uploaded these immutable bytes.
                if err.code not in (400, 409):
                    raise
        if not bucket.matches(key, digest):
            raise ValueError('Uploaded background did not pass read-back verification.')
