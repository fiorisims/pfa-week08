/*
 * Features added in the fixes build. Plain script, same global scope as
 * index.js, so it can call its helpers (placePng, panelRows, setStatus...).
 * initFeatures() is called from index.js's load handler.
 */

const PAGE_PRESETS = {
  "tabloid-landscape": { w: 2550, h: 1650, label: "11 x 17 in landscape" },
  "tabloid-portrait": { w: 1650, h: 2550, label: "11 x 17 in portrait" },
  "hd": { w: 1920, h: 1080, label: "16:9 HD" },
  "a3-landscape": { w: 2480, h: 1754, label: "A3 landscape" },
  "square": { w: 2000, h: 2000, label: "Square" },
};
const SETTINGS_KEY = "colorscript.settings";

let currentPalette = null;   /* { key, label, colors } shown in the swatch strip */
let lastPickIndex = null;    /* for shift-click ranges in the picker */

/* ---------------- settings: theme + text size ---------------- */

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {}; }
  catch (e) { return {}; }
}
function saveSettings(patch) {
  const s = Object.assign(loadSettings(), patch);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  return s;
}

/* Photoshop's current UI theme as one of darkest/dark/light/lightest, or null.
 * Read from the application's interface-brightness preference (Action Manager). */
let hostThemeCache = null;
const HOST_THEME_BY_ENUM = {
  kPanelBrightnessDarkGray: "darkest",
  kPanelBrightnessMediumGray: "dark",
  kPanelBrightnessLightGray: "light",
  kPanelBrightnessOriginal: "lightest",
};
async function readHostTheme() {
  try {
    const r = await action.batchPlay([{
      _obj: "get",
      _target: [{ _property: "kuiBrightnessLevel" }, { _ref: "application", _enum: "ordinal", _value: "targetEnum" }],
    }], {});
    const v = r && r[0] && r[0].kuiBrightnessLevel;
    const key = v && (v._value || v);
    hostThemeCache = HOST_THEME_BY_ENUM[key] || null;
    if (!hostThemeCache && key) { hostThemeCache = /dark/i.test(String(key)) ? "dark" : "light"; }
  } catch (e) { console.error(e); hostThemeCache = null; }
  return hostThemeCache;
}
function hostTheme() { return hostThemeCache; }

function applyTheme(choice) {
  let theme = choice || "aero";
  if (theme === "match") {
    const t = hostTheme();
    theme = t ? "ps-" + t : "ps-dark";
  }
  document.body.setAttribute("data-theme", theme);
}

function initLook() {
  const s = loadSettings();
  const themeSel = document.getElementById("optTheme");
  const sizeSel = document.getElementById("optTextSize");
  if (themeSel) {
    themeSel.value = s.theme || "aero";
    themeSel.addEventListener("change", async function () {
      saveSettings({ theme: themeSel.value });
      if (themeSel.value === "match") { await readHostTheme(); }
      applyTheme(themeSel.value);
      setStatus("Theme: " + themeSel.options[themeSel.selectedIndex].textContent +
        (themeSel.value === "match" ? " (" + (hostTheme() || "unknown, using dark") + ")" : ""), "ok");
    });
  }
  if (sizeSel) {
    sizeSel.value = s.size || "normal";
    sizeSel.addEventListener("change", function () {
      saveSettings({ size: sizeSel.value });
      document.body.setAttribute("data-size", sizeSel.value);
    });
    document.body.setAttribute("data-size", sizeSel.value);
  }
  applyTheme(themeSel ? themeSel.value : "aero");
  /* follow Photoshop when it changes its theme */
  let lastHost = null;
  const follow = async function () {
    const now = await readHostTheme();
    if (now !== lastHost) { lastHost = now; if ((themeSel ? themeSel.value : "") === "match") { applyTheme("match"); } }
  };
  follow();
  setInterval(follow, 3000);
  const note = document.getElementById("versionNote");
  if (note) {
    try { note.textContent = "Color Script " + uxp.entrypoints.getPluginVersion?.() ; } catch (e) { note.textContent = ""; }
    if (!note.textContent || /undefined/.test(note.textContent)) { note.textContent = "Color Script (fixes build)"; }
  }
}

