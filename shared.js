(() => {
  "use strict";

  const DEFAULTS = Object.freeze({
    globalEnabled: false,
    pretolerance: 1,
    tolerance: 3,
    emergencyStretch: 0.18,
    maxStretch: 0.35,
    maxShrink: 0.18,
    cjkRules: true,
    punctuationCompression: true,
    hangingPunctuation: true,
    hyphenation: true,
    linePenalty: 10,
    fitnessDemerits: 3000,
    doubleHyphenDemerits: 10000,
    finalHyphenDemerits: 5000,
    shortLastLinePenalty: 2500,
    orphanPenalty: 5000,
    siteRules: []
  });

  const CJK_RE = /[\u2e80-\u2fff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const OPENING = new Set(["（", "［", "｛", "〔", "〈", "《", "「", "『", "【", "〖", "〘", "〚", "‘", "“", "｟", "«", "‹", "(", "[", "{", "\"", "'"]);
  const CLOSING = new Set(["，", "。", "、", "；", "：", "！", "？", "）", "］", "｝", "〕", "〉", "》", "」", "』", "】", "〗", "〙", "〛", "’", "”", "｠", "»", "›", "!", "?", ".", ",", ";", ":", "%", "‰", "°", ")", "]", "}", "\"", "'"]);
  const NON_STARTING = new Set([...CLOSING, "…", "—", "～", "~", "・", "·", "ゝ", "ゞ", "々", "ー", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "っ", "ゃ", "ゅ", "ょ", "ゎ", "ァ", "ィ", "ゥ", "ェ", "ォ", "ッ", "ャ", "ュ", "ョ", "ヮ", "ヵ", "ヶ"]);
  const NON_ENDING = new Set([...OPENING, "￥", "$", "£", "€", "¥"]);
  const HANGING_END = new Set(["，", "。", "、", "；", "：", "！", "？", ",", ".", ";", ":", "!", "?", "’", "”", "」", "』", "》", "〉", "）", ")", "]", "}"]);
  const HANGING_START = new Set([...OPENING]);

  function normalizeDomain(value) {
    return String(value || "").trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/^\*\./, "").replace(/^www\./, "")
      .split("/")[0].split(":")[0];
  }

  function matchesDomain(host, ruleDomain) {
    const domain = normalizeDomain(ruleDomain);
    const normalizedHost = String(host || "").toLowerCase().replace(/^www\./, "");
    return Boolean(domain) && (normalizedHost === domain || normalizedHost.endsWith(`.${domain}`));
  }

  function effectiveEnabled(settings, host) {
    const matched = (settings.siteRules || []).find(rule => matchesDomain(host, rule.domain));
    return matched ? matched.enabled === true : settings.globalEnabled === true;
  }

  function classify(text) {
    if (/^\s+$/u.test(text)) return "space";
    if (CJK_RE.test(text)) return "cjk";
    if (/^[\p{L}\p{N}_]+$/u.test(text)) return "word";
    return "punct";
  }

  function tokenizeText(text) {
    const tokens = [];
    let buffer = "";
    let bufferType = "";
    let bufferStart = 0;
    let offset = 0;
    const flush = () => {
      if (buffer) tokens.push({ text: buffer, type: bufferType, start: bufferStart, end: offset });
      buffer = "";
      bufferType = "";
    };
    for (const char of text) {
      const type = /^\s$/u.test(char) ? "space" : CJK_RE.test(char) ? "cjk" : /^[\p{L}\p{N}_]$/u.test(char) ? "word" : "punct";
      if (type === "cjk" || type === "punct" || type === "newline") {
        flush();
        tokens.push({ text: char, type, start: offset, end: offset + char.length });
      } else if (bufferType === type || !buffer) {
        if (!buffer) bufferStart = offset;
        buffer += char;
        bufferType = type;
      } else {
        flush();
        bufferStart = offset;
        buffer = char;
        bufferType = type;
      }
      offset += char.length;
    }
    flush();
    return tokens;
  }

  function applyBreakRules(tokens, cjkRules = true) {
    return tokens.map((token, index) => {
      const next = tokens[index + 1];
      let canBreakAfter = false;
      let penalty = 0;
      let forcedBreakAfter = token.forcedBreakAfter === true;
      let flagged = false;
      let insert = "";
      if (!next) canBreakAfter = true;
      else if (forcedBreakAfter) { canBreakAfter = true; penalty = -10_000; }
      else if (token.type === "space") canBreakAfter = true;
      else if (token.text === "\u00ad") { canBreakAfter = true; penalty = 50; flagged = true; insert = "-"; }
      else if (token.text === "-" || token.text === "‐") { canBreakAfter = true; penalty = 50; flagged = true; }
      else if (token.type === "cjk" || next.type === "cjk") canBreakAfter = true;
      if (cjkRules && (NON_ENDING.has(token.text.at(-1)) || NON_STARTING.has(next?.text?.at(0)))) {
        canBreakAfter = false;
        penalty = 10_000;
      }
      return { ...token, canBreakAfter, forcedBreakAfter, penalty, flagged, insert };
    });
  }

  function hyphenateTokens(tokens, hyphenate, enabled = true) {
    if (!enabled || typeof hyphenate !== "function") return tokens;
    const result = [];
    for (const token of tokens) {
      if (token.type !== "word" || !/^[A-Za-z]{6,}$/u.test(token.text)) {
        result.push(token);
        continue;
      }
      const parts = hyphenate(token.text);
      if (!Array.isArray(parts) || parts.length < 2 || parts.join("") !== token.text) {
        result.push(token);
        continue;
      }
      let offset = token.start;
      parts.forEach((part, index) => {
        result.push({
          ...token,
          text: part,
          start: offset,
          end: offset + part.length,
          canBreakAfter: index + 1 < parts.length,
          forcedBreakAfter: false,
          penalty: index + 1 < parts.length ? 50 : token.penalty,
          flagged: index + 1 < parts.length,
          insert: index + 1 < parts.length ? "-" : ""
        });
        offset += part.length;
      });
    }
    return result;
  }

  function createPatternHyphenator(language) {
    if (!language?.patterns) return () => [];
    const trie = { points: [], children: new Map() };
    for (const [length, packed] of Object.entries(language.patterns)) {
      const size = Number(length);
      for (let offset = 0; offset < packed.length; offset += size) {
        const pattern = packed.slice(offset, offset + size);
        const letters = pattern.replace(/\d/g, "");
        const points = [0];
        let point = 0;
        for (const char of pattern) {
          if (/\d/.test(char)) point = Number(char);
          else { points[points.length - 1] = point; points.push(0); point = 0; }
        }
        let node = trie;
        for (const char of letters) {
          if (!node.children.has(char)) node.children.set(char, { points: [], children: new Map() });
          node = node.children.get(char);
        }
        node.points = points;
      }
    }
    const exceptions = new Map();
    for (const exception of String(language.exceptions || "").split(/,\s*/u).filter(Boolean)) {
      exceptions.set(exception.replace(/‧/gu, "").toLowerCase(), exception.split("‧"));
    }
    return word => {
      const exception = exceptions.get(word.toLowerCase());
      if (exception) return exception;
      const prepared = `_${word.toLowerCase()}_`;
      const points = new Array(prepared.length + 1).fill(0);
      for (let start = 0; start < prepared.length; start++) {
        let node = trie;
        for (let end = start; end < prepared.length; end++) {
          node = node.children.get(prepared[end]);
          if (!node) break;
          node.points.forEach((value, index) => { points[start + index] = Math.max(points[start + index], value); });
        }
      }
      const leftMin = Number(language.leftmin) || 2;
      const rightMin = Number(language.rightmin) || 3;
      const breaks = [];
      for (let index = leftMin; index <= word.length - rightMin; index++) {
        if (points[index + 1] % 2 === 1) breaks.push(index);
      }
      if (!breaks.length) return [word];
      const parts = [];
      let previous = 0;
      for (const index of breaks) { parts.push(word.slice(previous, index)); previous = index; }
      parts.push(word.slice(previous));
      return parts;
    };
  }

  function punctuationProfile(token, em, enabled = true) {
    const first = token?.text?.at(0);
    const last = token?.text?.at(-1);
    if (!enabled || token?.type !== "punct") return { shrink: 0, startProtrusion: 0, endProtrusion: 0 };
    return {
      shrink: (OPENING.has(first) || CLOSING.has(last)) ? em * 0.25 : 0,
      startProtrusion: HANGING_START.has(first) ? em * 0.5 : 0,
      endProtrusion: HANGING_END.has(last) ? em * 0.5 : 0
    };
  }

  function needsAutoSpaceBetween(left, right) {
    if (!left || !right || left.type === "space" || right.type === "space") return false;
    const leftWestern = left.type === "word";
    const rightWestern = right.type === "word";
    return (left.type === "cjk" && rightWestern) || (leftWestern && right.type === "cjk");
  }

  function applySyntheticAutoSpacing(tokens, enabled = true) {
    return tokens.map((token, index) => ({
      ...token,
      autoSpaceAfter: enabled && needsAutoSpaceBetween(token, tokens[index + 1])
    }));
  }

  const api = { DEFAULTS, OPENING, CLOSING, HANGING_START, HANGING_END, normalizeDomain, matchesDomain, effectiveEnabled, tokenizeText, applyBreakRules, hyphenateTokens, createPatternHyphenator, punctuationProfile, needsAutoSpaceBetween, applySyntheticAutoSpacing };
  globalThis.TexLineBreakerShared = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
