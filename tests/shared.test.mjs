import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const shared = require("../shared.js");

test("site rule overrides global setting and matches subdomains", () => {
  const settings = { ...shared.DEFAULTS, globalEnabled: true, siteRules: [{ domain: "example.com", enabled: false }] };
  assert.equal(shared.effectiveEnabled(settings, "www.example.com"), false);
  assert.equal(shared.effectiveEnabled(settings, "other.test"), true);
});

test("CJK punctuation prohibition prevents illegal breaks", () => {
  const tokens = shared.applyBreakRules(shared.tokenizeText("你好，世界"), true);
  assert.equal(tokens[0].canBreakAfter, true);
  assert.equal(tokens[1].canBreakAfter, false);
  assert.equal(tokens[2].canBreakAfter, true);
});

test("English words stay intact and break at spaces", () => {
  const tokens = shared.applyBreakRules(shared.tokenizeText("Hello world"), true);
  assert.deepEqual(tokens.map(token => token.text), ["Hello", " ", "world"]);
  assert.deepEqual(tokens.map(token => [token.start, token.end]), [[0, 5], [5, 6], [6, 11]]);
  assert.equal(tokens[0].canBreakAfter, false);
  assert.equal(tokens[1].canBreakAfter, true);
});

test("mixed CJK and English has a legal script boundary", () => {
  const tokens = shared.applyBreakRules(shared.tokenizeText("中文English测试"), true);
  assert.equal(tokens.some(token => token.canBreakAfter), true);
  assert.equal(tokens.at(-1).canBreakAfter, true);
});

test("synthetic Auto Spacing appears only at CJK-Western boundaries", () => {
  const tokens = shared.applySyntheticAutoSpacing(shared.tokenizeText("中文English 123测试"), true);
  assert.equal(tokens.filter(token => token.autoSpaceAfter).length, 2);
  const disabled = shared.applySyntheticAutoSpacing(tokens, false);
  assert.equal(disabled.some(token => token.autoSpaceAfter), false);
});

test("expanded CJK prohibition keeps small kana and closing punctuation off line starts", () => {
  const punctuation = shared.applyBreakRules(shared.tokenizeText("测试？！继续"), true);
  assert.equal(punctuation[1].canBreakAfter, false);
  const kana = shared.applyBreakRules(shared.tokenizeText("あゃ"), true);
  assert.equal(kana[0].canBreakAfter, false);
});

test("forced breaks take precedence over CJK line-start prohibition", () => {
  const tokens = shared.applyBreakRules([
    { text: "", type: "newline", forcedBreakAfter: true },
    { text: "。", type: "punct" }
  ], true);
  assert.equal(tokens[0].canBreakAfter, true);
  assert.equal(tokens[0].forcedBreakAfter, true);
});

test("punctuation profile exposes compression and optical protrusion", () => {
  const profile = shared.punctuationProfile({ text: "。", type: "punct" }, 20, true);
  assert.equal(profile.shrink, 5);
  assert.equal(profile.endProtrusion, 10);
});

test("TeX pattern hyphenator splits an English word deterministically", async () => {
  await import("../hyphenation-en-us.js");
  const hyphenate = shared.createPatternHyphenator(globalThis.TexLineBreakerHyphenationEnUs);
  const parts = hyphenate("hyphenation");
  assert.equal(parts.join(""), "hyphenation");
  assert.ok(parts.length > 1);
  const tokens = shared.hyphenateTokens(shared.applyBreakRules(shared.tokenizeText("hyphenation"), true), hyphenate, true);
  assert.ok(tokens.some(token => token.insert === "-" && token.flagged));
});
