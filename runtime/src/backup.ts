import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ConfigStore, validateConfig } from './config.ts';
import { Store } from './store.ts';
import { AppError, record, requireValue, text } from './errors.ts';
import type { RestorePreview } from './contract.ts';

const MAX_DATA = 128 * 1024 * 1024;
const MAX_PACKAGE = 192 * 1024 * 1024;
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
type Entry = { path: string; type: 'file'; size: number; sha256: string; data: string };
type Manifest = { format: 'tandem-backup'; formatVersion: 1; appVersion: string; createdAt: string; databaseSchema: number; configSchema: number; files: Entry[] };
type Prepared = { directory: string; preview: RestorePreview; expiresAt: number };

const canonical = (directory: string) => join(realpathSync(dirname(resolve(directory))), basename(resolve(directory)));

function sync(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function write(path: string, data: string | Buffer) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncTree(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) syncTree(path);
    else { requireValue(entry.isFile(), 'BACKUP_PATH'); sync(path); }
  }
  sync(directory);
}
function read(path: string, limit: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    requireValue(info.isFile() && info.size <= limit, 'BACKUP_SIZE');
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      requireValue(count > 0, 'BACKUP_CHANGED'); offset += count;
    }
    const after = fstatSync(fd);
    requireValue(data.length <= limit && after.size === info.size && after.mtimeMs === info.mtimeMs, 'BACKUP_CHANGED');
    return data;
  } finally { closeSync(fd); }
}
function schema(db: DatabaseSync) {
  return db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name').all();
}
function check(db: DatabaseSync) {
  db.exec('PRAGMA trusted_schema=OFF');
  requireValue(db.prepare('PRAGMA integrity_check').get()!.integrity_check === 'ok'
    && db.prepare('PRAGMA foreign_key_check').all().length === 0, 'BACKUP_DATABASE');
}
function safePath(path: unknown): asserts path is string {
  requireValue(typeof path === 'string' && path.length <= 1024 && !/[\\\x00-\x1f\x7f]/.test(path)
    && (path === 'config.json' || path === 'tandem.sqlite' || path.startsWith('attachments/'))
    && path.split('/').length <= 16 && path.split('/').every(p => p && p !== '.' && p !== '..'), 'BACKUP_PATH');
}
function sibling(directory: string, path: unknown, kind: string): asserts path is string {
  requireValue(typeof path === 'string' && dirname(path) === dirname(directory)
    && basename(path).startsWith(`${basename(directory)}.${kind}-`) && /^[a-zA-Z0-9-]+$/.test(basename(path).slice(`${basename(directory)}.${kind}-`.length)), 'RESTORE_JOURNAL');
}

// A journal survives both directory renames. An uncommitted switch always rolls back on startup.
export function recoverRestore(directory: string) {
  if (!existsSync(resolve(directory) + '.restore-journal.json')) return;
  directory = canonical(directory);
  const journal = directory + '.restore-journal.json';
  if (!existsSync(journal)) return;
  const state = record(JSON.parse(read(journal, 4096).toString('utf8')));
  sibling(directory, state.protection, 'protection'); sibling(directory, state.stage, 'stage');
  if (existsSync(state.protection)) {
    requireValue(lstatSync(state.protection).isDirectory() && !lstatSync(state.protection).isSymbolicLink(), 'RESTORE_JOURNAL');
    if (existsSync(directory)) renameSync(directory, directory + '.failed-' + randomUUID());
    renameSync(state.protection, directory);
  }
  requireValue(existsSync(directory), 'RESTORE_JOURNAL');
  rmSync(state.stage, { recursive: true, force: true });
  sync(dirname(directory)); unlinkSync(journal); sync(dirname(directory));
}

export class Backups {
  readonly directory: string;
  private prepared: Prepared | null = null;
  constructor(directory: string) { this.directory = canonical(directory); }

  generation() {
    const path = join(this.directory, '.generation');
    if (!existsSync(path)) write(path, randomUUID());
    const value = read(path, 64).toString('utf8');
    requireValue(/^[a-f0-9-]{36}$/.test(value), 'RESTORE_JOURNAL');
    return value;
  }