/* ---------------- tabs ---------------- */

function initTabs() {
  const tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  const s = loadSettings();
  function show(pageId) {
    for (const t of tabs) {
      const on = t.getAttribute("data-page") === pageId;
      t.classList.toggle("on", on);
      const page = document.getElementById(t.getAttribute("data-page"));
      if (page) { page.hidden = !on; }
    }
    saveSettings({ tab: pageId });
    window.dispatchEvent(new Event("resize"));
  }
  for (const t of tabs) {
    t.addEventListener("click", function () { show(t.getAttribute("data-page")); });
  }
  show(s.tab && document.getElementById(s.tab) ? s.tab : "pageScript");
}

/* ---------------- moods, palette, words ---------------- */

function moodButtonStyle(colors) {
  const a = hexColor(colors[1]), b = hexColor(colors[2]), c = hexColor(colors[3]);
  return "background: linear-gradient(180deg, " + c + " 0%, " + b + " 50%, " + a + " 100%); " +
    "color: " + (luminance(colors[2]) > 150 ? "#102030" : "#ffffff") + "; text-shadow: none;";
}

function renderMoodGrid() {
  const grid = document.getElementById("moodGrid");
  if (!grid) { return; }
  clearNode(grid);
  for (const key of MOOD_ORDER) {
    const m = MOODS[key];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn mood";
    b.id = "btnMood_" + key;
    b.textContent = m.label;
    b.setAttribute("style", moodButtonStyle(m.colors));
    b.title = m.label + ": " + paletteText(m.colors);
    b.addEventListener("click", function () { onEmotion(key); });
    grid.appendChild(b);
  }
}

function markMoodButton(key) {
  for (const el of document.querySelectorAll(".btn.mood")) {
    el.classList.toggle("on", el.id === "btnMood_" + key);
  }
}

function setPaletteNote(text) {
  const el = document.getElementById("paletteNote");
  if (el) { el.textContent = text; }
}

function lockOn() {
  const el = document.getElementById("optLockPalette");
  return !!(el && el.checked);
}

/* The palette a mood click uses: the locked one, else a fresh roll. */
function paletteFor(key, emo) {
  if (lockOn() && currentPalette && currentPalette.colors) {
    emo.label = currentPalette.label;
    return currentPalette.colors.map(cloneColor);
  }
  const colors = randomEmotionPalette(emo.colors, readColorRange());
  currentPalette = { key: key, label: emo.label, colors: colors };
  markMoodButton(key);
  setPaletteNote(emo.label + " variation: " + paletteText(colors));
  return colors;
}

/* Put a palette in the strip and make it the one Apply / locked clicks use. */
function setCurrentPalette(key, label, colors, note) {
  EMOTIONS[key] = { label: label, colors: colors.map(cloneColor) };
  currentPalette = { key: key, label: label, colors: colors.map(cloneColor) };
  updateEmotionSwatches(colors);
  markMoodButton(key);
  setPaletteNote(note || (label + ": " + paletteText(colors)));
}

function applyCurrentPalette() {
  if (!currentPalette) { setStatus("Pick a mood first."); return; }
  const lock = document.getElementById("optLockPalette");
  const was = lock ? lock.checked : false;
  if (lock && !was) { lock.checked = true; }
  EMOTIONS[currentPalette.key] = { label: currentPalette.label, colors: currentPalette.colors.map(cloneColor) };
  Promise.resolve(onEmotion(currentPalette.key)).then(function () {
    if (lock && !was) { lock.checked = false; }
  });
}

function rerollPalette() {
  if (!currentPalette) { setStatus("Pick a mood first."); return; }
  const base = MOODS[currentPalette.key] ? MOODS[currentPalette.key].colors : currentPalette.colors;
  const colors = randomEmotionPalette(base, readColorRange());
  setCurrentPalette(currentPalette.key, currentPalette.label, colors, currentPalette.label + " variation: " + paletteText(colors));
  setStatus("Rerolled " + currentPalette.label + ". Apply this palette, or pick panels and click the mood.", "ok");
}

