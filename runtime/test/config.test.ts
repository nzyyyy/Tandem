import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { ConfigStore, emptyConfig, validateConfig, redact } from '../src/config.ts';

export const fixtureConfig = () => ({ schemaVersion: 1 as const, modelConnections: [
  { id: 'primary', protocol: 'openai' as const, apiType: 'responses' as const, url: 'https://example.com/v1', key: 'test-private-key', modelNames: ['same-model', 'second-model'] }
], defaultModel: { connectionId: 'primary', modelName: 'same-model' } });

test('configuration persists atomically with private permissions and conflict protection', () => {
  const dir = mkdtempSync('/tmp/tandem-config-');
  try {
    const store = new ConfigStore(dir);
    assert.deepEqual(store.read().config, emptyConfig());
    const first = store.save(fixtureConfig(), 'missing');
    assert.deepEqual(new ConfigStore(dir).read(), first);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.throws(() => store.save(emptyConfig(), 'missing'), /CONFIG_CONFLICT/);
    const external = { ...fixtureConfig(), defaultModel: null };
    writeFileSync(store.path, JSON.stringify(external));
    assert.throws(() => store.save(emptyConfig(), first.revision), /CONFIG_CONFLICT/);
    assert.deepEqual(store.read().config, external);
    writeFileSync(store.path, '{"key":"DO_NOT_ECHO"');
    assert.throws(() => store.save(emptyConfig(), first.revision), error => !String(error).includes('DO_NOT_ECHO'));
    assert.match(readFileSync(store.path, 'utf8'), /DO_NOT_ECHO/);
    writeFileSync(store.path, JSON.stringify({ ...fixtureConfig(), schemaVersion: 999 }));
    assert.throws(() => store.read(), /CONFIG_VERSION/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validate protocols, model identity and URL credential boundaries', () => {
  const base = fixtureConfig();
  for (const patch of [
    { apiType: 'messages' }, { protocol: 'other' }, { modelNames: [''] }, { modelNames: ['x', 'x'] },
    { url: 'http://example.com/v1' }, { url: 'https://user:secret@example.com' }, { url: 'https://example.com/?key=secret' }, { key: 'a\r\nb' }
  ]) assert.throws(() => validateConfig({ ...base, modelConnections: [{ ...base.modelConnections[0], ...patch }] }));
  assert.throws(() => validateConfig({ ...base, defaultModel: { connectionId: 'missing', modelName: 'same-model' } }));
  assert.equal(redact('before test-private-key after', base), 'before [REDACTED] after');
  const dir = mkdtempSync('/tmp/tandem-config-');
  try {
    writeFileSync(`${dir}/source`, JSON.stringify(base));
    symlinkSync(`${dir}/source`, `${dir}/config.json`);
    assert.throws(() => new ConfigStore(dir).read());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
