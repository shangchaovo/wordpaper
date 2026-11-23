#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { createAccountCipher } = require('../lib/ai-model');
const { STATE_NAMESPACES } = require('../lib/storage');
const { DatabaseSync } = require('node:sqlite');

const tables = [
  { name: 'users', columns: 'id username username_key password_hash created_at role', key: 'id' },
  { name: 'password_credentials', columns: 'user_id password_hash created_at updated_at', key: 'user_id' },
  { name: 'auth_identities', columns: 'provider provider_subject user_id email email_verified display_name created_at updated_at', key: 'provider provider_subject' },
  { name: 'user_state', columns: 'user_id namespace value_json revision updated_at', key: 'user_id namespace' },
  { name: 'user_speech', columns: 'user_id base_url model voice key_cipher updated_at', key: 'user_id' },
  { name: 'user_models', columns: 'user_id base_url protocol model key_cipher updated_at', key: 'user_id' },
  { name: 'user_word_examples', columns: 'user_id library entry_key example_json model created_at', key: 'user_id library entry_key' },
  { name: 'app_meta', columns: 'key value', key: 'key' },
];
const transientTables = ['sessions', 'email_verifications', 'oauth_flows', 'device_flows'];
const tableNames = new Set([...tables.map(table => table.name), ...transientTables]);
const numericKeys = new Set(['id', 'user_id']);

class MigrationError extends Error {}

function quote(name) {
  return '"' + name.replaceAll('"', '""') + '"';
}

function qualified(name) {
  return 'wordpaper.' + quote(name);
}

function orderedKeys(table, textCollation) {
  return table.key.split(' ').map(key => quote(key) + (numericKeys.has(key) ? '' : ` COLLATE ${textCollation}`)).join(', ');
}

function sqliteRead(db, sql) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}

function sourceSnapshot(db, decisions, inventoryOnly) {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) {
    throw new MigrationError('SQLite 完整性检查失败。请换用核验过的数据库备份。');
  }
  const names = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
  if (!names.has('users') || !names.has('user_state')) {
    throw new MigrationError('没有找到 WordPaper 的账号和学习状态表。');
  }
  for (const name of names) {
    if (name.startsWith('sqlite_') || tableNames.has(name)) continue;
    if (db.prepare(`SELECT 1 FROM ${quote(name)} LIMIT 1`).get()) {
      throw new MigrationError('发现迁移脚本尚未覆盖的数据表。请先更新迁移表清单。');
    }
  }
  if (db.prepare("SELECT 1 FROM users WHERE password_hash LIKE 'mirror$%' LIMIT 1").get()) {
    throw new MigrationError('来源包含同步镜像账号。请使用原账号服务器的数据库快照。');
  }
  const hasRole = db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'role');
  const highId = sqliteRead(db, 'SELECT COALESCE(max(id), 0) AS id FROM users').get().id;
  const sequence = names.has('sqlite_sequence') ? sqliteRead(db, "SELECT seq FROM sqlite_sequence WHERE name='users'").get()?.seq ?? 0n : 0n;
  const nextId = (highId > sequence ? highId : sequence) + 1n;
  if (nextId < 1n || nextId >= BigInt(Number.MAX_SAFE_INTEGER)) throw new MigrationError('现有账号编号超出 WordPaper 的安全范围。');

  const identities = inventoryOnly ? null : canonicalIdentities(db, names, decisions);
  function rawRows(table) {
    if (table.name === 'auth_identities' && identities) return identities;
    const order = ' ORDER BY ' + orderedKeys(table, 'BINARY');
    let sql;
    if (table.name === 'users' && !hasRole) {
      sql = "SELECT id, username, username_key, password_hash, created_at, 'user' AS role FROM users" + order;
    } else if (table.name === 'password_credentials' && !names.has(table.name)) {
      sql = "SELECT id AS user_id, password_hash, created_at, created_at AS updated_at FROM users WHERE password_hash LIKE 'scrypt$%'" + order;
    } else if (names.has(table.name)) {
      const excluded = table.name === 'app_meta' ? " WHERE \"key\" IN ('feature:betaPetQuiz', 'feature:betaPatrickVoice', 'feature:betaCompanionRoam', 'feature:betaMirror')" : '';
      sql = `SELECT ${table.columns.split(' ').map(quote).join(', ')} FROM ${quote(table.name)}` + excluded + order;
    } else {
      return [];
    }
    const statement = sqliteRead(db, sql);
    statement.setReturnArrays(true);
    return statement.iterate();
  }

  // SQLite INTEGER affinity also permits CURRENT_TIMESTAMP's UTC text format.
  // Normalize its representation, not the instant. Report every converted field.
  function* rows(table, conversions) {
    const columns = table.columns.split(' ');
    const numericColumns = columns.map((name, index) => ({ name, index })).filter(({ name }) =>
      ['id', 'user_id', 'email_verified', 'revision', 'created_at', 'updated_at'].includes(name));
    for (const originalRow of rawRows(table)) {
      const row = [...originalRow];
      for (const { name, index } of numericColumns) {
        const original = row[index];
        if (typeof original === 'bigint') continue;
        if (['created_at', 'updated_at'].includes(name) && typeof original === 'string' &&
            /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(original)) {
          const iso = original.replace(' ', 'T') + '.000Z';
          const ms = Date.parse(iso);
          if (Number.isSafeInteger(ms) && ms >= 0 && new Date(ms).toISOString() === iso) {
            conversions?.push({ table: table.name, field: name, sourceFormat: 'SQLite UTC timestamp',
              userId: Number(row[columns.indexOf(columns.includes('user_id') ? 'user_id' : 'id')]),
              ...(columns.includes('namespace') ? { namespace: row[columns.indexOf('namespace')] } : {}), unixMs: ms });
            row[index] = BigInt(ms);
            continue;
          }
        }
        throw new MigrationError('无法无损转换数值字段 ' + table.name + '.' + name + '。');
      }
      yield row;
    }
  }

  return { nextId, rows };
}

