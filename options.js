(() => {
  "use strict";
  const { DEFAULTS } = globalThis.TexLineBreakerShared;
  const $ = id => document.getElementById(id);

  function addRule(rule = {}) {
    const row = document.createElement("div");
    row.className = "site-rule";
    row.innerHTML = `<input class="domain" type="text" placeholder="example.com" spellcheck="false"><label><input class="enabled" type="checkbox">对该站点启用</label><button class="secondary remove" type="button" aria-label="删除">×</button>`;
    row.querySelector(".domain").value = rule.domain || "";
    row.querySelector(".enabled").checked = rule.enabled === true;
    row.querySelector(".remove").addEventListener("click", () => row.remove());
    $("siteRules").appendChild(row);
  }

  function fill(settings) {
    $("globalEnabled").checked = settings.globalEnabled;
    $("pretolerance").value = settings.pretolerance;
    $("tolerance").value = settings.tolerance;
    $("emergencyStretch").value = settings.emergencyStretch;
    $("maxStretch").value = settings.maxStretch;
    $("maxShrink").value = settings.maxShrink;
    $("cjkRules").checked = settings.cjkRules;
    $("punctuationCompression").checked = settings.punctuationCompression;
    $("hangingPunctuation").checked = settings.hangingPunctuation;
    $("hyphenation").checked = settings.hyphenation;
    for (const id of ["linePenalty", "fitnessDemerits", "doubleHyphenDemerits", "finalHyphenDemerits", "shortLastLinePenalty", "orphanPenalty"]) $(id).value = settings[id];
    $("siteRules").replaceChildren();
    for (const rule of settings.siteRules || []) addRule(rule);
  }

  function collect() {
    const siteRules = Array.from(document.querySelectorAll(".site-rule")).map(row => ({
      domain: row.querySelector(".domain").value.trim(),
      enabled: row.querySelector(".enabled").checked
    })).filter(rule => rule.domain);
    return {
      globalEnabled: $("globalEnabled").checked,
      pretolerance: Math.min(10, Math.max(0, Number($("pretolerance").value) || 0)),
      tolerance: Math.min(10, Math.max(1, Number($("tolerance").value) || DEFAULTS.tolerance)),
      emergencyStretch: Math.min(1, Math.max(0, Number($("emergencyStretch").value) || 0)),
      maxStretch: Math.min(1, Math.max(0, Number($("maxStretch").value) || 0)),
      maxShrink: Math.min(1, Math.max(0, Number($("maxShrink").value) || 0)),
      cjkRules: $("cjkRules").checked,
      punctuationCompression: $("punctuationCompression").checked,
      hangingPunctuation: $("hangingPunctuation").checked,
      hyphenation: $("hyphenation").checked,
      linePenalty: clamp("linePenalty", 0, 100),
      fitnessDemerits: clamp("fitnessDemerits", 0, 50000),
      doubleHyphenDemerits: clamp("doubleHyphenDemerits", 0, 50000),
      finalHyphenDemerits: clamp("finalHyphenDemerits", 0, 50000),
      shortLastLinePenalty: clamp("shortLastLinePenalty", 0, 50000),
      orphanPenalty: clamp("orphanPenalty", 0, 50000),
      siteRules
    };
  }

  function clamp(id, min, max) {
    const value = Number($(id).value);
    return Math.min(max, Math.max(min, Number.isFinite(value) ? value : DEFAULTS[id]));
  }

  async function load() { fill({ ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) }); }
  async function save() { await chrome.storage.sync.set(collect()); $("status").textContent = "已保存，打开的网页会自动更新"; setTimeout(() => $("status").textContent = "", 2200); }
  async function reset() { await chrome.storage.sync.set(DEFAULTS); fill(DEFAULTS); $("status").textContent = "已恢复默认"; }
  $("addSite").addEventListener("click", () => addRule());
  $("save").addEventListener("click", save);
  $("reset").addEventListener("click", reset);
  load();
})();
