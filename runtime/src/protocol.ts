import { TextDecoder } from 'node:util';

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (!body.length || body.length > MAX_FRAME_BYTES) throw new Error('FRAME_SIZE');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}

export class FrameDecoder {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: unknown[] = [];
    while (this.pending.length >= 4) {
      const size = this.pending.readUInt32BE();
      if (!size || size > MAX_FRAME_BYTES) throw new Error('FRAME_SIZE');
      if (this.pending.length < size + 4) break;
      frames.push(JSON.parse(utf8.decode(this.pending.subarray(4, size + 4))));
      this.pending = this.pending.subarray(size + 4);
    }
    return frames;
  }
}