function digest() {
  const hash = createHash('sha256');
  let count = 0;
  return {
    add(row) {
      hash.update(JSON.stringify(row.map(value => value === null ? null : String(value)))).update('\n');
      count += 1;
    },
    finish: () => ({ count, checksum: hash.digest('hex') }),
  };
}

function targetConnection() {
  let uri;
  try { uri = new URL(process.env.WORDPAPER_DATABASE_URL); }
  catch { throw new MigrationError('请设置 WORDPAPER_DATABASE_URL，使用 PostgreSQL 服务端连接串。'); }
  if (!['postgres:', 'postgresql:'].includes(uri.protocol) || !uri.hostname || uri.pathname === '/') {
    throw new MigrationError('WORDPAPER_DATABASE_URL 不是有效的 PostgreSQL 服务端连接串。');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname)) {
    uri.searchParams.set('sslmode', 'verify-full');
  }
  let Client;
  try { ({ Client } = require('pg')); }
  catch { throw new MigrationError('请先在迁移环境中安装 PostgreSQL 的 Node.js 驱动 pg。'); }
  return new Client({
    connectionString: uri.toString(),
    connectionTimeoutMillis: 10000,
    statement_timeout: 60000,
    application_name: 'wordpaper-migration',
  });
}

// Both local and web code exchange the authorization code at Google and use
// the same UserInfo endpoint. A display name or even a verified email is not a subject.
function canonicalIdentities(db, names, decisions) {
  const selections = decisions.googleOwners ?? [];
  if (!Array.isArray(selections)) throw new MigrationError('googleOwners 必须是数组。');
  const columns = tables.find(t => t.name === 'auth_identities').columns.split(' ');
  const stmt = names.has('auth_identities') && sqliteRead(db, 'SELECT ' + columns.map(quote).join(',') +
    ' FROM auth_identities ORDER BY provider, provider_subject');
  if (stmt) stmt.setReturnArrays(true);
  const out = [];
  const google = new Map();
  for (const row of stmt ? stmt.iterate() : []) {
    if (!['google-desktop', 'google'].includes(row[0])) { out.push(row); continue; }
    if (!row[1] || row[1].length > 255 || row[4] !== 1n) throw new MigrationError('Google 身份缺少已验证的来源资料，请人工核验。');
    const list = google.get(row[1]) ?? [];
    list.push(row);
    google.set(row[1], list);
  }
  const seen = new Set();
  const used = new Set();
  for (const [subject, bindings] of google) {
    const ids = [...new Set(bindings.map(row => Number(row[2])))].sort((a, b) => a-b);
    let owner = ids[0];
    if (ids.length > 1) {
      const issuerSubjectHash = createHash('sha256').update('https://accounts.google.com\0' + subject).digest('hex');
      const selection = selections.find(x => x.issuerSubjectHash === issuerSubjectHash);
      if (!selection || JSON.stringify(selection.sourceIds) !== JSON.stringify(ids) || !ids.includes(selection.ownerId)) {
        throw new MigrationError('Google 归属冲突。来源账号 ID ' + ids.join(', ') +
          ' 对应同一 subject。审核逐项数据和登录恢复方案后，用决定文件绑定此组。issuerSubjectHash=' + issuerSubjectHash);
      }
      owner = selection.ownerId;
      used.add(selection);
      for (const id of ids.filter(x => x !== owner)) {
        if (!names.has('password_credentials') ||
            !db.prepare("SELECT 1 FROM password_credentials p JOIN users u ON u.id=p.user_id WHERE p.user_id=? AND u.username_key NOT LIKE 'federated:%' AND p.password_hash LIKE 'scrypt$%'").get(id)) {
          throw new MigrationError('来源账号 ID ' + id + ' 移交 Google 登录后将无法使用原凭据登录。请先确认并处理学习数据合并或独立的账号恢复路径。');
        }
      }
    }
    if (seen.has(owner)) throw new MigrationError('来源账号 ID ' + owner + ' 对应多个 Google subject，请先核实当前有效绑定。');
    seen.add(owner);
    const row = bindings.find(binding => Number(binding[2]) === owner);
    out.push(['google', ...row.slice(1)]);
  }
  if (used.size !== selections.length) throw new MigrationError('Google 归属决定与当前快照中的冲突组不符。');
  return out.sort((a,b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])) ||
    Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1])));
}

