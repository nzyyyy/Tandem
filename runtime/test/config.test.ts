import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { ConfigStore, emptyConfig, validateConfig, redact, bindModel } from '../src/config.ts';

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


test('provider names round-trip without changing legacy IDs or model bindings', () => {
  const legacy = fixtureConfig();
  assert.deepEqual(validateConfig(legacy), legacy);
  const dir = mkdtempSync('/tmp/tandem-provider-');
  try {
    const store = new ConfigStore(dir);
    const first = store.save({ ...legacy, modelConnections: [{ ...legacy.modelConnections[0], name: ' 我的供应商 ' }] }, 'missing');
    assert.equal(first.config.modelConnections[0].name, '我的供应商');
    assert.equal(new ConfigStore(dir).read().config.modelConnections[0].name, '我的供应商');
    const renamed = store.save({ ...first.config, modelConnections: [{ ...first.config.modelConnections[0], name: '备用供应商' }] }, first.revision);
    assert.deepEqual(renamed.config.defaultModel, legacy.defaultModel);
    assert.equal(bindModel(renamed.config).id, 'primary');
    assert.equal(bindModel(renamed.config).modelName, 'same-model');
    for (const name of ['', '   ', null, 42, 'a\nb', 'a\u0000b', 'x'.repeat(121)]) {
      assert.throws(() => validateConfig({ ...legacy, modelConnections: [{ ...legacy.modelConnections[0], name }] }), /CONFIG_CONNECTION_NAME/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