function applyWords() {
  const input = document.getElementById("optMoodWords");
  const text = input ? String(input.value || "").trim() : "";
  if (!text) { setStatus("Type a few words first, like: eerie dawn, muted."); return; }
  const r = interpretMood(text);
  if (!r.colors) { setStatus(r.explanation, "err"); return; }
  const label = text.length > 24 ? text.slice(0, 24) + "..." : text;
  setCurrentPalette("words", label, r.colors, "“" + text + "” → " + r.explanation);
  setStatus("Words: " + r.explanation + " | palette " + paletteText(r.colors) +
    " | click Apply this palette (or lock it and pick panels)", "ok");
}

function foregroundRgb() {
  const c = app.foregroundColor;
  return [Math.round(c.rgb.red), Math.round(c.rgb.green), Math.round(c.rgb.blue)];
}

/* A four-stop ramp around one colour: dark shadow, the colour, a pale light. */
function rampFromColor(rgb) {
  const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const h = hsl[0], s = hsl[1];
  // Keep the colour itself and spread the other stops so lightness always rises.
  const l = Math.max(0.12, Math.min(0.85, hsl[2]));
  const stops = [
    hslToRgb(h + 6, Math.min(1, s * 0.9), Math.max(0.04, l * 0.25)),
    hslToRgb(h - 6, Math.min(1, s * 1.05), l * 0.65),
    hsl[2] < 0.12 || hsl[2] > 0.85 ? hslToRgb(h, s, l) : [rgb[0], rgb[1], rgb[2]],
    hslToRgb(h + 12, s * 0.45, Math.min(0.97, l + (1 - l) * 0.72)),
  ];
  stops.sort(function (a, b) { return luminance(a) - luminance(b); });
  return stops;
}

async function pickColorFromPhotoshop(start) {
  const r = await action.batchPlay([{
    _obj: "showColorPicker",
    context: "Mood colour",
    color: { _obj: "RGBColor", red: start[0], green: start[1], blue: start[2] },
  }], {});
  const res = r && r[0];
  if (!res || res.value === false || !res.color) { return null; }
  const c = res.color;
  return [Math.round(c.red), Math.round(c.green !== undefined ? c.green : c.grain), Math.round(c.blue)];
}

async function customFromPicker() {
  let rgb = null;
  try { rgb = await pickColorFromPhotoshop(foregroundRgb()); }
  catch (e) { console.error(e); }
  if (!rgb) {
    rgb = foregroundRgb();
    setStatus("The colour picker was not available; used the foreground colour " + hexColor(rgb) + ".", "ok");
  }
  setCurrentPalette("custom", "Custom " + hexColor(rgb), rampFromColor(rgb), "Custom ramp around " + hexColor(rgb) + ": " + paletteText(rampFromColor(rgb)));
  setStatus("Custom palette from " + hexColor(rgb) + " | click Apply this palette", "ok");
}

function customFromForeground() {
  const rgb = foregroundRgb();
  setCurrentPalette("custom", "Custom " + hexColor(rgb), rampFromColor(rgb));
  setStatus("Custom palette from the foreground colour " + hexColor(rgb) + " | click Apply this palette", "ok");
}

function initSwatchEdits() {
  const row = document.getElementById("emoSwatches");
  if (!row) { return; }
  Array.prototype.forEach.call(row.children, function (el, i) {
    el.addEventListener("click", function () {
      if (!currentPalette) { setStatus("Pick a mood first, then click a swatch to replace that stop."); return; }
      const rgb = foregroundRgb();
      const colors = currentPalette.colors.map(cloneColor);
      colors[i] = rgb;
      const key = currentPalette.key === "words" || currentPalette.key === "custom" ? currentPalette.key : "custom";
      setCurrentPalette(key, currentPalette.label.indexOf("edited") >= 0 ? currentPalette.label : currentPalette.label + " (edited)", colors);
      const lock = document.getElementById("optLockPalette");
      if (lock && !lock.checked) { const r = document.getElementById("lockCheck"); if (r) { r.click(); } }
      setStatus("Stop " + (i + 1) + " set to the foreground colour " + hexColor(rgb) + "; palette locked.", "ok");
    });
  });
}

