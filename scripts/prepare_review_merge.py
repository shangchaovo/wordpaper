#!/usr/bin/env python3
"""Review a frozen snapshot, or produce a separate, explicitly approved migration candidate."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import time


DURABLE = ('users', 'password_credentials', 'auth_identities', 'user_state',
           'user_models', 'user_speech', 'user_word_examples')
TRANSIENT = ('sessions', 'device_flows')
KNOWN = {*DURABLE, *TRANSIENT, 'email_verifications', 'oauth_flows', 'app_meta', 'sqlite_sequence'}
STRATEGY = 'primary-review-records-and-secondary-only-words-v1'


def need(test, message):
    if not test:
        raise ValueError(message)


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()


def file_hash(p):
    with p.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def write_json(file, value):
    with file.open('x', encoding='utf8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2, allow_nan=False)
        f.write('\n')


def frozen(source):
    need(source.is_file(), 'Provide the frozen SQLite backup file.')
    for suffix in ('-wal', '-journal'):
        sidecar = Path(str(source) + suffix)
        need(not sidecar.exists() or sidecar.stat().st_size == 0, 'Use a consistent, offline SQLite backup including committed WAL data.')


def connect(path, readonly):
    if readonly:
        frozen(path)
        db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)
    else:
        db = sqlite3.connect(path)
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA secure_delete=ON')
        db.execute('PRAGMA journal_mode=DELETE')
    db.row_factory = sqlite3.Row
    return db


def check_schema(db):
    names = {r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
    need(set(DURABLE) <= names <= KNOWN, 'Snapshot schema contains missing or unreviewed tables.')
    need(db.execute('PRAGMA quick_check').fetchone()[0] == 'ok' and not db.execute('PRAGMA foreign_key_check').fetchone(),
         'SQLite consistency checks failed.')
    return names


def rows_for(db, table, owner):
    col = 'id' if table == 'users' else 'user_id'
    return [dict(r) for r in db.execute(f'SELECT * FROM {table} WHERE {col}=? ORDER BY rowid', (owner,))]


def account(db, owner):
    rows = {t: rows_for(db, t, owner) for t in DURABLE}
    need(len(rows['users']) == 1, 'Account missing from snapshot.')
    return rows


def states(account_rows):
    return {r['namespace']: {**r, 'value': json.loads(r['value_json'])} for r in account_rows['user_state']}


def merge_review(primary, secondary):
    # Reparse a copy so the row checksums and independent archive stay unchanged.
    merged = json.loads(encode(primary))
    counts = {'primaryWords': 0, 'secondaryWords': 0, 'shared': 0, 'withForkedEvents': 0, 'added': 0}
    for lib in sorted(set(primary) | set(secondary)):
        a, b = primary.get(lib, {}), secondary.get(lib, {})
        need(isinstance(a, dict) and isinstance(b, dict) and not a.get('groups') and not b.get('groups'),
             'Legacy review groups need a separate review before a word-level merge.')
        left, right = a.get('words', {}), b.get('words', {})
        need(isinstance(left, dict) and isinstance(right, dict), 'Unknown review record format.')
        counts['primaryWords'] += len(left)
        counts['secondaryWords'] += len(right)
        if lib not in merged:
            merged[lib] = json.loads(encode(b))
        words = merged[lib].setdefault('words', {})
        for key, item in right.items():
            if key not in left:
                words[key] = item
                counts['added'] += 1
            else:
                counts['shared'] += 1
                x = {encode(ev) for ev in left[key].get('events', [])}
                y = {encode(ev) for ev in item.get('events', [])}
                counts['withForkedEvents'] += bool(x - y and y - x)
                need(words[key] == left[key], 'Shared review record changed during merge.')
    counts['mergedWords'] = sum(len(lib['words']) for lib in merged.values())
    need(counts['mergedWords'] == counts['primaryWords'] + counts['added'], 'Review count mismatch.')
    return merged, counts


def inspect(db, source_hash, primary, secondary):
    need(primary > 0 and secondary > 0 and primary != secondary, 'Provide distinct positive account IDs.')
    check_schema(db)
    a, b = account(db, primary), account(db, secondary)
    user = b['users'][0]
    need(user['role'] == 'user' and not user['password_hash'] and not b['password_credentials'],
         'This procedure requires a Google-only secondary account without an independent password.')
    need(not any(b[t] for t in ('user_models', 'user_speech', 'user_word_examples')),
         'Secondary model, speech or example data needs a separate approved handling decision.')
    need(len(a['auth_identities']) == len(b['auth_identities']) == 1, 'Unexpected identity count.')
    one, two = a['auth_identities'][0], b['auth_identities'][0]
    need({one['provider'], two['provider']} == {'google', 'google-desktop'} and
         one['email_verified'] == two['email_verified'] == 1 and
         one['provider_subject'] and one['provider_subject'] == two['provider_subject'],
         'These accounts do not have the expected verified Google identity.')
    left, right = states(a), states(b)
    need('review' in left and 'review' in right, 'Both source accounts must contain review data.')
    result, counts = merge_review(left['review']['value'], right['review']['value'])
    # Other namespaces follow the primary owner's preview. A newly discovered
    # secondary-only namespace requires its own preview, rather than silently discarding data.
    need(set(right) <= set(left), 'Secondary-only namespace found; prepare an updated preview and decision.')
    plan = {'format': 1, 'strategy': STRATEGY, 'sourceFileSha256': source_hash,
            'primaryId': primary, 'secondaryId': secondary, 'primaryAccountSha256': digest(a),
            'secondaryAccountSha256': digest(b), 'reviewCounts': counts, 'approval': None}
    return plan, result, b


def unaffected(db, primary, secondary):
    result = {}
    for table in sorted(check_schema(db)):
        if table == 'users':
            where, params = 'WHERE id != ?', (secondary,)
        elif table == 'user_state':
            where, params = "WHERE user_id != ? AND NOT(user_id=? AND namespace='review')", (secondary, primary)
        elif table in DURABLE or table in TRANSIENT:
            where, params = 'WHERE user_id IS NOT ?', (secondary,)
        else:
            where, params = '', ()
        query = f'SELECT * FROM {table} {where} ORDER BY rowid'
        h = hashlib.sha256()
        for row in db.execute(query, params):
            h.update(encode(dict(row)).encode() + b'\n')
        result[table] = h.hexdigest()
    return result


def materialize(source, decision, target):
    frozen(source)
    need(not target.exists(), 'Choose a new, unused private output directory.')
    # Opening only the candidate for mutation makes accidental source edits impossible.
    need(decision.get('approval') == 'merge-as-previewed', 'An explicit merge-as-previewed decision is required.')
    primary, secondary = decision['primaryId'], decision['secondaryId']
    expected_hash = decision['sourceFileSha256']
    need(expected_hash == file_hash(source), 'The reviewed snapshot checksum has changed.')
    target.mkdir(mode=0o700)
    try:
        candidate = target / 'candidate.sqlite'
        shutil.copyfile(source, candidate)
        frozen(source)
        need(file_hash(candidate) == expected_hash == file_hash(source), 'Snapshot changed during copy.')
        db = connect(candidate, False)
        try:
            db.execute('BEGIN IMMEDIATE')
            plan, merged, secondary_rows = inspect(db, expected_hash, primary, secondary)
            need({**plan, 'approval': 'merge-as-previewed'} == decision, 'Decision differs from the exact account checksums or reviewed counts.')
            before = unaffected(db, primary, secondary)
            # Archive all secondary durable rows (preflight excludes passwords and
            # encrypted service keys), plus decoded state for direct human reading.
            archive = {'format': 1, 'sourceFileSha256': expected_hash, 'originalUserId': secondary,
                       'canonicalUserId': primary, 'accountSha256': digest(secondary_rows),
                       'tables': secondary_rows, 'state': {k: r['value'] for k, r in states(secondary_rows).items()}}
            archive_file = target / 'secondary-account.json'
            write_json(archive_file, archive)
            archived = json.loads(archive_file.read_text(encoding='utf8'))
            need(digest(archived['tables']) == plan['secondaryAccountSha256'] and archived['state'] == archive['state'],
                 'Secondary archive verification failed.')
            now = time.time_ns() // 1000000
            need(db.execute("""UPDATE user_state SET value_json=?, revision=revision+1,
                             updated_at=MAX(updated_at+1,?) WHERE user_id=? AND namespace='review'""",
                            (encode(merged), now, primary)).rowcount == 1, 'Primary review update failed.')
            # The archived account had a single Google binding being consolidated.
            # Only its candidate rows disappear; the original snapshot stays intact.
            db.execute('DELETE FROM users WHERE id=?', (secondary,))
            for table in DURABLE + tuple(t for t in TRANSIENT if t in before):
                need(not rows_for(db, table, secondary), 'Secondary rows remain after consolidation.')
            need(unaffected(db, primary, secondary) == before, 'Unrelated account or configuration data changed.')
            revised = db.execute("SELECT value_json,revision FROM user_state WHERE user_id=? AND namespace='review'", (primary,)).fetchone()
            need(json.loads(revised[0]) == merged, 'Candidate review verification failed.')
            db.commit()
            db.execute('VACUUM')
            need(unaffected(db, primary, secondary) == before, 'Candidate compaction changed unrelated rows.')
        finally:
            db.close()
        frozen(source)
        need(file_hash(source) == expected_hash, 'Original snapshot changed during verification.')
        receipt = {'strategy': STRATEGY, 'sourceFileSha256': expected_hash, 'candidateFileSha256': file_hash(candidate),
                   'secondaryArchiveSha256': file_hash(archive_file), 'decisionSha256': digest(decision),
                   'sourceIdToCanonicalId': {str(primary): primary, str(secondary): primary},
                   'unaffectedTablesSha256': before, 'primaryReviewRevision': revised[1], 'reviewCounts': plan['reviewCounts']}
        write_json(target / 'receipt.json', receipt)
        return receipt
    except BaseException:
        shutil.rmtree(target)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    preview = sub.add_parser('inspect')
    preview.add_argument('source', type=Path)
    preview.add_argument('primary', type=int)
    preview.add_argument('secondary', type=int)
    apply = sub.add_parser('prepare')
    apply.add_argument('source', type=Path)
    apply.add_argument('decision', type=Path)
    apply.add_argument('output', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.mode == 'inspect':
        db = connect(args.source, True)
        try:
            h = file_hash(args.source)
            plan = inspect(db, h, args.primary, args.secondary)[0]
            frozen(args.source)
            need(file_hash(args.source) == h, 'Snapshot changed during inspection.')
            print(json.dumps(plan, indent=2))
        finally:
            db.close()
    else:
        decision = json.loads(args.decision.read_text(encoding='utf8'))
        print(json.dumps(materialize(args.source, decision, args.output), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, TypeError, KeyError) as exc:
        sys.exit(str(exc))
