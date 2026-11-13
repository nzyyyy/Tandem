import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const bin = execFileSync('swift', ['build', '--package-path', 'native', '--arch', 'arm64', '--show-bin-path'], { encoding: 'utf8' }).trim();
const result = spawnSync(`${bin}/Tandem`, ['--smoke-test', process.execPath, resolve('runtime/src/main.ts')], { stdio: 'inherit', timeout: 45000 });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(1);
