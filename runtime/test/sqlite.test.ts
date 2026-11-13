import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';

test('bundled arm64 Node supports SQLite WAL, transactions and FTS5', () => {
  assert.equal(process.arch, 'arm64');
  const dir = mkdtempSync('/tmp/tandem-sqlite-');
  const db = new DatabaseSync(`${dir}/probe.sqlite`);
  try {
    assert.equal(db.prepare('PRAGMA journal_mode=WAL').get()!.journal_mode, 'wal');
    db.exec('PRAGMA foreign_keys=ON; CREATE VIRTUAL TABLE probe USING fts5(content); BEGIN;');
    db.prepare('INSERT INTO probe(content) VALUES (?)').run('Tandem M0');
    db.exec('COMMIT');
    assert.equal(db.prepare("SELECT content FROM probe WHERE probe MATCH 'Tandem'").get()!.content, 'Tandem M0');
    db.exec("BEGIN; INSERT INTO probe(content) VALUES ('rollback'); ROLLBACK;");
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM probe').get()!.count, 1);
    console.log(`[sqlite] version=${db.prepare('SELECT sqlite_version() AS version').get()!.version}`);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
