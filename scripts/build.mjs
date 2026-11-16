import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
const iconset = resolve('dist/AppIcon.iconset');
mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    execFileSync('sips', ['-z', String(size * scale), String(size * scale), 'native/Resources/AppIcon.png',
      '--out', `${iconset}/icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`]);
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', `${contents}/Resources/AppIcon.icns`]);
cpSync(`${bin}/Tandem`, `${contents}/MacOS/Tandem`);
cpSync(process.execPath, `${contents}/Resources/node`);
cpSync('dist/runtime', `${contents}/Resources/runtime`, { recursive: true });
// Install the locked production graph offline, then preserve pnpm's relative links inside the app.
const dependencies = resolve('dist/runtime-dependencies');
mkdirSync(dependencies, { recursive: true });
for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) cpSync(file, `${dependencies}/${file}`);
execFileSync('pnpm', ['install', '--prod', '--offline', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace'], {
  cwd: dependencies, stdio: 'inherit', env: { ...process.env, CI: 'true' },
});
rmSync(`${contents}/Resources/node_modules`, { recursive: true, force: true });
cpSync(`${dependencies}/node_modules`, `${contents}/Resources/node_modules`, { recursive: true, verbatimSymlinks: true });
for (const resource of readdirSync(bin, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.endsWith('.bundle'))) {
  cpSync(`${bin}/${resource.name}`, `${contents}/Resources/${resource.name}`, { recursive: true });
}
let notices = readFileSync('native/Resources/ThirdPartyNotices.txt', 'utf8');
for (const entry of readdirSync(`${dependencies}/node_modules/.pnpm`, { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== 'node_modules')) {
  const root = `${dependencies}/node_modules/.pnpm/${entry.name}/node_modules`;
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const packages = name.name.startsWith('@') && name.isDirectory()
      ? readdirSync(`${root}/${name.name}`, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => `${root}/${name.name}/${e.name}`)
      : name.isDirectory() ? [`${root}/${name.name}`] : [];
    for (const path of packages) {
      const manifest = JSON.parse(readFileSync(`${path}/package.json`, 'utf8'));
      notices += `\n\n${manifest.name} ${manifest.version} (${manifest.license ?? 'see package'})\n${'='.repeat(60)}\n`;
      for (const file of readdirSync(path).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file))) {
        notices += readFileSync(`${path}/${file}`, 'utf8') + '\n';
      }
    }
  }
}
writeFileSync(`${contents}/Resources/ThirdPartyNotices.txt`, notices);
writeFileSync(`${contents}/Resources/package.json`, '{"type":"module"}\n');
writeFileSync(`${contents}/Info.plist`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Tandem</string>
<key>CFBundleIdentifier</key><string>dev.tandem.personal-agent</string>
<key>CFBundleName</key><string>Tandem</string>
<key>CFBundleIconFile</key><string>AppIcon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>16</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
// In-place rebuilds must invalidate Finder's cached bundle metadata and icon.
const app = resolve('dist/Tandem.app');
const now = new Date();
utimesSync(app, now, now);
execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app]);
console.log(`Built ${resolve('dist/Tandem.app')}`);
