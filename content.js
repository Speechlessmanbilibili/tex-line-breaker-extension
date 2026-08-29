(() => {
  "use strict";
  const { DEFAULTS, normalizeSettings, effectiveEnabled, tokenizeText, applyBreakRules, hyphenateTokens, createPatternHyphenator, punctuationProfile, distributeAdjustment, tokenSpacingStyle, shrinkCapacityForToken, hangingBreakPenalty, applySyntheticAutoSpacing } = globalThis.TexLineBreakerShared;
  const BLOCK_SELECTOR = "p, blockquote, article p, div";
  const COMPLEX_SELECTOR = "code, pre, kbd, samp, table, img, video, audio, canvas, svg, iframe, input, textarea, select, button, math";
  const INLINE_TAGS = new Set(["A", "ABBR", "B", "BR", "CITE", "DEL", "EM", "I", "INS", "MARK", "Q", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U"]);
  const MAX_CHARS = 8000;
  const MAX_UNITS = 1600;
  const SUPPORTED_INLINE_DISPLAY = new Set(["inline", "contents"]);
  const TYPOGRAPHY_PROPERTIES = ["direction", "font-family", "font-feature-settings", "font-kerning", "font-optical-sizing", "font-size", "font-stretch", "font-style", "font-variation-settings", "font-weight", "letter-spacing", "margin-left", "margin-right", "padding-left", "padding-right", "border-left-style", "border-left-width", "border-right-style", "border-right-width", "text-autospace", "text-rendering", "text-transform", "vertical-align", "word-spacing"];
  const originals = new WeakMap();
  const rendered = new Set();
  const observedWidths = new WeakMap();
  const overflowOverrides = new Map();
  let settings = { ...DEFAULTS };
  let wasm = null;
  let startupError = "";
  let observer = null;
  let resizeObserver = null;
  let muting = false;
  let scanTimer = 0;
  const pendingRoots = new Set();
  const hyphenateEnglish = createPatternHyphenator(globalThis.TexLineBreakerHyphenationEnUs);

  document.documentElement.dataset.kpExtensionState = "loading";

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "kp-status") {
      return Promise.resolve({
        ok: Boolean(wasm),
        state: wasm ? "ready" : startupError ? "error" : "loading",
        error: startupError,
        enabled: effectiveEnabled(settings, location.hostname),
        rendered: rendered.size
      });
    }
    if (message?.type === "kp-rerender") {
      if (!wasm) return Promise.resolve({ ok: false, error: startupError || "排版核心仍在加载" });
      restoreAll();
      scheduleScan(document);
      return Promise.resolve({ ok: true });
    }
    if (message?.type === "kp-restore") {
      restoreAll();
      return Promise.resolve({ ok: true });
    }
    return false;
  });

  async function loadWasm() {
    const url = chrome.runtime.getURL("wasm/tex_line_breaker_core.wasm");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Unable to load WASM: ${response.status}`);
    const bytes = await response.arrayBuffer();
    wasm = (await WebAssembly.instantiate(bytes, {})).instance.exports;
    for (const name of ["memory", "alloc", "dealloc", "layout"]) {
      if (!wasm[name]) throw new Error(`Missing WASM export: ${name}`);
    }
  }

  function callLayout(input) {
    if (!wasm) throw new Error("WASM core is not ready");
    const encoded = new TextEncoder().encode(JSON.stringify(input));
    const inputPtr = wasm.alloc(encoded.length);
    let packed;
    try {
      new Uint8Array(wasm.memory.buffer, inputPtr, encoded.length).set(encoded);
      packed = wasm.layout(inputPtr, encoded.length);
    } finally {
      wasm.dealloc(inputPtr, encoded.length);
    }
    if (packed === 0n) throw new Error("WASM layout failed");
    const outputPtr = Number(packed >> 32n);
    const outputLen = Number(packed & 0xffffffffn);
    try {
      const json = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, outputPtr, outputLen));
      return JSON.parse(json);
    } finally {
      wasm.dealloc(outputPtr, outputLen);
    }
  }

  function simpleInlineTree(root) {
    for (const pseudo of ["::before", "::after"]) {
      const content = getComputedStyle(root, pseudo).content;
      if (content && content !== "none" && content !== "normal") return false;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.matches(COMPLEX_SELECTOR)) return false;
      if (node !== root && !INLINE_TAGS.has(node.tagName)) return false;
      if (node !== root && node.tagName !== "BR") {
        const style = getComputedStyle(node);
        if (!SUPPORTED_INLINE_DISPLAY.has(style.display)) return false;
        if (style.position === "absolute" || style.position === "fixed" || style.position === "sticky" || style.float !== "none") return false;
        if (style.direction === "rtl" || style.whiteSpace.includes("nowrap") || style.whiteSpace.includes("pre")) return false;
      }
      for (const pseudo of ["::before", "::after"]) {
        const content = getComputedStyle(node, pseudo).content;
        if (content && content !== "none" && content !== "normal") return false;
      }
    }
    return true;
  }

  function eligible(el) {
    if (!(el instanceof HTMLElement) || el.dataset.kpRendered === "1") return false;
    if (el.closest("[contenteditable]:not([contenteditable='false']), code, pre, kbd, samp, table")) return false;
    if (el.matches(COMPLEX_SELECTOR) || el.querySelector(COMPLEX_SELECTOR)) return false;
    if (!simpleInlineTree(el)) return false;
    const text = el.textContent?.trim() || "";
    if (text.length < 24 || text.length > MAX_CHARS) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "flex" || cs.display === "grid" || cs.display === "inline-flex" || cs.display === "inline-grid") return false;
    if (cs.whiteSpace.includes("nowrap") || cs.writingMode !== "horizontal-tb") return false;
    if (cs.direction === "rtl") return false;
    if (!new Set(["start", "left", "justify"]).has(cs.textAlign)) return false;
    if (Number.parseFloat(cs.textIndent) < 0) return false;
    if (el.clientWidth < 80) return false;
    if (el.tagName === "DIV" && el.children.length > 0 && Array.from(el.children).some(child => !INLINE_TAGS.has(child.tagName))) return false;
    return true;
  }

  function wrappersFor(textNode, root) {
    const wrappers = [];
    let current = textNode.parentElement;
    while (current && current !== root) {
      wrappers.unshift(current);
      current = current.parentElement;
    }
    return wrappers;
  }

  function collectTokens(root) {
    const tokens = [];
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue?.length) {
        const wrappers = wrappersFor(node, root);
        for (const token of tokenizeText(node.nodeValue)) tokens.push({ ...token, wrappers, sourceNode: node });
        return;
      }
      if (node instanceof HTMLBRElement) {
        tokens.push({ text: "", type: "newline", start: 0, end: 0, wrappers: wrappersFor(node, root), sourceNode: null, virtual: true, forcedBreakAfter: true });
        return;
      }
      for (const child of node.childNodes || []) visit(child);
    }
    visit(root);
    const hyphenateForContext = (word, token) => {
      const owner = token.sourceNode?.parentElement?.closest?.("[lang]") || root.closest("[lang]") || document.documentElement;
      const language = String(owner?.getAttribute?.("lang") || "").toLowerCase();
      return !language || /^en(-|$)/u.test(language) ? hyphenateEnglish(word) : [word];
    };
    return hyphenateTokens(applyBreakRules(tokens, settings.cjkRules), hyphenateForContext, settings.hyphenation);
  }

  function textAutospaceActive(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return Boolean(normalized) && normalized !== "none" && normalized !== "no-autospace";
  }

  function ensureOriginal(el) {
    if (!originals.has(el)) {
      originals.set(el, {
        nodes: Array.from(el.childNodes),
        textAutospaceValue: el.style.getPropertyValue("text-autospace"),
        textAutospacePriority: el.style.getPropertyPriority("text-autospace"),
        textIndentValue: el.style.getPropertyValue("text-indent"),
        textIndentPriority: el.style.getPropertyPriority("text-indent")
      });
    }
  }

  function prepareAutoSpacing(el) {
    if (textAutospaceActive(getComputedStyle(el).textAutospace)) {
      el.dataset.kpAutospace = "existing";
      return false;
    }
    if (globalThis.CSS?.supports?.("text-autospace", "normal")) {
      el.style.setProperty("text-autospace", "normal", "important");
      if (textAutospaceActive(getComputedStyle(el).textAutospace)) {
        el.dataset.kpAutospace = "injected";
        return false;
      }
    }
    el.dataset.kpAutospace = "synthetic";
    return true;
  }

  function measure(root, tokens) {
    const box = root.cloneNode(true);
    const rootStyle = getComputedStyle(root);
    box.removeAttribute("id");
    for (const descendant of box.querySelectorAll("[id]")) descendant.removeAttribute("id");
    for (const br of box.querySelectorAll("br")) br.style.setProperty("display", "none", "important");
    box.dataset.kpMeasure = "1";
    box.style.setProperty("position", "fixed", "important");
    box.style.setProperty("left", "-100000px", "important");
    box.style.setProperty("top", "0", "important");
    box.style.setProperty("visibility", "hidden", "important");
    box.style.setProperty("white-space", "nowrap", "important");
    box.style.setProperty("width", "max-content", "important");
    box.style.setProperty("max-width", "none", "important");
    box.style.setProperty("min-width", "0", "important");
    box.style.setProperty("contain", "layout style", "important");
    const sourceElements = [root, ...root.querySelectorAll("*")];
    const clonedElements = [box, ...box.querySelectorAll("*")];
    sourceElements.forEach((source, index) => {
      const clone = clonedElements[index];
      if (!clone) return;
      const style = getComputedStyle(source);
      for (const property of TYPOGRAPHY_PROPERTIES) clone.style.setProperty(property, style.getPropertyValue(property), "important");
    });
    muting = true;
    document.documentElement.appendChild(box);
    const sourceTextNodes = [];
    const clonedTextNodes = [];
    const sourceWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const cloneWalker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let sourceNode;
    while ((sourceNode = sourceWalker.nextNode())) sourceTextNodes.push(sourceNode);
    let clonedNode;
    while ((clonedNode = cloneWalker.nextNode())) clonedTextNodes.push(clonedNode);
    const cloneBySource = new Map(sourceTextNodes.map((node, index) => [node, clonedTextNodes[index]]));
    const widths = [];
    let previous = 0;
    try {
      for (const token of tokens) {
        if (token.virtual) { widths.push(0); continue; }
        const cloneNode = cloneBySource.get(token.sourceNode);
        if (!cloneNode) throw new Error("Unable to map measurement text node");
        const range = document.createRange();
        range.setStart(box, 0);
        range.setEnd(cloneNode, token.end);
        const current = range.getBoundingClientRect().width;
        widths.push(Math.max(0, current - previous));
        previous = current;
      }
    } finally {
      box.remove();
      muting = false;
    }
    const em = Number.parseFloat(rootStyle.fontSize) || 16;
    const syntheticSpacing = em * 0.125;
    const hyphenWidth = measureInsertedGlyph(root, "-");
    const measurePunctuation = createPunctuationMeasurer(root);
    const profiles = tokens.map((token, index) => punctuationProfile(
      token,
      em,
      settings.punctuationCompression,
      settings.hangingPunctuation,
      measurePunctuation(token, widths[index])
    ));
    return widths.map((width, index) => {
      const token = tokens[index];
      const punctuation = profiles[index];
      const boundaryShrink = punctuation.afterShrink + (profiles[index + 1]?.beforeShrink || 0);
      const punctuationShrink = Math.min(boundaryShrink, Math.max(width, widths[index + 1] || 0) * 0.5);
      const startProtrusion = Math.min(punctuation.startProtrusion, width);
      const endProtrusion = Math.min(punctuation.endProtrusion, width);
      const normalStretch = token.type === "space" ? Math.max(width * settings.maxStretch, em * 0.08) : (token.type === "cjk" ? em * settings.maxStretch : 0);
      return {
        width: width + (token.autoSpaceAfter ? syntheticSpacing : 0),
        can_break_after: token.canBreakAfter,
        forced_break_after: token.forcedBreakAfter,
        // Prefer the legal break after a hanging closing mark. When the mark
        // fits through punctuation compression plus protrusion, keep it on the
        // current line instead of moving the preceding ideograph with it.
        penalty: hangingBreakPenalty(token.penalty, endProtrusion, settings.hangingPunctuation),
        flagged: token.flagged,
        discretionary: Boolean(token.insert),
        discard_at_break: token.type === "space" || token.type === "newline",
        discard_width_at_break: token.autoSpaceAfter ? syntheticSpacing : 0,
        insert_width_at_break: token.insert ? hyphenWidth : 0,
        stretch: normalStretch,
        shrink: shrinkCapacityForToken(token, width, em, settings.maxShrink, punctuationShrink),
        start_protrusion: startProtrusion,
        end_protrusion: endProtrusion,
        visible_units: token.type === "space" || token.type === "newline" || token.text === "\u00ad" ? 0 : Array.from(token.text).length
      };
    });
  }

  function measureInsertedGlyph(root, text) {
    const span = document.createElement("span");
    const style = getComputedStyle(root);
    span.textContent = text;
    span.style.cssText = `position:fixed;left:-100000px;top:0;visibility:hidden;white-space:nowrap;font:${style.font};font-kerning:${style.fontKerning};font-feature-settings:${style.fontFeatureSettings};letter-spacing:${style.letterSpacing}`;
    muting = true;
    document.documentElement.appendChild(span);
    try { return span.getBoundingClientRect().width; }
    finally { span.remove(); muting = false; }
  }

  function createPunctuationMeasurer(root) {
    const context = document.createElement("canvas").getContext("2d");
    const cache = new Map();
    return (token, advance) => {
      if (!context || token?.type !== "punct" || !token.text) return {};
      const owner = token.sourceNode?.parentElement || root;
      const style = getComputedStyle(owner);
      const font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const key = `${font}\u0000${style.fontKerning}\u0000${token.text}`;
      let ink = cache.get(key);
      if (!ink) {
        context.font = font;
        context.direction = style.direction === "rtl" ? "rtl" : "ltr";
        if ("fontKerning" in context) context.fontKerning = style.fontKerning;
        if ("fontStretch" in context) context.fontStretch = style.fontStretch;
        const metrics = context.measureText(token.text);
        const measuredAdvance = Number(metrics.width) || advance;
        ink = {
          measuredAdvance,
          leftBearing: Number.isFinite(metrics.actualBoundingBoxLeft) ? Math.max(0, -metrics.actualBoundingBoxLeft) : 0,
          rightBearing: Number.isFinite(metrics.actualBoundingBoxRight) ? Math.max(0, measuredAdvance - metrics.actualBoundingBoxRight) : 0
        };
        cache.set(key, ink);
      }
      return { advance: Math.max(advance, ink.measuredAdvance), leftBearing: ink.leftBearing, rightBearing: ink.rightBearing };
    };
  }

  function appendToken(lineEl, token, state) {
    if (token.type === "newline") return null;
    const visibleText = token.text === "\u00ad" ? "" : token.text;
    const samePath = state.path?.length === token.wrappers.length && token.wrappers.every((wrapper, index) => wrapper === state.path[index]);
    if (!samePath || !state.leaf) {
      let parent = lineEl;
      for (const original of token.wrappers) {
        const wrapper = original.cloneNode(false);
        parent.appendChild(wrapper);
        parent = wrapper;
      }
      state.path = token.wrappers;
      state.leaf = parent;
    }
    const tokenEl = document.createElement("span");
    tokenEl.dataset.kpToken = "1";
    tokenEl.style.display = "inline";
    tokenEl.appendChild(document.createTextNode(visibleText));
    state.leaf.appendChild(tokenEl);
    return tokenEl;
  }

  function applyTokenSpacing(tokenEl, adjustment, autoSpace) {
    if (!tokenEl) return;
    const spacing = tokenSpacingStyle(adjustment, autoSpace);
    if (!spacing.letterSpacing) return;
    const textNode = Array.from(tokenEl.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.nodeValue);
    if (!textNode) return;
    const characters = Array.from(textNode.nodeValue);
    const finalCharacter = characters.pop();
    if (!finalCharacter) return;
    const boundary = document.createElement("span");
    boundary.dataset.kpLetterSpacing = "1";
    boundary.style.letterSpacing = `${spacing.letterSpacing}px`;
    boundary.textContent = finalCharacter;
    if (characters.length) textNode.replaceWith(document.createTextNode(characters.join("")), boundary);
    else textNode.replaceWith(boundary);
  }

  function restoreInlineProperty(element, property, value, priority) {
    if (value) element.style.setProperty(property, value, priority);
    else element.style.removeProperty(property);
  }

  function allowHangingOverflow(el) {
    let ancestor = el.parentElement;
    let depth = 0;
    while (ancestor && ancestor !== document.documentElement && depth < 10) {
      const style = getComputedStyle(ancestor);
      if (style.overflowX === "hidden" || style.overflowX === "clip") {
        let override = overflowOverrides.get(ancestor);
        if (!override) {
          override = {
            roots: new Set(),
            overflowValue: ancestor.style.getPropertyValue("overflow"),
            overflowPriority: ancestor.style.getPropertyPriority("overflow"),
            overflowXValue: ancestor.style.getPropertyValue("overflow-x"),
            overflowXPriority: ancestor.style.getPropertyPriority("overflow-x"),
            overflowYValue: ancestor.style.getPropertyValue("overflow-y"),
            overflowYPriority: ancestor.style.getPropertyPriority("overflow-y")
          };
          overflowOverrides.set(ancestor, override);
          ancestor.dataset.kpOverflow = "1";
          // A positioned/z-indexed child still cannot escape an ancestor's
          // overflow clip. Override the clipping container itself, with enough
          // priority to beat site styles, only while it owns rendered content.
          ancestor.style.setProperty("overflow", "visible", "important");
          ancestor.style.setProperty("overflow-x", "visible", "important");
          ancestor.style.setProperty("overflow-y", "visible", "important");
        }
        override.roots.add(el);
      }
      ancestor = ancestor.parentElement;
      depth += 1;
    }
  }

  function releaseHangingOverflow(el) {
    for (const [ancestor, override] of overflowOverrides) {
      override.roots.delete(el);
      if (override.roots.size) continue;
      restoreInlineProperty(ancestor, "overflow", override.overflowValue, override.overflowPriority);
      restoreInlineProperty(ancestor, "overflow-x", override.overflowXValue, override.overflowXPriority);
      restoreInlineProperty(ancestor, "overflow-y", override.overflowYValue, override.overflowYPriority);
      delete ancestor.dataset.kpOverflow;
      overflowOverrides.delete(ancestor);
    }
  }

  function restore(el) {
    const original = originals.get(el);
    if (!original) return;
    muting = true;
    releaseHangingOverflow(el);
    el.replaceChildren(...original.nodes);
    if (original.textAutospaceValue) {
      el.style.setProperty("text-autospace", original.textAutospaceValue, original.textAutospacePriority);
    } else {
      el.style.removeProperty("text-autospace");
    }
    if (original.textIndentValue) {
      el.style.setProperty("text-indent", original.textIndentValue, original.textIndentPriority);
    } else {
      el.style.removeProperty("text-indent");
    }
    delete el.dataset.kpRendered;
    delete el.dataset.kpAutospace;
    el.style.removeProperty("--kp-line-ratio");
    originals.delete(el);
    rendered.delete(el);
    resizeObserver?.unobserve(el);
    observedWidths.delete(el);
    queueMicrotask(() => { muting = false; });
  }

  function release(el) {
    releaseHangingOverflow(el);
    rendered.delete(el);
    resizeObserver?.unobserve(el);
    observedWidths.delete(el);
  }

  function cleanGeneratedContent(root) {
    for (const boundary of Array.from(root.querySelectorAll("[data-kp-letter-spacing]")).reverse()) boundary.replaceWith(...Array.from(boundary.childNodes));
    for (const generated of root.querySelectorAll("[data-kp-adjustment], [data-kp-autospace-spacer], [data-kp-discretionary], [data-kp-placeholder]")) generated.remove();
    for (const token of Array.from(root.querySelectorAll("[data-kp-token]")).reverse()) token.replaceWith(...Array.from(token.childNodes));
    for (const element of root.querySelectorAll("[data-kp-line], [data-kp-rendered], [data-kp-autospace]")) {
      delete element.dataset.kpLine;
      delete element.dataset.kpRendered;
      delete element.dataset.kpAutospace;
    }
  }

  function adoptRenderedContent(el) {
    const previous = originals.get(el);
    if (!previous) return;
    const fragment = document.createDocumentFragment();
    for (const child of Array.from(el.childNodes)) {
      if (child instanceof HTMLElement && child.dataset.kpLine) {
        const clone = child.cloneNode(true);
        cleanGeneratedContent(clone);
        fragment.append(...Array.from(clone.childNodes));
      } else {
        const clone = child.cloneNode(true);
        if (clone instanceof Element) cleanGeneratedContent(clone);
        fragment.appendChild(clone);
      }
    }
    originals.set(el, {
      ...previous,
      nodes: Array.from(fragment.childNodes)
    });
  }

  function releaseRemovedTree(node) {
    if (!(node instanceof Element)) return;
    if (rendered.has(node)) release(node);
    for (const el of node.querySelectorAll("[data-kp-rendered='1']")) release(el);
  }

  function render(el, tokens, units, result, firstLineIndent, alignment) {
    if (!result.lines?.length) return;
    ensureOriginal(el);
    const fragment = document.createDocumentFragment();
    result.lines.forEach((line, lineIndex) => {
      const lineEl = document.createElement("span");
      lineEl.dataset.kpLine = String(lineIndex + 1);
      lineEl.style.display = "block";
      lineEl.style.textIndent = lineIndex === 0 ? `${firstLineIndent}px` : "0px";
      lineEl.style.boxSizing = "content-box";
      lineEl.style.width = `calc(100% + ${line.start_protrusion + line.end_protrusion}px)`;
      lineEl.style.marginInlineStart = `${-line.start_protrusion}px`;
      lineEl.style.whiteSpace = "nowrap";
      lineEl.style.wordBreak = "normal";
      lineEl.style.overflowWrap = "normal";
      lineEl.style.textAlign = alignment.textAlign;
      lineEl.style.textAlignLast = alignment.textAlignLast;
      lineEl.style.setProperty("--kp-line-ratio", String(line.ratio));
      const state = { path: null, leaf: null };
      const lineUnits = units.slice(line.start, line.end);
      const adjustments = alignment.adjustSpacing ? distributeAdjustment(lineUnits, line) : new Array(lineUnits.length).fill(0);
      for (let index = line.start; index < line.end; index++) {
        const tokenEl = appendToken(lineEl, tokens[index], state);
        const autoSpace = tokens[index].autoSpaceAfter && index + 1 < line.end ? (Number.parseFloat(getComputedStyle(el).fontSize) || 16) * 0.125 : 0;
        applyTokenSpacing(tokenEl, adjustments[index - line.start], autoSpace);
      }
      if (line.flagged && tokens[line.end - 1]?.insert) {
        const hyphen = document.createElement("span");
        hyphen.dataset.kpDiscretionary = "1";
        hyphen.textContent = tokens[line.end - 1].insert;
        (state.leaf || lineEl).appendChild(hyphen);
      }
      if (line.forced && !lineUnits.some(unit => unit.visible_units > 0)) {
        const placeholder = document.createElement("br");
        placeholder.dataset.kpPlaceholder = "1";
        placeholder.setAttribute("aria-hidden", "true");
        lineEl.appendChild(placeholder);
      }
      fragment.appendChild(lineEl);
    });
    muting = true;
    if (settings.hangingPunctuation && result.lines.some(line => line.start_protrusion > 0 || line.end_protrusion > 0)) allowHangingOverflow(el);
    el.replaceChildren(fragment);
    el.style.textIndent = "0px";
    el.dataset.kpRendered = "1";
    rendered.add(el);
    queueMicrotask(() => { muting = false; });
  }

  function layoutElement(el) {
    try {
      if (el.dataset.kpRendered === "1") restore(el);
      if (!eligible(el)) return;
      ensureOriginal(el);
      const syntheticAutoSpacing = prepareAutoSpacing(el);
      const tokens = applySyntheticAutoSpacing(collectTokens(el), syntheticAutoSpacing);
      if (tokens.length < 2 || tokens.length > MAX_UNITS) { restore(el); return; }
      const units = measure(el, tokens);
      const cs = getComputedStyle(el);
      const textAlign = cs.textAlign || "start";
      const textAlignLast = cs.textAlignLast && cs.textAlignLast !== "auto" ? cs.textAlignLast : textAlign;
      const adjustSpacing = textAlign === "justify" || textAlign === "start" || textAlign === "left";
      const lineWidth = el.clientWidth - (Number.parseFloat(cs.paddingLeft) || 0) - (Number.parseFloat(cs.paddingRight) || 0);
      const firstLineIndent = Math.max(0, Number.parseFloat(cs.textIndent) || 0);
      const result = callLayout({
        units,
        line_width: Math.max(1, lineWidth - 0.5),
        first_line_indent: firstLineIndent,
        pretolerance: settings.pretolerance,
        tolerance: settings.tolerance,
        emergency_stretch: (Number.parseFloat(cs.fontSize) || 16) * settings.emergencyStretch,
        line_penalty: settings.linePenalty,
        fitness_demerits: settings.fitnessDemerits,
        double_hyphen_demerits: settings.doubleHyphenDemerits,
        final_hyphen_demerits: settings.finalHyphenDemerits,
        short_last_line_penalty: settings.shortLastLinePenalty,
        orphan_penalty: settings.orphanPenalty
      });
      if (result.fallback) { restore(el); return; }
      render(el, tokens, units, result, firstLineIndent, { textAlign, textAlignLast, adjustSpacing });
      if (Array.from(el.querySelectorAll(":scope > [data-kp-line]")).some(line => line.scrollWidth > line.getBoundingClientRect().width + 1)) {
        restore(el);
        return;
      }
      observedWidths.set(el, el.clientWidth);
      resizeObserver.observe(el);
    } catch (error) {
      restore(el);
      console.debug("[TeX Line Breaker] native layout retained", error);
    }
  }

  function scan(root = document) {
    if (!effectiveEnabled(settings, location.hostname)) { restoreAll(); return; }
    let candidates;
    if (root instanceof Element) {
      const found = new Set(root.querySelectorAll?.(BLOCK_SELECTOR) || []);
      if (root.matches(BLOCK_SELECTOR)) found.add(root);
      const ancestor = root.closest(BLOCK_SELECTOR);
      if (ancestor) found.add(ancestor);
      candidates = Array.from(found);
    } else {
      candidates = Array.from(root.querySelectorAll?.(BLOCK_SELECTOR) || []);
    }
    for (const el of candidates) layoutElement(el);
  }

  function scheduleScan(root = document) {
    pendingRoots.add(root?.isConnected === false ? document : root);
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const roots = Array.from(pendingRoots);
      pendingRoots.clear();
      if (roots.includes(document)) { scan(document); return; }
      for (const candidate of roots) scan(candidate);
    }, 120);
  }

  function restoreAll() {
    for (const el of Array.from(rendered)) restore(el);
  }

  async function reloadSettings() {
    settings = normalizeSettings(await chrome.storage.sync.get(null));
    scheduleScan(document);
  }

  async function start() {
    try {
      await loadWasm();
      document.documentElement.dataset.kpExtensionState = "ready";
    } catch (error) {
      startupError = error instanceof Error ? error.message : String(error);
      document.documentElement.dataset.kpExtensionState = "error";
      console.error("[TeX Line Breaker] failed to load layout core", error);
      return;
    }
    resizeObserver = new ResizeObserver(entries => {
      if (muting) return;
      for (const entry of entries) {
        if (!entry.target.isConnected) { restore(entry.target); continue; }
        const width = entry.target.clientWidth;
        const previous = observedWidths.get(entry.target);
        if (previous == null || Math.abs(width - previous) > 0.5) {
          observedWidths.set(entry.target, width);
          scheduleScan(entry.target);
        }
      }
    });
    observer = new MutationObserver(mutations => {
      if (muting) return;
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          const owner = mutation.target.parentElement?.closest?.("[data-kp-rendered='1']");
          if (owner) { adoptRenderedContent(owner); restore(owner); }
          scheduleScan(owner || mutation.target.parentElement || document);
          continue;
        }
        if (mutation.type === "childList") {
          for (const removed of mutation.removedNodes) releaseRemovedTree(removed);
          const owner = mutation.target instanceof Element ? mutation.target.closest?.("[data-kp-rendered='1']") : mutation.target.parentElement?.closest?.("[data-kp-rendered='1']");
          if (owner) { adoptRenderedContent(owner); restore(owner); }
          scheduleScan(owner || (mutation.target instanceof Element ? mutation.target : mutation.target.parentElement || document));
        }
        if (mutation.type === "attributes") scheduleScan(mutation.target.closest?.(BLOCK_SELECTOR) || document);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "lang", "dir", "data-sfs-replaced"] });
    chrome.storage.onChanged.addListener((_, area) => { if (area === "sync") reloadSettings(); });
    await reloadSettings();
    document.fonts?.ready?.then(() => scheduleScan(document)).catch(() => {});
  }

  start().catch(error => {
    startupError = error instanceof Error ? error.message : String(error);
    document.documentElement.dataset.kpExtensionState = "error";
    console.error("[TeX Line Breaker] failed to start", error);
  });
})();
