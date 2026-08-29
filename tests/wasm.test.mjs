import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("compiled WASM accepts JSON and returns line records", async () => {
  const bytes = await readFile(new URL("../wasm/tex_line_breaker_core.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const wasm = instance.exports;
  const input = new TextEncoder().encode(JSON.stringify({
    line_width: 85,
    tolerance: 3,
    units: [
      { width: 40, can_break_after: true, stretch: 8, shrink: 4 },
      { width: 40, can_break_after: true, stretch: 8, shrink: 4 },
      { width: 40, can_break_after: true, stretch: 8, shrink: 4 }
    ]
  }));
  const inputPtr = wasm.alloc(input.length);
  new Uint8Array(wasm.memory.buffer, inputPtr, input.length).set(input);
  const packed = wasm.layout(inputPtr, input.length);
  wasm.dealloc(inputPtr, input.length);
  const outputPtr = Number(packed >> 32n);
  const outputLen = Number(packed & 0xffffffffn);
  const output = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, outputPtr, outputLen)));
  wasm.dealloc(outputPtr, outputLen);
  assert.equal(output.lines.length, 2);
  assert.deepEqual(output.lines.map(line => [line.start, line.end]), [[0, 2], [2, 3]]);
  assert.equal(output.pass, "pretolerance");
  assert.equal(typeof output.lines[0].adjustment, "number");
});