function inspectState(report, row) {
  const [userId, namespace, valueJson, revision, updatedAt] = row;
  if (!STATE_NAMESPACES.has(namespace)) throw new MigrationError('发现未登记的用户状态命名空间。请先核对应用版本。');
  const value = JSON.parse(valueJson);
  const details = { revision: Number(revision), updatedAt: Number(updatedAt),
    bytes: Buffer.byteLength(valueJson), sha256: createHash('sha256').update(valueJson).digest('hex') };
  if (namespace === 'customWords' || namespace === 'reminders') details.items = Array.isArray(value) ? value.length : null;
  if (namespace === 'review') {
    const libraries = Object.values(value || {});
    details.words = libraries.reduce((n, lib) => n + Object.keys(lib?.words || {}).length, 0);
    details.legacyGroups = libraries.reduce((n, lib) => n + Object.keys(lib?.groups || {}).length, 0);
  }
  if (namespace === 'learningActivity') {
    details.eventsIncludingTombstones = Object.values(value?.days || {}).reduce((n, day) => n + Object.keys(day || {}).length, 0);
  }
  (report.accounts[userId] ??= {})[namespace] = details;
}

function inspectSource(source) {
  const report = { counts: {}, checksums: {}, accounts: {}, conversions: [] };
  for (const table of tables) {
    const summary = digest();
    for (const row of source.rows(table, report.conversions)) {
      if (row.some(value => typeof value === 'bigint' && (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)))) {
        throw new MigrationError('来源记录 ID、时间或版本超出 WordPaper 可表示的整数范围。');
      }
      summary.add(row);
      if (table.name === 'users') report.accounts[row[0]] = {};
      if (table.name === 'user_state') inspectState(report, row);
    }
    const result = summary.finish();
    report.counts[table.name] = result.count;
    report.checksums[table.name] = result.checksum;
  }
  report.snapshotHash = createHash('sha256').update(JSON.stringify([source.nextId.toString(), report.checksums])).digest('hex');
  return report;
}