/* ---------------- picker: all / none / row / shift ranges ---------------- */

function setPanelPicks(doc, indexes) {
  panelPicks = indexes.map(function (i) { return { docId: doc.id, index: i }; });
  for (const node of panelChipNodes) {
    const on = indexes.indexOf(node.index) >= 0;
    node.el.classList.toggle("on", on);
    const check = node.el.querySelector(".panel-check");
    if (check) { check.classList.toggle("on", on); }
  }
  const layers = indexes.map(function (i) { return findPanelImage(doc, i); }).filter(Boolean);
  core.executeAsModal(async () => {
    app.activeDocument = doc;
    if (layers.length) { await selectLayers(layers.map(function (l) { return l.id; })); }
    else { doc.activeLayers = []; }
  }, { commandName: "Color Script: select panels" }).catch(function (e) { console.error(e); });
  setStatus(indexes.length ? indexes.length + " panel" + (indexes.length === 1 ? "" : "s") + " selected. Pick a mood." : "No panels selected.", "ok");
}

function pickAllPanels(on) {
  const doc = app.documents.length ? app.activeDocument : null;
  if (!doc) { return; }
  const all = [];
  for (const row of panelRows(doc)) { for (const p of row.panels) { all.push(p.index); } }
  setPanelPicks(doc, on ? all : []);
}

function pickRow(rowNumber) {
  const doc = app.documents.length ? app.activeDocument : null;
  if (!doc) { return; }
  const rows = panelRows(doc);
  const row = rows[rowNumber - 1];
  if (!row) { return; }
  setPanelPicks(doc, row.panels.map(function (p) { return p.index; }));
}

/* ---------------- template: presets, captions, add images, re-flow ---------------- */

function readPagePreset() {
  const el = document.getElementById("optPagePreset");
  return PAGE_PRESETS[el ? el.value : ""] || PAGE_PRESETS["tabloid-landscape"];
}

function readCaptionsOption() {
  const el = document.getElementById("optCaptions");
  return !!(el && el.checked);
}

function captionLayerName(index) { return "Caption " + panelLabel(index); }

function isCaptionLayer(l) { return /^Caption \d+$/.test(String(l.name || "")); }

/* Photoshop names a new text layer after its contents, so rename it afterwards. */
async function addCaption(text, cx, y, index) {
  const id = await addText(text, cx, y, 28, [40, 40, 40], false, true, captionLayerName(index));
  const l = findLayerById(app.activeDocument, id);
  if (l) { l.name = captionLayerName(index); }
  return l;
}

async function removeCaptions(doc) {
  const doomed = [];
  (function walk(layers) {
    for (const l of (layers || [])) {
      if (isCaptionLayer(l)) { doomed.push(l); }
      else if (l.layers && l.layers.length) { walk(l.layers); }
    }
  })(doc.layers);
  for (const l of doomed) { try { await l.delete(); } catch (e) { console.error(e); } }
}

/* Lay out every Panel NN layer of the active template again, from the page
 * preset and column count, resizing the canvas if the preset changed. */
