import { execFileSync } from 'node:child_process';
import './build.mjs';
execFileSync('open', ['dist/Tandem.app'], { stdio: 'inherit' });