function sameRow(actual, expected) {
  return expected.every((value,i) => value === null ? actual[i] === null : actual[i] !== null && String(actual[i]) === String(value));
}

function cipherFor(name) {
  const key = Buffer.from(process.env[name] || '', 'base64');
  if (key.length !== 32) throw new MigrationError('模型或语音绑定存在。请通过安全环境配置 ' + name + '。');
  return createAccountCipher('', key);
}

async function transfer(source, client, mode, instance, report) {
  // A frozen legacy source is compared per source, not against every row in a
  // shared target. No source may silently adopt a target by username or integer ID.
  const mutating = mode === 'import';
  if (mutating) {
    await client.query('LOCK TABLE ' + [...tableNames, 'migration_accounts', 'migration_receipts'].map(qualified).join(', ') +
      ' IN SHARE ROW EXCLUSIVE MODE');
  }
  const receipt = (await client.query('SELECT snapshot_hash FROM wordpaper.migration_receipts WHERE source_instance=$1', [instance])).rows[0];
  if (receipt && receipt.snapshot_hash !== report.snapshotHash) {
    throw new MigrationError('该来源已导入另一份快照。请对账新增、删除与修改，防止覆盖云端新写入。');
  }
  if (!receipt && !mutating) throw new MigrationError('目标尚无该来源的成功导入记录。');
  const mapping = new Map((await client.query('SELECT source_id,user_id FROM wordpaper.migration_accounts WHERE source_instance=$1',
    [instance])).rows.map(row => [String(row.source_id), String(row.user_id)]));
  const sequence = await client.query('SELECT last_value, is_called FROM wordpaper.users_id_seq');
  const max = await client.query('SELECT COALESCE(MAX(id),0) AS high FROM wordpaper.users');
  const {last_value, is_called} = sequence.rows[0];
  const nextFromTarget = BigInt(last_value) + (is_called ? 1n : 0n);
  let nextId = [source.nextId, nextFromTarget, BigInt(max.rows[0].high)+1n].reduce((a,b)=>a>b?a:b);
  const allowInsert = mutating && !receipt;
  for (const table of tables) {
    const columns = table.columns.split(' ');
    const keys = table.key.split(' ');
    const fullName = qualified(table.name);
    const selection = 'SELECT ' + columns.map(quote).join(',') + ' FROM ' + fullName + ' WHERE ' +
      keys.map((key,i) => quote(key) + '=$' + (i+1)).join(' AND ');
    const insert = 'INSERT INTO ' + fullName + '(' + columns.map(quote).join(',') + ') VALUES (' +
      columns.map((_,i) => '$' + (i+1)).join(',') + ')';
    const ownerIndex = columns.indexOf(table.name === 'users' ? 'id' : 'user_id');
    const cipherIndex = columns.indexOf('key_cipher');
    for (const sourceRow of source.rows(table)) {
      const row = [...sourceRow];
      const oldId = ownerIndex >= 0 ? String(row[ownerIndex]) : null;
      let needsMapping = false;
      if (oldId && !mapping.has(oldId)) {
        if (table.name !== 'users' || !allowInsert) throw new MigrationError('目标缺少来源账号映射。');
        const used = await client.query('SELECT 1 FROM wordpaper.users WHERE id=$1', [oldId]);
        const id = used.rowCount || BigInt(oldId) < nextFromTarget ? nextId++ : BigInt(oldId);
        if (id <= 0n || id >= BigInt(Number.MAX_SAFE_INTEGER)) throw new MigrationError('账号 ID 超出可用范围。');
        mapping.set(oldId, String(id));
        needsMapping = true;
      }
      if (oldId) row[ownerIndex] = mapping.get(oldId);
      const target = (await client.query({ text: selection, rowMode: 'array', values: keys.map(k => row[columns.indexOf(k)]) })).rows[0];
      if (cipherIndex >= 0) {
        const src = process.env.WORDPAPER_SOURCE_MODEL_KEY_BASE64 ? cipherFor('WORDPAPER_SOURCE_MODEL_KEY_BASE64') : cipherFor('WORDPAPER_MODEL_KEY_BASE64');
        const dst = cipherFor('WORDPAPER_MODEL_KEY_BASE64');
        const prefix = table.name === 'user_speech' ? 'speech:' : '';
        const plaintext = src.decrypt(prefix + oldId, row[cipherIndex]);
        if (target) {
          if (dst.decrypt(prefix + row[ownerIndex], target[cipherIndex]) !== plaintext) throw new MigrationError('目标账号已有不同的模型或语音绑定。');
          row[cipherIndex] = target[cipherIndex];
        } else row[cipherIndex] = dst.encrypt(prefix + row[ownerIndex], plaintext);
      }
      if (target && !sameRow(target,row)) throw new MigrationError('目标已有不同数据，终止事务。表 '+ table.name +
        (oldId ? '，来源账号 ID '+oldId : '') + (table.name === 'user_state' ? '，命名空间 '+row[1] : '') + '。');
      if (!target) {
        if (!allowInsert) throw new MigrationError('目标缺少已导入记录。请核对删除记录，迁移不会将其恢复。');
        const inserted = (await client.query({ text: insert+' RETURNING '+columns.map(quote).join(','), rowMode: 'array', values: row })).rows[0];
        if (!sameRow(inserted,row)) throw new MigrationError('插入记录核验失败。');
      }
      if (needsMapping) await client.query('INSERT INTO wordpaper.migration_accounts(source_instance,source_id,user_id) VALUES ($1,$2,$3)',
        [instance, oldId, row[ownerIndex]]);
    }
  }
  if (allowInsert) {
    await client.query('ALTER TABLE wordpaper.users ALTER COLUMN id RESTART WITH ' + nextId);
    await client.query('INSERT INTO wordpaper.migration_receipts(source_instance,snapshot_hash) VALUES ($1,$2)', [instance,report.snapshotHash]);
  }
  return { ...report, accountMapping: Object.fromEntries(mapping), previouslyImported: Boolean(receipt) };
}