async function reflowTemplate(doc, opts) {
  opts = opts || {};
  const preset = opts.preset || readPagePreset();
  const columns = Math.max(1, Math.min(8, opts.columns || readTemplateColumns()));
  const panels = listPanelLayers(doc);
  if (!panels.length) { throw new Error("No Panel layers in this document."); }

  const W = preset.w, H = preset.h;
  if (Math.round(Number(doc.width)) !== W || Math.round(Number(doc.height)) !== H) {
    await doc.resizeCanvas(W, H, constants.AnchorPosition.TOPLEFT);
    const bg = doc.layers[doc.layers.length - 1];
    if (bg && bg.name === "Background" && bg.kind === "pixel") {
      try {
        doc.activeLayers = [bg];
        await doc.selection.selectAll();
        await action.batchPlay([{ _obj: "fill", using: { _enum: "fillContents", _value: "white" }, mode: { _enum: "blendMode", _value: "normal" } }], {});
        await doc.selection.deselect();
      } catch (e) { console.error(e); }
    }
  }
  const captions = opts.captions === undefined ? readCaptionsOption() : opts.captions;
  const captionBand = captions ? 46 : 0;
  const rows = Math.max(1, Math.ceil(panels.length / columns));
  const innerW = W - TEMPLATE_MARGIN * 2 - TEMPLATE_GAP * (columns - 1);
  const innerH = H - TEMPLATE_MARGIN * 2 - TEMPLATE_GAP * (rows - 1);
  const cellW = innerW / columns;
  const cellH = innerH / rows;

  await removeCaptions(doc);
  const placed = [];
  for (let i = 0; i < panels.length; i++) {
    const layer = panels[i];
    const b = layer.boundsNoEffects || layer.bounds;
    const cw = Number(b.right) - Number(b.left);
    const ch = Number(b.bottom) - Number(b.top);
    if (!(cw > 0 && ch > 0)) { continue; }
    const fitH = cellH - captionBand;
    const scale = Math.min(cellW / cw, fitH / ch);
    const w = Math.max(1, Math.round(cw * scale));
    const h = Math.max(1, Math.round(ch * scale));
    const col = i % columns, row = Math.floor(i / columns);
    const cellX = TEMPLATE_MARGIN + col * (cellW + TEMPLATE_GAP);
    const cellY = TEMPLATE_MARGIN + row * (cellH + TEMPLATE_GAP);
    const x = Math.round(cellX + (cellW - w) / 2);
    const y = Math.round(cellY + (fitH - h) / 2);
    doc.activeLayers = [layer];
    if (Math.abs(scale - 1) > 0.002) {
      await layer.scale(scale * 100, scale * 100, constants.AnchorPosition.TOPLEFT);
    }
    const b2 = layer.boundsNoEffects || layer.bounds;
    const dx = x - Number(b2.left), dy = y - Number(b2.top);
    if (dx || dy) { await layer.translate(dx, dy); }
    placed.push({ layer: layer, index: panelNumberFromName(layer.name), cx: cellX + cellW / 2, y: y + h });
  }
  if (captions) {
    for (const p of placed) {
      const text = panelDisplayName(p.layer);
      try {
        const l = await addCaption(text, p.cx, p.y + 30, p.index);
        if (l) { try { await l.move(doc.layers[doc.layers.length - 1], constants.ElementPlacement.PLACEBEFORE); } catch (e) { /* keep where it is */ } }
      } catch (e) { console.error(e); }
    }
  }
  return { panels: placed.length, columns: columns, rows: rows, page: preset.label, captions: captions };
}

async function onReflow() {
  const bar = document.getElementById("progress");
  const doc = app.documents.length ? app.activeDocument : null;
  if (!doc || !listPanelLayers(doc).length) { setStatus("Open a Color Script Template first."); return; }
  setEmotionBusy(true);
  if (bar) { bar.style.display = "block"; }
  setStatus("Re-flowing panels...");
  try {
    const r = await core.executeAsModal(async (ctx) => {
      const prev = app.displayDialogs;
      app.displayDialogs = constants.DialogModes.NONE;
      const suspension = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Color Script: re-flow" });
      try { app.activeDocument = doc; return await reflowTemplate(doc); }
      finally { await ctx.hostControl.resumeHistory(suspension); app.displayDialogs = prev; }
    }, { commandName: "Color Script: re-flow panels" });
    setStatus("Re-flowed " + r.panels + " panels | " + r.columns + " columns, " + r.rows + " rows | " + r.page +
      (r.captions ? " | captions" : ""), "ok");
    refreshTemplatePanels({ clearCache: true });
  } catch (e) {
    console.error(e);
    setStatus("Re-flow failed: " + (e && e.message ? e.message : e), "err");
  } finally {
    if (bar) { bar.style.display = "none"; }
    setEmotionBusy(false);
  }
}

