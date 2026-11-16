import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameDecoder, encodeFrame, MAX_FRAME_BYTES } from "../src/protocol.ts";

test("UTF-8 frames survive fragmentation and coalescing", () => {
  const decoder = new FrameDecoder();
  const one = encodeFrame({ text: "你好 👋" });
  assert.deepEqual(decoder.push(one.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(one.subarray(2, 7)), []);
  assert.deepEqual(decoder.push(Buffer.concat([one.subarray(7), encodeFrame({ n: 2 })])), [
    { text: "你好 👋" },
    { n: 2 },
  ]);
});

test("reject zero, oversized, malformed JSON and invalid UTF-8 frames", () => {
  for (const size of [0, MAX_FRAME_BYTES + 1]) {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(size);
    assert.throws(() => new FrameDecoder().push(prefix));
  }
  assert.throws(() => encodeFrame("a".repeat(MAX_FRAME_BYTES)));
  assert.throws(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 1, 123])));
  assert.throws(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 1, 255])));
});
