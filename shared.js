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

  const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u;
  const OPENING = new Set(["（", "［", "｛", "〔", "〈", "《", "「", "『", "【", "〖", "〘", "〚", "‘", "“", "｟", "«", "‹", "(", "[", "{", "\"", "'"]);
  const CLOSING = new Set(["，", "。", "、", "；", "：", "！", "？", "）", "］", "｝", "〕", "〉", "》", "」", "』", "】", "〗", "〙", "〛", "’", "”", "｠", "»", "›", "!", "?", ".", ",", ";", ":", "%", "‰", "°", ")", "]", "}", "\"", "'"]);
  const NON_STARTING = new Set([...CLOSING, "…", "—", "～", "~", "・", "·", "ゝ", "ゞ", "々", "ー", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "っ", "ゃ", "ゅ", "ょ", "ゎ", "ァ", "ィ", "ゥ", "ェ", "ォ", "ッ", "ャ", "ュ", "ョ", "ヮ", "ヵ", "ヶ"]);
  const NON_ENDING = new Set([...OPENING, "￥", "$", "£", "€", "¥"]);
  const FULLWIDTH_HANGING_END = new Set(["，", "。", "、", "；", "：", "！", "？"]);
  const HANGING_END = new Set([...FULLWIDTH_HANGING_END, ",", ".", ";", ":", "!", "?", "’", "”", "」", "』", "》", "〉", "）", ")", "]", "}"]);
  const HANGING_START = new Set([...OPENING]);

  function normalizeSettings(stored = {}) {
    const source = stored && typeof stored === "object" ? stored : {};
    const settings = { ...DEFAULTS };
    for (const key of ["globalEnabled", "cjkRules", "punctuationCompression", "hangingPunctuation", "hyphenation"]) {
      if (typeof source[key] === "boolean") settings[key] = source[key];
    }
    const ranges = {
      pretolerance: [0, 10], tolerance: [1, 10], emergencyStretch: [0, 1], maxStretch: [0, 1], maxShrink: [0, 1],
      linePenalty: [0, 100], fitnessDemerits: [0, 50_000], doubleHyphenDemerits: [0, 50_000], finalHyphenDemerits: [0, 50_000],
      shortLastLinePenalty: [0, 50_000], orphanPenalty: [0, 50_000]
    };
    for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
      const value = Number(source[key]);
      if (Number.isFinite(value)) settings[key] = Math.min(maximum, Math.max(minimum, value));
    }
    settings.siteRules = Array.isArray(source.siteRules) ? source.siteRules.map(rule => ({
      domain: normalizeDomain(rule?.domain),
      enabled: rule?.enabled === true
    })).filter(rule => rule.domain) : [];
    return settings;
  }

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
    const matched = (settings.siteRules || []).filter(rule => matchesDomain(host, rule.domain))
      .sort((left, right) => normalizeDomain(right.domain).length - normalizeDomain(left.domain).length)[0];
    return matched ? matched.enabled === true : settings.globalEnabled === true;
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
      const forcedBreakAfter = token.forcedBreakAfter === true;
      let flagged = false;
      let insert = "";
      if (!next) canBreakAfter = true;
      else if (forcedBreakAfter) { canBreakAfter = true; penalty = -10_000; }
      else if (token.type === "space") canBreakAfter = true;
      else if (token.text === "\u00ad") { canBreakAfter = true; penalty = 50; flagged = true; insert = "-"; }
      else if (token.text === "-" || token.text === "‐") { canBreakAfter = true; penalty = 50; flagged = true; }
      else if (token.type === "cjk" || next.type === "cjk") canBreakAfter = true;
      if (!forcedBreakAfter && cjkRules && (NON_ENDING.has(token.text.at(-1)) || NON_STARTING.has(next?.text?.at(0)))) {
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
      const parts = hyphenate(token.text, token);
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
          canBreakAfter: index + 1 < parts.length ? true : token.canBreakAfter,
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

  function punctuationProfile(token, em, compressionEnabled = true, hangingEnabled = true, measured = {}) {
    const first = token?.text?.at(0);
    const last = token?.text?.at(-1);
    if (token?.type !== "punct") return { shrink: 0, beforeShrink: 0, afterShrink: 0, startProtrusion: 0, endProtrusion: 0 };
    const advance = Math.max(0, Number(measured.advance) || 0);
    const leftBearing = Math.max(0, Number(measured.leftBearing) || 0);
    const rightBearing = Math.max(0, Number(measured.rightBearing) || 0);
    const fullwidth = FULLWIDTH_HANGING_END.has(last);
    const beforeFallback = em * (fullwidth ? 0.5 : 0.25);
    const afterFallback = em * 0.25;
    const beforeShrink = compressionEnabled && CLOSING.has(last)
      ? Math.min(advance || beforeFallback, Math.max(leftBearing, beforeFallback))
      : 0;
    const afterShrink = compressionEnabled && OPENING.has(first)
      ? Math.min(advance || afterFallback, Math.max(rightBearing, afterFallback))
      : 0;
    const startFallback = em * 0.5;
    const endFallback = em * (fullwidth ? 0.85 : 0.5);
    let startProtrusion = hangingEnabled && HANGING_START.has(first)
      ? Math.min(advance || startFallback, Math.max(leftBearing, startFallback))
      : 0;
    let endProtrusion = hangingEnabled && HANGING_END.has(last)
      ? Math.min(advance || endFallback, Math.max(rightBearing, endFallback))
      : 0;
    const glyphAdvance = advance || em;
    startProtrusion = Math.min(startProtrusion, Math.max(0, glyphAdvance - afterShrink));
    endProtrusion = Math.min(endProtrusion, Math.max(0, glyphAdvance - beforeShrink));
    return {
      shrink: beforeShrink + afterShrink,
      beforeShrink,
      afterShrink,
      startProtrusion,
      endProtrusion
    };
  }

  function tokenSpacingStyle(adjustment = 0, autoSpace = 0) {
    const spacing = Number(adjustment) + Number(autoSpace);
    return { letterSpacing: Number.isFinite(spacing) && Math.abs(spacing) >= 0.01 ? spacing : 0 };
  }

  function shrinkCapacityForToken(token, width, em, maxShrink, punctuationShrink = 0) {
    const spaceShrink = token?.type === "space" ? Math.max(width * maxShrink, em * 0.04) : 0;
    return spaceShrink + Math.max(0, punctuationShrink);
  }

  function hangingBreakPenalty(penalty, endProtrusion, enabled = true) {
    // This is only a tie-break preference. The WASM core further fades the
    // bonus unless the line is already close to full with little stretching.
    return Number(penalty) - (enabled && Number(endProtrusion) > 0 ? 12 : 0);
  }

  function distributeAdjustment(units, line) {
    const adjustments = new Array(units.length).fill(0);
    if (!Number.isFinite(line?.adjustment) || Math.abs(line.adjustment) < 0.01) return adjustments;
    const capacities = units.map((unit, index) => index + 1 === units.length ? 0 : Math.max(0, line.adjustment >= 0 ? unit.stretch : unit.shrink));
    let total = capacities.reduce((sum, value) => sum + value, 0);
    const emergency = line.adjustment >= 0 ? Math.max(0, line.emergency_stretch || 0) : 0;
    total += emergency;
    if (total <= 0) return adjustments;
    let assigned = 0;
    let lastFlexible = -1;
    capacities.forEach((capacity, index) => {
      if (capacity <= 0) return;
      lastFlexible = index;
      adjustments[index] = line.adjustment * capacity / total;
      assigned += adjustments[index];
    });
    if (emergency > 0) {
      const visible = units.map((unit, index) => unit.visible_units > 0 ? index : -1).filter(index => index >= 0);
      const boundaries = visible.slice(0, -1);
      if (boundaries.length) {
        const emergencyShare = line.adjustment * emergency / total / boundaries.length;
        for (const index of boundaries) { adjustments[index] += emergencyShare; assigned += emergencyShare; lastFlexible = index; }
      }
    }
    if (lastFlexible >= 0) adjustments[lastFlexible] += line.adjustment - assigned;
    return adjustments;
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

  const api = { DEFAULTS, OPENING, CLOSING, HANGING_START, HANGING_END, normalizeSettings, normalizeDomain, matchesDomain, effectiveEnabled, tokenizeText, applyBreakRules, hyphenateTokens, createPatternHyphenator, punctuationProfile, distributeAdjustment, tokenSpacingStyle, shrinkCapacityForToken, hangingBreakPenalty, needsAutoSpaceBetween, applySyntheticAutoSpacing };
  globalThis.TexLineBreakerShared = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