async function onAddImages() {
  const bar = document.getElementById("progress");
  const doc = app.documents.length ? app.activeDocument : null;
  if (!doc || !listPanelLayers(doc).length) { setStatus("Open a Color Script Template first, or use Build Template."); return; }
  let files;
  try { files = await fs.getFileForOpening({ allowMultiple: true, types: IMAGE_TYPES }); }
  catch (e) { setStatus("Add images failed: " + (e && e.message ? e.message : e), "err"); return; }
  const list = !files ? [] : (Array.isArray(files) ? files : [files]);
  if (!list.length) { setStatus("No files selected."); return; }
  setEmotionBusy(true);
  if (bar) { bar.style.display = "block"; }
  setStatus("Adding " + list.length + " image(s)...");
  try {
    const r = await core.executeAsModal(async (ctx) => {
      const prev = app.displayDialogs;
      app.displayDialogs = constants.DialogModes.NONE;
      const suspension = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "Color Script: add images" });
      try {
        app.activeDocument = doc;
        const existing = listPanelLayers(doc);
        let next = existing.reduce(function (m, l) { return Math.max(m, panelNumberFromName(l.name) || 0); }, 0);
        const desat = readDesaturateOption();
        let added = 0;
        const failed = [];
        for (const f of list) {
          try {
            const meta = await readImageMeta(f);
            app.activeDocument = doc;
            next += 1;
            if (readKeepPsdOption() && isLayeredSource(f)) {
              await placePsdLayers(f, TEMPLATE_MARGIN, TEMPLATE_MARGIN, meta.width, meta.height, panelLayerName(next, meta.name));
            } else {
              const id = await placePng(meta.path, TEMPLATE_MARGIN, TEMPLATE_MARGIN, meta.width, meta.height,
                panelLayerName(next, meta.name), f);
              await rasterizeLayer(id);
              if (desat) { await desaturateLayer(findPanelImage(doc, next).id); }
            }
            added++;
          } catch (e) { console.error(e); failed.push(f.name); }
        }
        const flow = await reflowTemplate(doc);
        return { added: added, failed: failed, flow: flow };
      } finally { await ctx.hostControl.resumeHistory(suspension); app.displayDialogs = prev; }
    }, { commandName: "Color Script: add images" });
    setStatus("Added " + r.added + " panel(s) | now " + r.flow.panels + " panels in " + r.flow.columns + " columns" +
      (r.failed.length ? " | skipped: " + r.failed.join(", ") : ""), "ok");
    refreshTemplatePanels({ clearCache: true });
  } catch (e) {
    console.error(e);
    setStatus("Add images failed: " + (e && e.message ? e.message : e), "err");
  } finally {
    if (bar) { bar.style.display = "none"; }
    setEmotionBusy(false);
  }
}

/* ---------------- export ---------------- */

async function exportImage(kind) {
  const doc = app.documents.length ? app.activeDocument : null;
  if (!doc) { setStatus("Open a document first."); return; }
  const stem = fileStem(doc.name).replace(/[^\w\- ]+/g, "_") || "color-script";
  let entry;
  try {
    entry = await fs.getFileForSaving(stem + (kind === "jpg" ? ".jpg" : ".png"), { types: [kind === "jpg" ? "jpg" : "png"] });
  } catch (e) { setStatus("Save cancelled.", ""); return; }
  if (!entry) { setStatus("Save cancelled."); return; }
  try {
    await core.executeAsModal(async () => {
      app.activeDocument = doc;
      if (kind === "jpg") { await doc.saveAs.jpg(entry, { quality: 11 }, true); }
      else { await doc.saveAs.png(entry, { compression: 6 }, true); }
    }, { commandName: "Color Script: export " + kind });
    setStatus("Saved " + (entry.nativePath || entry.name), "ok");
  } catch (e) {
    console.error(e);
    setStatus("Export failed: " + (e && e.message ? e.message : e), "err");
  }
}

