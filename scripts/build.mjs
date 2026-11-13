import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.version !== 'v24.22.2') {
  throw new Error('Requires Apple Silicon macOS and Node 24.22.2');
}
execFileSync('pnpm', ['exec', 'tsc'], { stdio: 'inherit' });
execFileSync('swift', ['build', '--package-path', 'native', '--arch', 'arm64'], { stdio: 'inherit' });
const bin = execFileSync('swift', ['build', '--package-path', 'native', '--arch', 'arm64', '--show-bin-path'], { encoding: 'utf8' }).trim();
const contents = resolve('dist/Tandem.app/Contents');
mkdirSync(`${contents}/MacOS`, { recursive: true });
mkdirSync(`${contents}/Resources/runtime`, { recursive: true });
cpSync(`${bin}/Tandem`, `${contents}/MacOS/Tandem`);
cpSync(process.execPath, `${contents}/Resources/node`);
cpSync('dist/runtime', `${contents}/Resources/runtime`, { recursive: true });
writeFileSync(`${contents}/Resources/package.json`, '{"type":"module"}\n');
writeFileSync(`${contents}/Info.plist`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Tandem</string>
<key>CFBundleIdentifier</key><string>dev.tandem.personal-agent</string>
<key>CFBundleName</key><string>Tandem</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.0.1</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
console.log(`Built ${resolve('dist/Tandem.app')}`);
