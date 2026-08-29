(() => {
  "use strict";
  const { DEFAULTS, effectiveEnabled, tokenizeText, applyBreakRules, hyphenateTokens, createPatternHyphenator, punctuationProfile, applySyntheticAutoSpacing } = globalThis.TexLineBreakerShared;
  const BLOCK_SELECTOR = "p, blockquote, article p, div";
  const COMPLEX_SELECTOR = "code, pre, kbd, samp, table, img, video, audio, canvas, svg, iframe, input, textarea, select, button, math";
  const INLINE_TAGS = new Set(["A", "ABBR", "B", "BDI", "BDO", "BR", "CITE", "DEL", "EM", "I", "INS", "MARK", "Q", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U"]);
  const MAX_CHARS = 8000;
  const originals = new WeakMap();
  const observed = new Set();
  const observedWidths = new WeakMap();
  let settings = { ...DEFAULTS };
  let wasm = null;
  let observer = null;
  let resizeObserver = null;
  let muting = false;
  let scanTimer = 0;
  const hyphenateEnglish = createPatternHyphenator(globalThis.TexLineBreakerHyphenationEnUs);

  async function loadWasm() {
    const url = chrome.runtime.getURL("wasm/tex_line_breaker_core.wasm");
    const response = await fetch(url);
    const bytes = await response.arrayBuffer();
    wasm = (await WebAssembly.instantiate(bytes, {})).instance.exports;
  }

  function callLayout(input) {
    if (!wasm) throw new Error("WASM core is not ready");
    const encoded = new TextEncoder().encode(JSON.stringify(input));
    const inputPtr = wasm.alloc(encoded.length);
    new Uint8Array(wasm.memory.buffer, inputPtr, encoded.length).set(encoded);
    const packed = wasm.layout(inputPtr, encoded.length);
    wasm.dealloc(inputPtr, encoded.length);
    if (packed === 0n) throw new Error("WASM layout failed");
    const outputPtr = Number(packed >> 32n);
    const outputLen = Number(packed & 0xffffffffn);
    const json = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, outputPtr, outputLen));
    wasm.dealloc(outputPtr, outputLen);
    return JSON.parse(json);
  }

  function simpleInlineTree(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.matches(COMPLEX_SELECTOR)) return false;
      if (node !== root && !INLINE_TAGS.has(node.tagName)) return false;
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
    return hyphenateTokens(applyBreakRules(tokens, settings.cjkRules), hyphenateEnglish, settings.hyphenation);
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
        textAutospacePriority: el.style.getPropertyPriority("text-autospace")
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
    box.remove();
    const em = Number.parseFloat(rootStyle.fontSize) || 16;
    const syntheticSpacing = em * 0.125;
    const hyphenWidth = measureInsertedGlyph(root, "-");
    return widths.map((width, index) => {
      const token = tokens[index];
      const punctuation = punctuationProfile(token, em, settings.punctuationCompression);
      const normalStretch = token.type === "space" ? Math.max(width * settings.maxStretch, em * 0.08) : (token.type === "cjk" ? em * settings.maxStretch : 0);
      const normalShrink = token.type === "space" ? Math.max(width * settings.maxShrink, em * 0.04) : (token.type === "cjk" ? em * settings.maxShrink : 0);
      return {
        width: width + (token.autoSpaceAfter ? syntheticSpacing : 0),
        can_break_after: token.canBreakAfter,
        forced_break_after: token.forcedBreakAfter,
        penalty: token.penalty,
        flagged: token.flagged,
        discretionary: Boolean(token.insert),
        discard_at_break: token.type === "space" || token.type === "newline",
        discard_width_at_break: token.autoSpaceAfter ? syntheticSpacing : 0,
        insert_width_at_break: token.insert ? hyphenWidth : 0,
        stretch: normalStretch,
        shrink: normalShrink + punctuation.shrink,
        start_protrusion: settings.hangingPunctuation ? punctuation.startProtrusion : 0,
        end_protrusion: settings.hangingPunctuation ? punctuation.endProtrusion : 0,
        visible_units: token.type === "space" || token.type === "newline" ? 0 : Array.from(token.text).length
      };
    });
  }

  function measureInsertedGlyph(root, text) {
    const span = document.createElement("span");
    const style = getComputedStyle(root);
    span.textContent = text;
    span.style.cssText = `position:fixed;left:-100000px;top:0;visibility:hidden;white-space:nowrap;font:${style.font};font-kerning:${style.fontKerning};font-feature-settings:${style.fontFeatureSettings};letter-spacing:${style.letterSpacing}`;
    document.documentElement.appendChild(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return width;
  }

  function appendToken(lineEl, token, state, suppressTrailingAutoSpace) {
    if (token.type === "newline") return;
    const visibleText = token.text === "\u00ad" ? "" : token.text;
    const samePath = state.path?.length === token.wrappers.length && token.wrappers.every((wrapper, index) => wrapper === state.path[index]);
    if (samePath && state.leaf) {
      state.leaf.appendChild(document.createTextNode(visibleText));
      if (token.autoSpaceAfter && !suppressTrailingAutoSpace) appendSyntheticSpace(state.leaf);
      return;
    }
    let parent = lineEl;
    for (const original of token.wrappers) {
      const wrapper = original.cloneNode(false);
      parent.appendChild(wrapper);
      parent = wrapper;
    }
    parent.appendChild(document.createTextNode(visibleText));
    state.path = token.wrappers;
    state.leaf = parent;
    if (token.autoSpaceAfter && !suppressTrailingAutoSpace) appendSyntheticSpace(parent);
  }

  function appendSyntheticSpace(lineEl) {
    const spacer = document.createElement("span");
    spacer.dataset.kpAutospaceSpacer = "1";
    spacer.setAttribute("aria-hidden", "true");
    spacer.style.cssText = "display:inline-block;width:0.125em;user-select:none;pointer-events:none";
    lineEl.appendChild(spacer);
  }

  function appendAdjustment(parent, pixels) {
    if (!Number.isFinite(pixels) || Math.abs(pixels) < 0.01) return;
    const spacer = document.createElement("span");
    spacer.dataset.kpAdjustment = "1";
    spacer.setAttribute("aria-hidden", "true");
    spacer.style.cssText = `display:inline-block;width:0;height:0;margin-inline-end:${pixels}px;user-select:none;pointer-events:none`;
    parent.appendChild(spacer);
  }

  function distributeAdjustment(units, line) {
    const adjustments = new Array(units.length).fill(0);
    if (!Number.isFinite(line.adjustment) || Math.abs(line.adjustment) < 0.01) return adjustments;
    const capacities = units.map((unit, index) => index + 1 === units.length ? 0 : (line.adjustment >= 0 ? unit.stretch : unit.shrink));
    let total = capacities.reduce((sum, value) => sum + Math.max(0, value), 0);
    if (line.adjustment >= 0) total += Math.max(0, line.emergency_stretch || 0);
    if (total <= 0) return adjustments;
    let assigned = 0;
    let lastFlexible = -1;
    capacities.forEach((capacity, index) => {
      if (capacity <= 0) return;
      lastFlexible = index;
      adjustments[index] = line.adjustment * capacity / total;
      assigned += adjustments[index];
    });
    if (line.adjustment >= 0 && line.emergency_stretch > 0) {
      const visible = units.map((unit, index) => unit.visible_units > 0 ? index : -1).filter(index => index >= 0);
      const emergencyShare = line.adjustment * line.emergency_stretch / total / Math.max(1, visible.length - 1);
      for (const index of visible.slice(0, -1)) { adjustments[index] += emergencyShare; assigned += emergencyShare; lastFlexible = index; }
    }
    if (lastFlexible >= 0) adjustments[lastFlexible] += line.adjustment - assigned;
    return adjustments;
  }

  function restore(el) {
    const original = originals.get(el);
    if (!original) return;
    muting = true;
    el.replaceChildren(...original.nodes);
    if (original.textAutospaceValue) {
      el.style.setProperty("text-autospace", original.textAutospaceValue, original.textAutospacePriority);
    } else {
      el.style.removeProperty("text-autospace");
    }
    delete el.dataset.kpRendered;
    delete el.dataset.kpAutospace;
    el.style.removeProperty("--kp-line-ratio");
    originals.delete(el);
    queueMicrotask(() => { muting = false; });
  }

  function render(el, tokens, units, result) {
    if (!result.lines?.length) return;
    ensureOriginal(el);
    const fragment = document.createDocumentFragment();
    result.lines.forEach((line, lineIndex) => {
      const lineEl = document.createElement("span");
      lineEl.dataset.kpLine = String(lineIndex + 1);
      lineEl.style.display = "block";
      lineEl.style.boxSizing = "content-box";
      lineEl.style.width = `calc(100% + ${line.start_protrusion + line.end_protrusion}px)`;
      lineEl.style.marginInlineStart = `${-line.start_protrusion}px`;
      lineEl.style.whiteSpace = "nowrap";
      lineEl.style.wordBreak = "normal";
      lineEl.style.overflowWrap = "normal";
      lineEl.style.textAlign = "start";
      lineEl.style.textAlignLast = "start";
      lineEl.style.setProperty("--kp-line-ratio", String(line.ratio));
      const state = { path: null, leaf: null };
      const lineUnits = units.slice(line.start, line.end);
      const adjustments = distributeAdjustment(lineUnits, line);
      for (let index = line.start; index < line.end; index++) {
        appendToken(lineEl, tokens[index], state, index + 1 === line.end);
        appendAdjustment(state.leaf || lineEl, adjustments[index - line.start]);
      }
      if (line.flagged && tokens[line.end - 1]?.insert) {
        const hyphen = document.createElement("span");
        hyphen.dataset.kpDiscretionary = "1";
        hyphen.textContent = tokens[line.end - 1].insert;
        (state.leaf || lineEl).appendChild(hyphen);
      }
      fragment.appendChild(lineEl);
    });
    muting = true;
    el.replaceChildren(fragment);
    el.dataset.kpRendered = "1";
    queueMicrotask(() => { muting = false; });
  }

  function layoutElement(el) {
    try {
      if (el.dataset.kpRendered === "1") restore(el);
      if (!eligible(el)) return;
      ensureOriginal(el);
      const syntheticAutoSpacing = prepareAutoSpacing(el);
      const tokens = applySyntheticAutoSpacing(collectTokens(el), syntheticAutoSpacing);
      if (tokens.length < 2) { restore(el); return; }
      const units = measure(el, tokens);
      const cs = getComputedStyle(el);
      const lineWidth = el.clientWidth - (Number.parseFloat(cs.paddingLeft) || 0) - (Number.parseFloat(cs.paddingRight) || 0);
      const result = callLayout({
        units,
        line_width: Math.max(1, lineWidth - 0.5),
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
      render(el, tokens, units, result);
      observedWidths.set(el, el.getBoundingClientRect().width);
      if (!observed.has(el)) { observed.add(el); resizeObserver.observe(el); }
    } catch (error) {
      restore(el);
      console.debug("[TeX Line Breaker] native layout retained", error);
    }
  }

  function scan(root = document) {
    if (!effectiveEnabled(settings, location.hostname)) { restoreAll(); return; }
    const candidates = root instanceof Element && root.matches(BLOCK_SELECTOR) ? [root] : Array.from(root.querySelectorAll?.(BLOCK_SELECTOR) || []);
    for (const el of candidates) layoutElement(el);
  }

  function scheduleScan(root = document) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => scan(root), 120);
  }

  function restoreAll() {
    for (const el of document.querySelectorAll("[data-kp-rendered='1']")) restore(el);
  }

  async function reloadSettings() {
    settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
    scheduleScan(document);
  }

  async function start() {
    await loadWasm();
    resizeObserver = new ResizeObserver(entries => {
      if (muting) return;
      for (const entry of entries) {
        const width = entry.contentRect.width;
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
        if (mutation.type === "childList") {
          const owner = mutation.target instanceof Element ? mutation.target.closest?.("[data-kp-rendered='1']") : mutation.target.parentElement?.closest?.("[data-kp-rendered='1']");
          if (owner && !owner.querySelector(":scope > [data-kp-line]")) {
            const previous = originals.get(owner);
            originals.set(owner, {
              nodes: Array.from(owner.childNodes),
              textAutospaceValue: previous?.textAutospaceValue || "",
              textAutospacePriority: previous?.textAutospacePriority || ""
            });
            delete owner.dataset.kpRendered;
          }
          scheduleScan(owner || (mutation.target instanceof Element ? mutation.target : document));
        }
        if (mutation.type === "attributes") scheduleScan(mutation.target.closest?.(BLOCK_SELECTOR) || document);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-sfs-replaced"] });
    chrome.storage.onChanged.addListener((_, area) => { if (area === "sync") reloadSettings(); });
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === "kp-rerender") { restoreAll(); scheduleScan(document); }
      if (message?.type === "kp-restore") restoreAll();
    });
    await reloadSettings();
    document.fonts?.ready?.then(() => scheduleScan(document)).catch(() => {});
  }

  start().catch(error => console.error("[TeX Line Breaker] failed to start", error));
})();