async function main() {
  const [mode, filename, ...extra] = process.argv.slice(2);
  const instance = process.env.WORDPAPER_SOURCE_INSTANCE;
  if (!['inventory', 'dry-run', 'import', 'verify'].includes(mode) || !filename || extra.length) {
    throw new MigrationError('用法：node scripts/migrate_wordpaper_postgres.js [inventory|dry-run|import|verify] /path/to/wordpaper.sqlite');
  }
  if (['import','verify'].includes(mode) && !/^[A-Za-z0-9_-]{1,80}$/.test(instance || '')) throw new MigrationError('请指定稳定来源名 WORDPAPER_SOURCE_INSTANCE。');
  const decisionPath = process.env.WORDPAPER_MIGRATION_DECISIONS;
  const decisions = decisionPath ? JSON.parse(fs.readFileSync(decisionPath, 'utf8')) : {};
  if (decisionPath && (!instance || instance !== decisions.sourceInstance)) throw new MigrationError('归属决定文件与来源实例不符。');
  if (!fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) throw new MigrationError('SQLite 文件不可读或不存在。');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('BEGIN');
    const source = sourceSnapshot(db, decisions, mode === 'inventory');
    const report = inspectSource(source);
    if (mode === 'inventory' || mode === 'dry-run') return {mode, ...report};
    const client = targetConnection();
    try {
      await client.connect();
      await client.query(mode === 'verify' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      try {
        const result = await transfer(source, client, mode, instance, report);
        await client.query('COMMIT');
        return {mode, ...result};
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally { await client.end(); }
  } finally { db.close(); }
}

main().then(report => console.log(JSON.stringify(report))).catch(error => {
  const code = /^[A-Z0-9_]+$/.test(error.code || '') ? ' (' + error.code + ')' : '';
  console.error(error instanceof MigrationError ? error.message : 'WordPaper 迁移失败' + code + '。');
  process.exitCode = 1;
});