  export(store: Store, config: ConfigStore, destination: unknown) {
    const path = resolve(text(destination, 4096));
    const parent = realpathSync(dirname(path));
    const location = relative(this.directory, join(parent, basename(path)));
    requireValue(isAbsolute(text(destination, 4096)) && location.startsWith('..' + '/') && !existsSync(path), 'BACKUP_DESTINATION');
    const temporary = mkdtempSync(join(this.directory, '.backup-'));
    const output = join(parent, `.tandem-backup-${randomUUID()}.tmp`);
    let published = false;
    try {
      const document = config.read();
      store.db.prepare('VACUUM INTO ?').run(join(temporary, 'tandem.sqlite'));
      const snapshot = new DatabaseSync(join(temporary, 'tandem.sqlite'), { readOnly: true });
      try { check(snapshot); } finally { snapshot.close(); }
      const clean = { ...document.config, modelConnections: document.config.modelConnections.map(c => ({ ...c, key: '' })) };
      write(join(temporary, 'config.json'), JSON.stringify(clean, null, 2) + '\n');
      const files: Entry[] = [];
      let total = 0;
      const add = (source: string, name: string) => {
        safePath(name);
        const data = read(source, MAX_DATA - total); total += data.length;
        requireValue(files.length < 4096, 'BACKUP_SIZE');
        files.push({ path: name, type: 'file', size: data.length, sha256: hash(data), data: data.toString('base64') });
      };
      add(join(temporary, 'tandem.sqlite'), 'tandem.sqlite'); add(join(temporary, 'config.json'), 'config.json');
      const visit = (source: string, name: string) => {
        const info = lstatSync(source);
        requireValue(!info.isSymbolicLink(), 'BACKUP_PATH');
        if (info.isDirectory()) {
          requireValue(name.split('/').length < 16, 'BACKUP_PATH');
          for (const child of readdirSync(source).sort()) visit(join(source, child), name + '/' + child);
        } else add(source, name);
      };
      if (existsSync(join(this.directory, 'attachments'))) visit(join(this.directory, 'attachments'), 'attachments');
      requireValue(config.read().revision === document.revision, 'CONFIG_CONFLICT');
      const manifest: Manifest = { format: 'tandem-backup', formatVersion: 1, appVersion: '0.1.0', createdAt: new Date().toISOString(), databaseSchema: 4, configSchema: 1, files };
      // shortcut: bounded JSON/base64 keeps the format dependency-free; stream a standard archive when larger backups are needed.
      const raw = JSON.stringify(manifest) + '\n';
      requireValue(Buffer.byteLength(raw) <= MAX_PACKAGE, 'BACKUP_SIZE');
      write(output, raw);
      requireValue(hash(read(output, MAX_PACKAGE)) === hash(Buffer.from(raw)), 'BACKUP_CHECKSUM');
      // link publishes without replacing a file created after the destination check.
      linkSync(output, path); published = true; sync(parent);
      return { path, createdAt: manifest.createdAt };
    } catch (error) {
      if (published) unlinkSync(path);
      throw error;
    } finally { rmSync(temporary, { recursive: true, force: true }); rmSync(output, { force: true }); }
  }

  cancel(token?: unknown) {
    if (token !== undefined && this.prepared?.preview.token !== token) return {};
    if (this.prepared) rmSync(this.prepared.directory, { recursive: true, force: true });
    this.prepared = null;
    return {};
  }

