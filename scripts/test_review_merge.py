#!/usr/bin/env python3
"""Synthetic, offline rehearsal for the separately approved review-account merge."""
import copy
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
import prepare_review_merge as merge

ROOT = Path(__file__).resolve().parent.parent


def seed(path):
    subprocess.run(['node', '-e', "require('./lib/storage').openStorage(process.argv[1]).close()", str(path.parent)],
                   cwd=ROOT, check=True, capture_output=True)
    with closing(sqlite3.connect(path)) as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS user_word_examples (
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,library TEXT,entry_key TEXT,
          example_json TEXT,model TEXT,created_at INTEGER, PRIMARY KEY(user_id,library,entry_key));
        INSERT INTO users(id,username,username_key,password_hash,created_at,role)
          VALUES(1,'owner','owner','scrypt$fixture',11,'admin'),(2,'old','federated:google:x','',12,'user'),
                (3,'independent','independent','scrypt$another',13,'user');
        INSERT INTO password_credentials VALUES(1,'scrypt$fixture',1,1),(3,'scrypt$another',3,3);
        INSERT INTO auth_identities VALUES('google-desktop','shared-sub',1,NULL,1,NULL,1,1),
                                          ('google','shared-sub',2,NULL,1,NULL,1,1);
        INSERT INTO user_state VALUES(3,'reminders','["private-to-another-user"]',12,94),
          (1,'settings','{"theme":"primary"}',4,22),(2,'settings','{"theme":"archived"}',9,37);
        """)
        def record(stage, at):
            return {'stage': stage, 'due': at + 60, 'events': [{'at': at, 'type': 'answer'}], 'lastUndo': {'at': at}}
        for user, words in [(1, {'a': record(1, 10), 'shared': record(2, 20)}),
                            (2, {'b': record(3, 30), 'shared': record(5, 40)})]:
            val = json.dumps({'lib': {'cursor': user, 'words': words}})
            db.execute("INSERT INTO user_state VALUES(?,'review',?,7,8)", (user, val))
        db.commit()
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')


class MergeTest(unittest.TestCase):
    def test_policy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'wordpaper.sqlite'
            seed(source)
            h = merge.file_hash(source)
            with closing(merge.connect(source, True)) as db:
                plan, _, _ = merge.inspect(db, h, 1, 2)
            self.assertIsNone(plan['approval'])
            self.assertEqual(plan['reviewCounts'], {'primaryWords': 2, 'secondaryWords': 2, 'shared': 1,
                                                    'added': 1, 'mergedWords': 3, 'withForkedEvents': 1})
            destination = root / 'prepared'
            with self.assertRaisesRegex(ValueError, 'explicit'):
                merge.materialize(source, plan, destination)
            approved = {**plan, 'approval': 'merge-as-previewed'}
            wrong = copy.deepcopy(approved)
            wrong['secondaryAccountSha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'checksums'):
                merge.materialize(source, wrong, destination)
            self.assertFalse(destination.exists())
            wrong = {**approved, 'sourceFileSha256': '0' * 64}
            with self.assertRaisesRegex(ValueError, 'snapshot checksum'):
                merge.materialize(source, wrong, destination)
            receipt = merge.materialize(source, approved, destination)
            self.assertEqual(receipt['primaryReviewRevision'], 8)
            self.assertEqual(receipt['sourceIdToCanonicalId'], {'1': 1, '2': 1})
            self.assertEqual(h, merge.file_hash(source))
            archived = json.loads((destination / 'secondary-account.json').read_text())
            self.assertEqual(archived['state']['review']['lib']['words']['shared']['stage'], 5)
            self.assertEqual(archived['state']['settings']['theme'], 'archived')
            self.assertNotIn('private-to-another-user', (destination / 'secondary-account.json').read_text())
            with closing(merge.connect(destination / 'candidate.sqlite', True)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM users').fetchone()[0], 2)
                state = merge.states(merge.account(db, 1))
                words = state['review']['value']['lib']['words']
                self.assertEqual(set(words), {'a', 'b', 'shared'})
                self.assertEqual(words['b'], archived['state']['review']['lib']['words']['b'])
                self.assertEqual(words['shared']['stage'], 2)
                self.assertEqual(words['shared']['lastUndo'], {'at': 20})
                self.assertEqual(state['settings']['value']['theme'], 'primary')
                self.assertEqual(db.execute('SELECT password_hash FROM password_credentials WHERE user_id=1').fetchone()[0],
                                 'scrypt$fixture')
                self.assertEqual(merge.states(merge.account(db, 3))['reminders']['value'], ['private-to-another-user'])
            with self.assertRaisesRegex(ValueError, 'unused'):
                merge.materialize(source, approved, destination)
            dry_run = subprocess.run(['node', 'scripts/migrate_wordpaper_postgres.js','dry-run',
                                      str(destination/'candidate.sqlite')], cwd=ROOT,
                                     check=True, capture_output=True, text=True)
            counts = json.loads(dry_run.stdout)['counts']
            self.assertEqual(counts['users'], 2)
            self.assertEqual(counts['auth_identities'], 1)


if __name__ == '__main__':
    os.umask(0o077)
    unittest.main()
