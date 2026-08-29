import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const shared = require("../shared.js");

test("settings normalization rejects corrupt stored values", () => {
  const settings = shared.normalizeSettings({ tolerance: -5, maxStretch: 99, hyphenation: "yes", siteRules: [{ domain: "https://www.Example.com/path", enabled: true }, null] });
  assert.equal(settings.tolerance, 1);
  assert.equal(settings.maxStretch, 1);
  assert.equal(settings.hyphenation, shared.DEFAULTS.hyphenation);
  assert.deepEqual(settings.siteRules, [{ domain: "example.com", enabled: true }]);
});

test("site rule overrides global setting and matches subdomains", () => {
  const settings = { ...shared.DEFAULTS, globalEnabled: true, siteRules: [{ domain: "example.com", enabled: false }] };
  assert.equal(shared.effectiveEnabled(settings, "www.example.com"), false);
  assert.equal(shared.effectiveEnabled(settings, "other.test"), true);
});

test("the most specific site rule wins", () => {
  const settings = { ...shared.DEFAULTS, siteRules: [{ domain: "example.com", enabled: false }, { domain: "docs.example.com", enabled: true }] };
  assert.equal(shared.effectiveEnabled(settings, "docs.example.com"), true);
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

test("hyphenation preserves the original break after the final part", async () => {
  await import("../hyphenation-en-us.js");
  const hyphenate = shared.createPatternHyphenator(globalThis.TexLineBreakerHyphenationEnUs);
  const source = shared.applyBreakRules(shared.tokenizeText("hyphenation测试"), true);
  const tokens = shared.hyphenateTokens(source, hyphenate, true);
  const lastEnglish = tokens.findLast(token => token.type === "word");
  assert.equal(lastEnglish.canBreakAfter, true);
});

test("supplementary Han characters are classified as CJK", () => {
  const tokens = shared.tokenizeText("𠀀A");
  assert.equal(tokens[0].type, "cjk");
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
  const profile = shared.punctuationProfile({ text: "。", type: "punct" }, 20, true, true);
  assert.equal(profile.shrink, 10);
  assert.equal(profile.beforeShrink, 10);
  assert.equal(profile.afterShrink, 0);
  assert.equal(profile.endProtrusion, 10);
  const opening = shared.punctuationProfile({ text: "（", type: "punct" }, 20, true, true);
  assert.equal(opening.beforeShrink, 0);
  assert.equal(opening.afterShrink, 5);
});

test("hanging punctuation is independent from punctuation compression", () => {
  const profile = shared.punctuationProfile({ text: "，", type: "punct" }, 16, false, true);
  assert.equal(profile.shrink, 0);
  assert.equal(profile.endProtrusion, 8);
});

test("token spacing uses selectable padding for expansion and margin for compression", () => {
  assert.deepEqual(shared.tokenSpacingStyle(2, 1), { paddingInlineEnd: 3, marginInlineEnd: 0 });
  assert.deepEqual(shared.tokenSpacingStyle(-2, 0), { paddingInlineEnd: 0, marginInlineEnd: -2 });
  assert.deepEqual(shared.tokenSpacingStyle(0, 0), { paddingInlineEnd: 0, marginInlineEnd: 0 });
});

test("ordinary CJK glyphs never expose shrink capacity", () => {
  assert.equal(shared.shrinkCapacityForToken({ type: "cjk" }, 16, 16, 0.5, 0), 0);
  assert.equal(shared.shrinkCapacityForToken({ type: "cjk" }, 16, 16, 0.5, 4), 4);
  assert.equal(shared.shrinkCapacityForToken({ type: "space" }, 8, 16, 0.25, 0), 2);
});

test("a legal hanging punctuation break receives priority", () => {
  assert.equal(shared.hangingBreakPenalty(0, 8, true), -50);
  assert.equal(shared.hangingBreakPenalty(0, 0, true), 0);
  assert.equal(shared.hangingBreakPenalty(25, 8, false), 25);
});

test("line adjustment is conserved and never placed after the final unit", () => {
  const units = [{ stretch: 10, shrink: 4, visible_units: 1 }, { stretch: 20, shrink: 8, visible_units: 1 }, { stretch: 100, shrink: 100, visible_units: 1 }];
  const stretch = shared.distributeAdjustment(units, { adjustment: 15, emergency_stretch: 0 });
  assert.ok(Math.abs(stretch.reduce((sum, value) => sum + value, 0) - 15) < 1e-9);
  assert.equal(stretch.at(-1), 0);
  const shrink = shared.distributeAdjustment(units, { adjustment: -6, emergency_stretch: 0 });
  assert.ok(Math.abs(shrink.reduce((sum, value) => sum + value, 0) + 6) < 1e-9);
});

test("emergency stretch is distributed only between visible boxes", () => {
  const units = [{ stretch: 0, shrink: 0, visible_units: 1 }, { stretch: 0, shrink: 0, visible_units: 1 }, { stretch: 0, shrink: 0, visible_units: 1 }];
  const values = shared.distributeAdjustment(units, { adjustment: 12, emergency_stretch: 12 });
  assert.deepEqual(values, [6, 6, 0]);
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
