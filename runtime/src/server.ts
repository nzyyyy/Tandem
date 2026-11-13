import { createServer } from 'node:net';
import { chmodSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { FrameDecoder, encodeFrame } from './protocol.ts';
import { AppError } from './errors.ts';
import type { AppService } from './service.ts';

type Bootstrap = { socketPath: string; token: string; hostPid: number };

export function startRuntime(config: Bootstrap, service?: AppService) {
  const parent = lstatSync(dirname(config.socketPath));
  if (!parent.isDirectory() || parent.uid !== process.getuid!() || (parent.mode & 0o777) !== 0o700
      || config.hostPid !== process.ppid || !/^[a-f0-9]{64}$/.test(config.token)) {
    throw new Error('INVALID_BOOTSTRAP');
  }
  const clients = new Set<import('node:net').Socket>();
  const server = createServer(socket => {
    clients.add(socket);
    const decoder = new FrameDecoder();
    let authenticated = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    socket.on('data', chunk => {
      try {
        for (const value of decoder.push(chunk)) {
          if (!value || typeof value !== 'object') throw new Error('INVALID_REQUEST');
          const request = value as Record<string, unknown>;
          if (request.protocolVersion !== 1 || typeof request.requestId !== 'string'
              || request.requestId.length > 128 || typeof request.method !== 'string') throw new Error('INVALID_REQUEST');
          const reply = (data: unknown) => socket.write(encodeFrame({ protocolVersion: 1, requestId: request.requestId, ok: true, data }));
          if (!authenticated) {
            const payload = request.payload as Record<string, unknown> | null;
            const token = typeof payload?.token === 'string' ? Buffer.from(payload.token) : Buffer.alloc(0);
            const expected = Buffer.from(config.token);
            if (request.method !== 'hello' || token.length !== expected.length || !timingSafeEqual(token, expected)) throw new Error('UNAUTHORIZED');
            authenticated = true;
            reply({ pid: process.pid, arch: process.arch, nodeVersion: process.version });
          } else if (request.method === 'ping') {
            reply({ pong: true, pid: process.pid });
          } else {
            try {
              if (!service) throw new AppError('METHOD_NOT_FOUND');
              reply(service.dispatch(request.method, request.payload));
            } catch (error) {
              socket.write(encodeFrame({ protocolVersion: 1, requestId: request.requestId, ok: false,
                error: { code: error instanceof AppError ? error.code : 'LOCAL_STORAGE_ERROR', retryable: false } }));
            }
          }
        }
      } catch {
        // Do not log request bodies: future frames may contain private data.
        socket.destroy();
      }
    });
  });
  server.on('error', () => { console.error('[runtime] server_error'); process.exitCode = 1; stop(); });
  server.listen(config.socketPath, () => {
    chmodSync(config.socketPath, 0o600);
    console.error('[runtime] ready');
  });
  function stop() {
    for (const socket of clients) socket.destroy();
    server.close();
    if (service) void service.stop().catch(() => { console.error('[runtime] shutdown_failed'); process.exitCode = 1; });
  }
  return { server, stop };
}