  preview(source: unknown, reference: Store): RestorePreview {
    this.cancel();
    const path = text(source, 4096);
    requireValue(isAbsolute(path), 'BACKUP_PATH');
    let manifest: Record<string, any>;
    try { manifest = record(JSON.parse(read(path, MAX_PACKAGE).toString('utf8'))); }
    catch (error) { throw error instanceof SyntaxError ? new AppError('BACKUP_FORMAT') : error; }
    requireValue(manifest.format === 'tandem-backup' && manifest.formatVersion === 1 && manifest.configSchema === 1
      && [1, 2, 3, 4].includes(manifest.databaseSchema), 'BACKUP_VERSION');
    requireValue(typeof manifest.createdAt === 'string' && Number.isFinite(Date.parse(manifest.createdAt))
      && typeof manifest.appVersion === 'string' && manifest.appVersion.length <= 64
      && Array.isArray(manifest.files) && manifest.files.length >= 2 && manifest.files.length <= 4096, 'BACKUP_FORMAT');
    const stage = mkdtempSync(this.directory + '.stage-');
    let store: Store | undefined;
    try {
      let total = 0;
      const names = new Set<string>();
      for (const value of manifest.files) {
        const entry = record(value); safePath(entry.path);
        requireValue(entry.type === 'file' && !names.has(entry.path), 'BACKUP_PATH'); names.add(entry.path);
        requireValue(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_DATA - total
          && typeof entry.data === 'string' && entry.data.length === 4 * Math.ceil(entry.size / 3)
          && /^[a-f0-9]{64}$/.test(entry.sha256), 'BACKUP_SIZE');
        const data = Buffer.from(entry.data, 'base64');
        requireValue(data.length === entry.size && data.toString('base64') === entry.data && hash(data) === entry.sha256, 'BACKUP_CHECKSUM');
        total += data.length;
        const target = join(stage, entry.path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); write(target, data);
      }
      requireValue(names.has('config.json') && names.has('tandem.sqlite'), 'BACKUP_FORMAT');
      const config = validateConfig(JSON.parse(read(join(stage, 'config.json'), 256 * 1024).toString('utf8')));
      requireValue(config.modelConnections.every(c => c.key === ''), 'BACKUP_CREDENTIALS');
      const db = new DatabaseSync(join(stage, 'tandem.sqlite'), { readOnly: true, allowExtension: false });
      try {
        const allowed = schema(reference.db);
        const incoming = schema(db);
        requireValue(db.prepare('PRAGMA user_version').get()!.user_version === manifest.databaseSchema, 'BACKUP_VERSION');
        requireValue(incoming.every(s => allowed.some(a => a.name === s.name && a.type === s.type)
          && (s.type === 'table' || s.type === 'index')
          && (!/CREATE\s+VIRTUAL\s+TABLE/i.test(String(s.sql)) || allowed.some(a => a.sql === s.sql))), 'BACKUP_DATABASE');
        if (manifest.databaseSchema === 4) requireValue(JSON.stringify(incoming) === JSON.stringify(allowed), 'BACKUP_DATABASE');
        check(db);
      } finally { db.close(); }
      store = new Store(stage);
      requireValue(JSON.stringify(schema(store.db)) === JSON.stringify(schema(reference.db)), 'BACKUP_DATABASE');
      check(store.db);
      const count = (table: string) => Number(store!.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
      const preview = { token: randomUUID(), createdAt: manifest.createdAt, appVersion: manifest.appVersion, databaseSchema: manifest.databaseSchema,
        messages: count('messages'), projects: count('projects'), memories: count('memories'), tasks: count('tasks'), attachments: names.size - 2 };
      store.db.close(); store = undefined;
      this.prepared = { directory: stage, preview, expiresAt: Date.now() + 30 * 60 * 1000 };
      return preview;
    } catch (error) {
      store?.db.close(); rmSync(stage, { recursive: true, force: true });
      throw error instanceof AppError ? error : new AppError('BACKUP_FORMAT');
    }
  }

  staged(token: unknown) {
    requireValue(this.prepared && this.prepared.preview.token === token && Date.now() < this.prepared.expiresAt, 'RESTORE_PREVIEW_EXPIRED');
    return this.prepared.directory;
  }

  switch(token: unknown, close: () => void, reopen: () => void) {
    const stage = this.staged(token);
    const protection = this.directory + '.protection-' + randomUUID();
    const journal = this.directory + '.restore-journal.json';
    requireValue(!existsSync(journal), 'RESTORE_JOURNAL');
    write(join(stage, '.generation'), randomUUID()); syncTree(stage);
    close();
    try {
      const temporary = journal + '.tmp';
      rmSync(temporary, { force: true });
      write(temporary, JSON.stringify({ stage, protection }));
      renameSync(temporary, journal); sync(dirname(journal));
      renameSync(this.directory, protection); sync(dirname(journal));
      renameSync(stage, this.directory); sync(dirname(journal));
      reopen();
      unlinkSync(journal); sync(dirname(journal));
      this.prepared = null;
      return { protectionPath: protection };
    } catch (error) {
      close();
      if (existsSync(protection) && !existsSync(journal)) {
        write(journal + '.tmp', JSON.stringify({ stage, protection }));
        renameSync(journal + '.tmp', journal); sync(dirname(journal));
      }
      recoverRestore(this.directory);
      rmSync(stage, { recursive: true, force: true }); rmSync(journal + '.tmp', { force: true });
      this.prepared = null;
      reopen();
      throw error;
    }
  }
}
