import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");

test("generated line boxes disable the browser's second justification pass", () => {
  assert.match(source, /lineEl\.style\.textAlign = "start"/);
  assert.match(source, /lineEl\.style\.textAlignLast = "start"/);
  assert.doesNotMatch(source, /textAlignLast !== "auto" \? textAlignLast : textAlign/);
});