/* Adobe .aco swatch file, version 1 block followed by a version 2 block (names). */
function buildAco(colors, names) {
  const n = colors.length;
  const v1 = 4 + n * 10;
  let v2 = 4;
  const nameUnits = [];
  for (let i = 0; i < n; i++) {
    const nm = String(names && names[i] ? names[i] : hexColor(colors[i]));
    nameUnits.push(nm);
    v2 += 10 + 4 + (nm.length + 1) * 2;
  }
  const buf = new ArrayBuffer(v1 + v2);
  const dv = new DataView(buf);
  let o = 0;
  function u16(v) { dv.setUint16(o, v & 0xffff); o += 2; }
  function colorRec(c) { u16(0); u16(Math.round(c[0]) * 257); u16(Math.round(c[1]) * 257); u16(Math.round(c[2]) * 257); u16(0); }
  u16(1); u16(n);
  for (const c of colors) { colorRec(c); }
  u16(2); u16(n);
  for (let i = 0; i < n; i++) {
    colorRec(colors[i]);
    const nm = nameUnits[i];
    u16(0); u16(nm.length + 1);
    for (let k = 0; k < nm.length; k++) { u16(nm.charCodeAt(k)); }
    u16(0);
  }
  return buf;
}

/* Every distinct stop colour in the document's mood tints, or the current palette. */
function paletteColorsForExport() {
  const doc = app.documents.length ? app.activeDocument : null;
  const out = [];
  const names = [];
  if (currentPalette) {
    currentPalette.colors.forEach(function (c, i) { out.push(c); names.push(currentPalette.label + " " + (i + 1)); });
  }
  return { colors: out, names: names, source: currentPalette ? currentPalette.label : (doc ? doc.name : "") };
}

async function exportAco() {
  const p = paletteColorsForExport();
  if (!p.colors.length) { setStatus("Pick a mood first; the .aco holds the current palette."); return; }
  let entry;
  try { entry = await fs.getFileForSaving((p.source || "palette").replace(/[^\w\- ]+/g, "_") + ".aco", { types: ["aco"] }); }
  catch (e) { setStatus("Save cancelled."); return; }
  if (!entry) { setStatus("Save cancelled."); return; }
  try {
    await entry.write(buildAco(p.colors, p.names), { format: uxp.storage.formats.binary });
    setStatus("Saved " + p.colors.length + " swatches to " + (entry.nativePath || entry.name) +
      " (Window > Swatches > Import Swatches)", "ok");
  } catch (e) {
    console.error(e);
    setStatus("Save failed: " + (e && e.message ? e.message : e), "err");
  }
}

async function copyHex() {
  const p = paletteColorsForExport();
  if (!p.colors.length) { setStatus("Pick a mood first."); return; }
  const text = p.colors.map(hexColor).join("\n");
  try {
    await navigator.clipboard.setContent({ "text/plain": text });
    setStatus("Copied: " + p.colors.map(hexColor).join(" "), "ok");
  } catch (e) {
    console.error(e);
    setStatus("Clipboard not available. Palette: " + p.colors.map(hexColor).join(" "), "");
  }
}

/* ---------------- wiring ---------------- */

function on(id, handler) {
  const el = document.getElementById(id);
  if (el) { el.addEventListener("click", handler); }
}

function initFeatures() {
  initLook();
  initTabs();
  renderMoodGrid();
  initSwatchEdits();
  wireCheck("captionsCheck", "optCaptions");
  wireCheck("lockCheck", "optLockPalette");
  on("btnMoodWords", applyWords);
  const words = document.getElementById("optMoodWords");
  if (words) { words.addEventListener("keydown", function (e) { if (e.key === "Enter") { applyWords(); } }); }
  on("btnMoodPicker", customFromPicker);
  on("btnMoodForeground", customFromForeground);
  on("btnReroll", rerollPalette);
  on("btnApplyPalette", applyCurrentPalette);
  on("btnPanelsAll", function () { pickAllPanels(true); });
  on("btnPanelsNone", function () { pickAllPanels(false); });
  on("btnReflow", onReflow);
  on("btnAddImages", onAddImages);
  on("btnExportPng", function () { exportImage("png"); });
  on("btnExportJpg", function () { exportImage("jpg"); });
  on("btnExportAco", exportAco);
  on("btnCopyHex", copyHex);
}
