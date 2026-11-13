import { startRuntime } from './server.ts';

if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.version !== 'v24.22.2') {
  console.error('[runtime] unsupported_platform_or_node');
  process.exit(1);
}
// Bootstrap travels through the inherited pipe, never argv, environment, or logs.
let bootstrap = '';
process.stdin.setEncoding('utf8');
const timer = setTimeout(() => process.exit(1), 5000);
process.stdin.on('data', chunk => {
  bootstrap += chunk;
  if (bootstrap.length > 4096) process.exit(1);
  if (!bootstrap.endsWith('\n')) return;
  clearTimeout(timer);
  try {
    const runtime = startRuntime(JSON.parse(bootstrap));
    process.stdin.removeAllListeners('data');
    process.stdin.on('end', runtime.stop);
    process.on('SIGTERM', runtime.stop);
    process.on('SIGINT', runtime.stop);
  } catch {
    console.error('[runtime] bootstrap_failed');
    process.exit(1);
  }
});
process.stdin.on('end', () => { clearTimeout(timer); });
