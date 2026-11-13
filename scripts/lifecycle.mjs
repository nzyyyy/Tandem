import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const result = spawnSync(resolve('dist/Tandem.app/Contents/MacOS/Tandem'), ['--lifecycle-test'], {
  encoding: 'utf8', timeout: 20000
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
assert.equal(result.status, 0);
assert.match(result.stdout, /PASS App lifecycle/);
const pids = [...result.stderr.matchAll(/runtime_started pid=(\d+)/g)].map(match => Number(match[1]));
assert.ok(pids.length > 0);
for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
console.log('PASS bundled Node exited with App');
