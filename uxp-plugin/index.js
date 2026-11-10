/*
 * Color Script - UXP panel
 *
 * Two ways to build a palette sheet:
 *   - Build from images...: pick PNG/JPG/PSD/... files, extract the dominant
 *     colors, plan the layout and draw the sheet into a new document.
 *   - Build from layout JSON...: replay a spec written by palette_sheet.py.
 *
 * The layout maths mirrors palette_sheet.plan_layout so the panel, the
 * standalone app and the .jsx renderer all produce the same sheet.
 */

const photoshop = window.require("photoshop");
const uxp = window.require("uxp");
const fs = uxp.storage.localFileSystem;
const { app, action, core, constants, imaging } = photoshop;

const DPI_DEFAULT = 150;
const DOC_NAME = "Color Script";
const SAMPLE_LONG_SIDE = 240;
const SAMPLE_TARGET = 4000;
const IMAGE_TYPES = [
  "png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "tga", "psd", "psb",
];

/*
 * Emotion colorizing: map the document's luminance onto a mood ramp and put
 * the result on one Color-blend layer, so the original light and shadow are
 * preserved. Each entry is [shadow, low mid, high mid, highlight].
 */
const TINT_PREFIX = "Emotion tint";
const TINT_MAX_PIXELS = 20000000;
const GRADIENT_SUFFIX = " (gradient map)";
/* A composite is treated as grayscale when (almost) every opaque pixel has
 * no chroma. The fraction allows a tiny colored mark (a signature, an accent). */
const GRAY_CHROMA_MAX = 12;
const GRAY_COLORED_FRACTION = 0.005;
const GRAY_SAMPLE_TARGET = 4000;
/* The moods live in moods.js; custom and typed palettes are added at runtime. */
const EMOTIONS = Object.assign({}, MOODS);
const EMOTION_BUTTON_IDS = [
  "btnEmotionClear", "btnMoodWords", "btnMoodPicker", "btnMoodForeground", "btnReroll",
  "btnApplyPalette", "btnReflow", "btnAddImages", "btnPanelsAll", "btnPanelsNone",
];
const GRAY_HINT_DEFAULT =
  "Import one or more grayscale images, then choose a mood to add the same gradient map to all of them.";

/* Documents opened by "Import grayscale..." and waiting for a mood click.
 * Kept only while they are still open, so repeated mood clicks reroll their
 * gradient maps; switching to a document outside the set exits the import flow. */
let grayscaleTargets = [];

/* Template panel picker state. The picker is just another way to select the
 * same Panel NN layer the Layers panel uses; the layer selection always wins
 * when it points at a panel. */
let panelPicks = [];
let panelPickerDocId = null;
let panelRefreshToken = 0;
let panelThumbCache = {};
let panelChipNodes = [];
let emotionBusy = false;
const PANEL_THUMB_W = 96;
const PANEL_THUMB_H = 72;
const PANEL_ROW_TOLERANCE_MIN = 30;
const ROW_HUE_SPREAD = 4;
const ROW_SAT_SPREAD = 0.025;
const ROW_LIGHT_SPREAD = 0.008;
const MOOD_HUE_SHIFT = 22;
const MOOD_HUE_TILT = 12;
const MOOD_HUE_JITTER = 5;
const MOOD_SAT_SCALE = 0.25;
const MOOD_SAT_JITTER = 0.08;
const MOOD_LIGHT_SHIFT = 0.06;
const MOOD_LIGHT_JITTER = 0.03;

/* layout constants (mirror palette_sheet.py) */
const MARGIN = 48;
const TITLE_SIZE = 30;
const CAPTION_SIZE = 15;
const LABEL_SIZE = 13;
const CAPTION_BAND = 30;
const LABEL_BAND = 24;
const STRIP_BAND = 30;
const STRIP_GAP = 8;
const IMAGE_GAP = 14;
const BLOCK_GAP = 44;
const COLUMN_GAP = 48;
const DOC_BG_DEFAULT = [24, 30, 40];
const DEFAULT_CAPTION_COLOR = [232, 238, 246];
const INK_LIGHT = [238, 242, 248];
const INK_DARK = [34, 38, 46];
const SHAPES = ["square", "rounded", "circle"];
const ORIENTATIONS = ["horizontal", "vertical", "grid"];

/* Color script template: an 11x17 landscape page of grayscale panels with
 * no swatches, labels, gradients or title. */
const TEMPLATE_DOC_NAME = "Color Script Template";
const TEMPLATE_W = 2550;
const TEMPLATE_H = 1650;
const TEMPLATE_DPI = 150;
const TEMPLATE_MARGIN = 120;
const TEMPLATE_GAP = 40;
const TEMPLATE_COLUMNS_DEFAULT = 3;
const TEMPLATE_COLUMNS_MIN = 1;
const TEMPLATE_COLUMNS_MAX = 8;
const PANEL_PREFIX = "Panel ";

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

/* The status shows the first clause; the rest (after the first " | ") goes to
 * the smaller detail line under it. */
function setStatus(text, kind) {
  const el = document.getElementById("status");
  const detail = document.getElementById("statusDetail");
  if (!el) { return; }
  const s = String(text == null ? "" : text);
  const cut = s.indexOf(" | ");
  el.textContent = cut >= 0 ? s.slice(0, cut) : s;
  el.className = kind || "";
  if (detail) { detail.textContent = cut >= 0 ? s.slice(cut + 3).replace(/ \| /g, "\n") : ""; }
}

function statusText() {
  const el = document.getElementById("status");
  const detail = document.getElementById("statusDetail");
  return (el ? el.textContent : "") + (detail && detail.textContent ? " | " + detail.textContent.replace(/\n/g, " | ") : "");
}

function to255(c) {
  return { red: c[0], green: c[1], blue: c[2] };
}

function hexColor(c) {
  const p = function (v) {
    const s = Math.max(0, Math.min(255, Math.round(v))).toString(16).toUpperCase();
    return s.length < 2 ? "0" + s : s;
  };
  return "#" + p(c[0]) + p(c[1]) + p(c[2]);
}

function luminance(c) {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrastInk(c) {
  return luminance(c) < 118 ? INK_LIGHT.slice() : INK_DARK.slice();
}

function fileStem(name) {
  const s = String(name || "image");
  const i = s.lastIndexOf(".");
  return i > 0 ? s.substring(0, i) : s;
}

function cloneColor(c) {
  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
}

function rectPts(x, y, w, h) {
  return [x, y, x + w, y, x + w, y + h, x, y + h];
}

function circlePts(x, y, w, h) {
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  const out = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return out;
}

function roundedPts(x, y, w, h) {
  const r = Math.min(w, h) * 0.22;
  const corners = [
    [x + w - r, y + r, -90, 0],
    [x + w - r, y + h - r, 0, 90],
    [x + r, y + h - r, 90, 180],
    [x + r, y + r, 180, 270],
  ];
  const out = [];
  for (const c of corners) {
    for (let s = 0; s < 7; s++) {
      const a = ((c[2] + (c[3] - c[2]) * s / 6) * Math.PI) / 180;
      out.push(c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r);
    }
  }
  return out;
}

function shapePoints(sw) {
  const x = sw.x + (sw.dx || 0), y = sw.y + (sw.dy || 0);
  let flat;
  if (sw.shape === "circle") flat = circlePts(x, y, sw.w, sw.h);
  else if (sw.shape === "rounded") flat = roundedPts(x, y, sw.w, sw.h);
  else flat = rectPts(x, y, sw.w, sw.h);
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
  return out;
}

/* ------------------------------------------------------------------ */
/* color extraction (port of palette_sheet._sample_pixels / _kmeans)   */
/* ------------------------------------------------------------------ */

function samplePixels(data, w, h, components, samples) {
  const target = samples || SAMPLE_TARGET;
  if (!data || w <= 0 || h <= 0) { return []; }
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / target)));
  const out = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * components;
      if (components >= 4 && data[i + 3] < 128) { continue; }
      out.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  return out;
}

function dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function kmeans(pixels, count, iters, minDist) {
  const n = pixels.length;
  if (!n) { return []; }
  const k = Math.max(1, Math.min(Math.floor(count) || 1, n));
  const iterations = Math.max(1, iters || 15);
  const minD = minDist === undefined ? 18 : minDist;

  const mean = [0, 0, 0];
  for (const p of pixels) { mean[0] += p[0]; mean[1] += p[1]; mean[2] += p[2]; }
  mean[0] /= n; mean[1] /= n; mean[2] /= n;

  let seed = pixels[0];
  let seedD = dist2(seed, mean);
  for (const p of pixels) {
    const d = dist2(p, mean);
    if (d > seedD) { seed = p; seedD = d; }
  }
  const centers = [seed];
  while (centers.length < k) {
    let best = null, bestD = -1;
    for (const p of pixels) {
      let d = Infinity;
      for (const c of centers) { d = Math.min(d, dist2(p, c)); }
      if (d > bestD) { best = p; bestD = d; }
    }
    if (!best || bestD <= 0) { break; }
    centers.push(best);
  }

  const assign = new Array(n).fill(0);
  for (let it = 0; it < iterations; it++) {
    let changed = false;
    for (let idx = 0; idx < n; idx++) {
      const p = pixels[idx];
      let bi = 0, bd = dist2(p, centers[0]);
      for (let ci = 1; ci < centers.length; ci++) {
        const d = dist2(p, centers[ci]);
        if (d < bd) { bi = ci; bd = d; }
      }
      if (assign[idx] !== bi) { assign[idx] = bi; changed = true; }
    }
    const sums = centers.map(function () { return [0, 0, 0]; });
    const sizes = centers.map(function () { return 0; });
    for (let idx = 0; idx < n; idx++) {
      const p = pixels[idx], ci = assign[idx];
      sums[ci][0] += p[0]; sums[ci][1] += p[1]; sums[ci][2] += p[2];
      sizes[ci] += 1;
    }
    for (let ci = 0; ci < centers.length; ci++) {
      if (sizes[ci]) {
        centers[ci] = [
          sums[ci][0] / sizes[ci],
          sums[ci][1] / sizes[ci],
          sums[ci][2] / sizes[ci],
        ];
      }
    }
    if (!changed) { break; }
  }

  const sizes = centers.map(function () { return 0; });
  for (const ci of assign) { sizes[ci] += 1; }

  const ranked = [];
  for (let ci = 0; ci < centers.length; ci++) {
    if (sizes[ci] > 0) { ranked.push({ c: centers[ci], s: sizes[ci] }); }
  }
  ranked.sort(function (a, b) {
    if (b.s !== a.s) { return b.s - a.s; }
    if (a.c[0] !== b.c[0]) { return a.c[0] - b.c[0]; }
    if (a.c[1] !== b.c[1]) { return a.c[1] - b.c[1]; }
    return a.c[2] - b.c[2];
  });

  const kept = [];
  for (const item of ranked) {
    let dup = false;
    for (const other of kept) {
      if (dist2(item.c, other.c) <= minD * minD) { dup = true; break; }
    }
    if (!dup) { kept.push(item); }
    if (kept.length >= k) { break; }
  }

  return kept.map(function (item) {
    return [Math.round(item.c[0]), Math.round(item.c[1]), Math.round(item.c[2])];
  });
}

/* ------------------------------------------------------------------ */
/* layout planner (port of palette_sheet.plan_layout)                  */
/* ------------------------------------------------------------------ */

function blockGrid(n, orientation, cols) {
  n = Math.max(1, Math.floor(n));
  if (orientation === "vertical") { return { cols: 1, rows: n }; }
  if (orientation === "grid") {
    const c = Math.max(1, Math.min(Math.floor(cols) || 1, n));
    return { cols: c, rows: Math.ceil(n / c) };
  }
  return { cols: n, rows: 1 };
}

function thumbnailLayout(items, maxW, maxH) {
  const n = items.length;
  if (!n) { return []; }
  const avail = Math.max(16, maxW - IMAGE_GAP * (n - 1));
  const per = avail / n;
  const out = [];
  for (const it of items) {
    const iw = Math.max(1, Number(it.w) || 1);
    const ih = Math.max(1, Number(it.h) || 1);
    const scale = Math.min(per / iw, maxH / ih);
    out.push({
      path: it.path,
      name: it.name,
      w: Math.max(1, Math.round(iw * scale)),
      h: Math.max(1, Math.round(ih * scale)),
      entry: it.entry,
    });
  }
  return out;
}

function planLayout(palettes, opts) {
  opts = opts || {};
  const shape = SHAPES.indexOf(opts.shape) >= 0 ? opts.shape : "square";
  const orientation = ORIENTATIONS.indexOf(opts.orientation) >= 0
    ? opts.orientation : "horizontal";
  const cols = Math.max(1, Math.floor(opts.cols || 4));
  const swatch = Math.max(16, Math.floor(opts.swatch || 96));
  const gap = Math.max(0, Math.floor(opts.gap === undefined ? 16 : opts.gap));
  const labels = opts.labels !== false;
  const gradients = opts.gradients !== false;
  const captions = opts.captions !== false;
  const bg = (opts.bg || DOC_BG_DEFAULT).map(function (v) { return Math.round(v); });
  const title = opts.title == null ? "" : String(opts.title);
  const dpi = Math.floor(opts.dpi || DPI_DEFAULT);
  const docName = opts.doc_name || DOC_NAME;
  const imgH = opts.image_size ? Math.max(16, Math.floor(opts.image_size)) : swatch;

  const labelBand = labels ? LABEL_BAND : 0;
  const stripBand = gradients ? (STRIP_BAND + STRIP_GAP) : 0;
  const captionBand = captions ? CAPTION_BAND : 0;

  const entries = [];
  for (let i = 0; i < palettes.length; i++) {
    const colors = (palettes[i].colors || [])
      .map(function (c) { return cloneColor(c); });
    if (!colors.length) { continue; }
    const surfaces = [];
    if (opts.images && i < opts.images.length && opts.images[i]) {
      for (const item of opts.images[i]) {
        if (!item) { continue; }
        surfaces.push({
          path: item.path, name: item.name, w: item.w, h: item.h,
          entry: item.entry,
        });
      }
    }
    entries.push({ label: palettes[i].label, colors: colors, surfaces: surfaces });
  }
  if (!entries.length) { throw new Error("no colors to lay out"); }

  const blocks = [];
  for (const e of entries) {
    const gr = blockGrid(e.colors.length, orientation, cols);
    const bw = gr.cols * swatch + (gr.cols - 1) * gap;
    const bh = gr.rows * swatch + (gr.rows - 1) * gap;
    const thumbs = thumbnailLayout(e.surfaces, bw, imgH);
    let imgBand = 0;
    if (thumbs.length) {
      let tallest = 0;
      for (const t of thumbs) { tallest = Math.max(tallest, t.h); }
      imgBand = tallest + IMAGE_GAP;
    }
    blocks.push({
      label: e.label, colors: e.colors, cols: gr.cols, rows: gr.rows,
      w: bw, h: bh, thumbs: thumbs, imgBand: imgBand,
    });
  }

  let rowImgBand = 0;
  for (const b of blocks) { rowImgBand = Math.max(rowImgBand, b.imgBand); }
  for (const b of blocks) {
    b.band = (orientation === "vertical" || orientation === "grid")
      ? rowImgBand : b.imgBand;
  }

  const bodyGap = orientation === "vertical" ? COLUMN_GAP : BLOCK_GAP;
  let bodyW;
  if (orientation === "vertical") {
    bodyW = 0;
    for (const b of blocks) { bodyW += b.w; }
    bodyW += bodyGap * (blocks.length - 1);
  } else {
    bodyW = 0;
    for (const b of blocks) { bodyW = Math.max(bodyW, b.w); }
  }

  for (const b of blocks) {
    b.blockH = captionBand + b.band + b.h + labelBand + stripBand;
  }

  let bodyH;
  if (orientation === "vertical") {
    bodyH = 0;
    for (const b of blocks) { bodyH = Math.max(bodyH, b.blockH); }
  } else {
    bodyH = 0;
    for (const b of blocks) { bodyH += b.blockH; }
    bodyH += bodyGap * (blocks.length - 1);
  }

  const titleBand = title ? (TITLE_SIZE + 28) : 8;
  const W = Math.trunc(MARGIN * 2 + bodyW);
  const H = Math.trunc(MARGIN * 2 + titleBand + bodyH);

  const spec = {
    w: W, h: H, dpi: dpi, doc_name: docName, bg: bg, shape: shape,
    orientation: orientation, margin: MARGIN, title_band: titleBand,
    palettes: [], title: null, texts: [],
  };

  if (title) {
    spec.title = {
      id: "title", text: title, cx: W / 2.0, y: MARGIN + TITLE_SIZE,
      size: TITLE_SIZE, color: contrastInk(bg), bold: true, dx: 0, dy: 0,
    };
  }

  let xCursor = MARGIN;
  let yCursor = MARGIN + titleBand;

  for (let pi = 0; pi < blocks.length; pi++) {
    const b = blocks[pi];
    let bx, by;
    if (orientation === "vertical") {
      bx = xCursor; by = yCursor;
      xCursor += b.w + COLUMN_GAP;
    } else {
      bx = MARGIN; by = yCursor;
      yCursor += b.blockH + BLOCK_GAP;
    }

    const pal = {
      label: b.label,
      layer_name: "Palette " + (pi + 1) + " - " + b.label,
      swatches: [], caption: null, strip: null, images: [],
    };

    if (captions) {
      pal.caption = {
        id: "cap:" + pi, text: String(b.label).toUpperCase(),
        cx: bx + b.w / 2.0, y: by + CAPTION_SIZE + 4, size: CAPTION_SIZE,
        color: DEFAULT_CAPTION_COLOR.slice(), bold: true, dx: 0, dy: 0,
      };
    }

    if (b.thumbs.length) {
      let rowW = IMAGE_GAP * (b.thumbs.length - 1);
      for (const t of b.thumbs) { rowW += t.w; }
      let tx = bx + (b.w - rowW) / 2.0;
      for (let ti = 0; ti < b.thumbs.length; ti++) {
        const t = b.thumbs[ti];
        pal.images.push({
          id: "img:" + pi + ":" + ti,
          x: Math.round(tx), y: Math.round(by + captionBand),
          w: t.w, h: t.h,
          name: "Image " + (pi + 1) + " - " + t.name,
          png: t.path, dx: 0, dy: 0, entry: t.entry,
        });
        tx += t.w + IMAGE_GAP;
      }
    }

    const gridTop = by + captionBand + b.band;
    for (let i = 0; i < b.colors.length; i++) {
      const col = i % b.cols;
      const row = Math.floor(i / b.cols);
      const sx = bx + col * (swatch + gap);
      const sy = gridTop + row * (swatch + gap);
      const entry = {
        id: "sw:" + pi + ":" + i,
        x: Math.round(sx), y: Math.round(sy),
        w: swatch, h: swatch, shape: shape,
        color: b.colors[i].slice(), hex: hexColor(b.colors[i]),
        dx: 0, dy: 0,
      };
      if (labels) {
        entry.label_cx = sx + swatch / 2.0;
        entry.label_y = sy + swatch + LABEL_SIZE + 4;
        entry.label_size = LABEL_SIZE;
        entry.label_color = contrastInk(bg);
        entry.label_font = null;
      }
      pal.swatches.push(entry);
    }

    if (gradients) {
      const stripY = gridTop + b.h + labelBand + STRIP_GAP;
      pal.strip = {
        id: "grad:" + pi, x: Math.round(bx), y: Math.round(stripY),
        w: b.w, h: STRIP_BAND,
        colors: b.colors.map(function (c) { return c.slice(); }),
        name: "Gradient " + (pi + 1) + " - " + b.label,
        dx: 0, dy: 0,
      };
    }

    spec.palettes.push(pal);
  }

  return spec;
}

function specFromEntries(entries, opts) {
  const colorsPer = Math.max(2, Math.min(16, Math.floor(opts.colors || 6)));
  const palettes = [];
  const images = [];

  if (opts.shared) {
    const pool = [];
    for (const e of entries) {
      for (const p of e.pixels) { pool.push(p); }
    }
    const colors = kmeans(pool, colorsPer);
    if (colors.length) {
      palettes.push({ label: opts.title || "All images", colors: colors });
      images.push(entries.map(function (e) {
        return { path: e.path, name: e.name, w: e.width, h: e.height, entry: e.entry };
      }));
    }
  } else {
    for (const e of entries) {
      const colors = kmeans(e.pixels, colorsPer);
      if (colors.length) {
        palettes.push({ label: e.name, colors: colors });
        images.push([{
          path: e.path, name: e.name, w: e.width, h: e.height, entry: e.entry,
        }]);
      }
    }
  }

  if (!palettes.length) {
    throw new Error("No colors found in the selected images.");
  }

  return planLayout(palettes, {
    shape: "square",
    orientation: "horizontal",
    cols: 4,
    swatch: 96,
    gap: 16,
    labels: true,
    gradients: true,
    captions: true,
    bg: DOC_BG_DEFAULT,
    title: opts.title || "",
    dpi: DPI_DEFAULT,
    doc_name: DOC_NAME,
    images: images,
  });
}

/* ------------------------------------------------------------------ */
/* grayscale color script template                                     */
/* ------------------------------------------------------------------ */

function templateColumns(v) {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) { return TEMPLATE_COLUMNS_DEFAULT; }
  return Math.max(TEMPLATE_COLUMNS_MIN, Math.min(TEMPLATE_COLUMNS_MAX, n));
}

function panelLabel(index) {
  const n = String(index);
  return n.length < 2 ? "0" + n : n;
}

function panelLayerName(index, stem) {
  return PANEL_PREFIX + panelLabel(index) + " - " + (stem || "image");
}

function panelNumberFromName(name) {
  const s = String(name || "");
  let m = /^Panel (\d+)(?: - .*)?$/.exec(s);
  if (m) { return parseInt(m[1], 10); }
  m = /^Emotion tint .* - Panel (\d+)(?: - [A-Za-z]+)?$/.exec(s);
  if (m) { return parseInt(m[1], 10); }
  return null;
}

function planTemplate(entries, opts) {
  opts = opts || {};
  const columns = templateColumns(opts.columns);
  const list = (entries || []).filter(function (e) { return e; });
  if (!list.length) { throw new Error("no images to lay out"); }
  const PW = opts.w || TEMPLATE_W;
  const PH = opts.h || TEMPLATE_H;

  const rows = Math.max(1, Math.ceil(list.length / columns));
  const innerW = PW - TEMPLATE_MARGIN * 2 - TEMPLATE_GAP * (columns - 1);
  const innerH = PH - TEMPLATE_MARGIN * 2 - TEMPLATE_GAP * (rows - 1);
  const cellW = innerW / columns;
  const cellH = innerH / rows;
  const panels = [];

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const iw = Math.max(1, Number(e.width) || 1);
    const ih = Math.max(1, Number(e.height) || 1);
    const scale = Math.min(cellW / iw, cellH / ih);
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));
    const col = i % columns;
    const row = Math.floor(i / columns);
    const cellX = TEMPLATE_MARGIN + col * (cellW + TEMPLATE_GAP);
    const cellY = TEMPLATE_MARGIN + row * (cellH + TEMPLATE_GAP);
    panels.push({
      id: "panel:" + i,
      index: i + 1,
      x: Math.round(cellX + (cellW - w) / 2),
      y: Math.round(cellY + (cellH - h) / 2),
      w: w, h: h,
      name: panelLayerName(i + 1, e.name),
      png: e.path,
      entry: e.entry,
    });
  }

  return {
    w: PW, h: PH, dpi: TEMPLATE_DPI,
    doc_name: TEMPLATE_DOC_NAME,
    bg: [255, 255, 255],
    columns: columns, rows: rows,
    panels: panels,
  };
}

/* ------------------------------------------------------------------ */
/* reading pixels from the selected files                              */
/* ------------------------------------------------------------------ */

function sameDocPath(doc, nativePath) {
  try {
    const p = doc && doc.path;
    if (!p) { return false; }
    const np = p.nativePath || p.fullPath || String(p);
    return String(np).toLowerCase() === String(nativePath).toLowerCase();
  } catch (e) {
    return false;
  }
}

async function readImageInfo(entry) {
  const nativePath = entry.nativePath || String(entry);
  let doc = null;
  let opened = false;

  for (let i = 0; i < app.documents.length; i++) {
    const d = app.documents[i];
    if (sameDocPath(d, nativePath)) { doc = d; break; }
  }
  if (!doc) {
    doc = await app.open(entry);
    opened = true;
  }

  const docName = fileStem(doc.name || entry.name);
  const width = Math.max(1, Math.round(Number(doc.width)));
  const height = Math.max(1, Math.round(Number(doc.height)));

  let data = null;
  let components = 3;
  let sw = 0, sh = 0;

  try {
    let target;
    if (width >= height) {
      target = {
        width: SAMPLE_LONG_SIDE,
        height: Math.max(1, Math.round(SAMPLE_LONG_SIDE * height / width)),
      };
    } else {
      target = {
        height: SAMPLE_LONG_SIDE,
        width: Math.max(1, Math.round(SAMPLE_LONG_SIDE * width / height)),
      };
    }
    const result = await imaging.getPixels({
      documentID: doc.id,
      targetSize: target,
      componentSize: 8,
      colorSpace: "RGB",
    });
    const imageData = result.imageData;
    components = imageData.components || 3;
    sw = imageData.width;
    sh = imageData.height;
    data = await imageData.getData({ chunky: true });
    imageData.dispose();
  } finally {
    if (opened) {
      try { await doc.close(constants.SaveOptions.DONOTSAVECHANGES); }
      catch (e) { console.error(e); }
    }
  }

  return {
    path: nativePath,
    name: docName,
    width: width,
    height: height,
    pixels: samplePixels(data, sw, sh, components),
    entry: entry,
  };
}

async function readImageMeta(entry) {
  const nativePath = entry.nativePath || String(entry);
  let doc = null;
  let opened = false;
  for (let i = 0; i < app.documents.length; i++) {
    const d = app.documents[i];
    if (sameDocPath(d, nativePath)) { doc = d; break; }
  }
  if (!doc) {
    doc = await app.open(entry);
    opened = true;
  }
  try {
    return {
      path: nativePath,
      name: fileStem(doc.name || entry.name),
      width: Math.max(1, Math.round(Number(doc.width))),
      height: Math.max(1, Math.round(Number(doc.height))),
      entry: entry,
    };
  } finally {
    if (opened) {
      try { await doc.close(constants.SaveOptions.DONOTSAVECHANGES); }
      catch (e) { console.error(e); }
    }
  }
}

/* ------------------------------------------------------------------ */
/* batchPlay primitives                                                */
/* ------------------------------------------------------------------ */

async function deselect() {
  try { await app.activeDocument.selection.deselect(); } catch (e) { /* ignore */ }
}

async function fillPoly(points, color) {
  const doc = app.activeDocument;
  await doc.selection.selectPolygon(points);
  await action.batchPlay(
    [
      {
        _obj: "fill",
        using: { _enum: "fillContents", _value: "color" },
        color: { _obj: "RGBColor", ...to255(color) },
        opacity: { _unit: "percentUnit", _value: 100 },
        mode: { _enum: "blendMode", _value: "normal" },
      },
    ],
    {}
  );
  await deselect();
}

async function fillRect(x, y, w, h, color) {
  const doc = app.activeDocument;
  await doc.selection.selectRectangle({ top: y, left: x, bottom: y + h, right: x + w });
  await action.batchPlay(
    [
      {
        _obj: "fill",
        using: { _enum: "fillContents", _value: "color" },
        color: { _obj: "RGBColor", ...to255(color) },
        opacity: { _unit: "percentUnit", _value: 100 },
        mode: { _enum: "blendMode", _value: "normal" },
      },
    ],
    {}
  );
  await deselect();
}

async function addLayer(name) {
  const [r] = await action.batchPlay(
    [
      {
        _obj: "make",
        _target: [{ _ref: "layer" }],
        using: { _obj: "layer", name: name || "Layer" },
      },
    ],
    {}
  );
  return r.layerID || r._ID;
}

async function selectLayer(id) {
  const layer = findLayerById(app.activeDocument, id);
  if (layer) {
    app.activeDocument.activeLayers = [layer];
    return;
  }
  await action.batchPlay(
    [{ _obj: "select", _target: { _ref: "layer", _id: id } }],
    {}
  );
}

async function selectLayers(ids) {
  const layers = (ids || [])
    .map(function (id) { return findLayerById(app.activeDocument, id); })
    .filter(function (l) { return !!l; });
  if (layers.length) {
    app.activeDocument.activeLayers = layers;
    return;
  }
  if (ids && ids.length) {
    await action.batchPlay(
      ids.map(function (id) { return { _obj: "select", _target: { _ref: "layer", _id: id }, _options: { addToSelection: true } }; }),
      {}
    );
  }
}

async function renameLayer(id, name) {
  const layer = findLayerById(app.activeDocument, id);
  if (layer) {
    layer.name = name;
    return;
  }
  await action.batchPlay(
    [{ _obj: "set", _target: { _ref: "layer", _id: id }, to: { _obj: "layer", name } }],
    {}
  );
}

async function moveBelow(id, targetId) {
  const doc = app.activeDocument;
  const layer = findLayerById(doc, id);
  const target = findLayerById(doc, targetId);
  if (layer && target && typeof layer.move === "function") {
    // UXP DOM: PLACEAFTER puts the layer directly below relativeObject.
    await layer.move(target, constants.ElementPlacement.PLACEAFTER);
    return;
  }
  await action.batchPlay(
    [
      {
        _obj: "move",
        _target: { _ref: "layer", _id: id },
        to: { _ref: "layer", _id: targetId, _enum: "ordinal", _value: "below" },
      },
    ],
    {}
  );
}

async function moveAbove(id, targetId) {
  const doc = app.activeDocument;
  const layer = findLayerById(doc, id);
  const target = findLayerById(doc, targetId);
  if (layer && target && typeof layer.move === "function") {
    // UXP DOM: PLACEBEFORE puts the layer directly above relativeObject.
    await layer.move(target, constants.ElementPlacement.PLACEBEFORE);
    return;
  }
  await action.batchPlay(
    [
      {
        _obj: "move",
        _target: { _ref: "layer", _id: id },
        to: { _ref: "layer", _id: targetId, _enum: "ordinal", _value: "above" },
      },
    ],
    {}
  );
}

function findLayerById(doc, id) {
  function walk(layers) {
    for (const l of (layers || [])) {
      if (l.id === id) { return l; }
      if (l.layers && l.layers.length) {
        const hit = walk(l.layers);
        if (hit) { return hit; }
      }
    }
    return null;
  }
  return walk(doc ? doc.layers : []);
}

async function rasterizeLayer(id) {
  try {
    const layer = findLayerById(app.activeDocument, id);
    if (layer && typeof layer.rasterize === "function") {
      await layer.rasterize();
      return;
    }
  } catch (e) {
    console.error(e);
  }
  try {
    await action.batchPlay(
      [{ _obj: "rasterizeLayer", _target: { _ref: "layer", _id: id } }],
      {}
    );
  } catch (e) {
    console.error(e);
  }
}

/* Remove the colour from one pixel layer (Image > Adjustments > Desaturate). */
async function desaturateLayer(id) {
  await selectLayer(id);
  await action.batchPlay([{ _obj: "desaturate" }], {});
}

function readDesaturateOption() {
  const el = document.getElementById("optDesaturate");
  return !!(el && el.checked);
}

async function addText(contents, x, y, sizePx, color, bold, centered, name) {
  const doc = app.activeDocument;
  const ptSize = (sizePx * 72) / (doc.resolution || DPI_DEFAULT);
  const SolidColor = app.SolidColor;
  const ink = new SolidColor();
  ink.rgb.red = color[0];
  ink.rgb.green = color[1];
  ink.rgb.blue = color[2];

  const layer = await doc.createTextLayer({
    name: name || contents || "Text",
    contents: contents || "",
    fontSize: ptSize,
    textColor: ink,
  });

  const ti = layer.textItem;
  ti.characterStyle.size = ptSize;
  ti.characterStyle.fauxBold = !!bold;
  ti.paragraphStyle.justification = centered
    ? constants.Justification.CENTER
    : constants.Justification.LEFT;

  try {
    const b = layer.boundsNoEffects || layer.bounds;
    const dx = x - (b.left + b.right) / 2;
    const dy = y - (b.top + b.bottom) / 2;
    if (dx || dy) { await layer.translate(dx, dy); }
  } catch (e) {
    console.error(e);
  }
  return layer.id;
}

function fileUrl(p) {
  // Normalize Windows paths to file:/ URLs
  let s = String(p).replace(/\\/g, "/");
  if (s.match(/^[A-Za-z]:\//)) s = "/" + s;
  return "file:" + s;
}

async function entryForPath(p) {
  const url = fileUrl(p);
  try {
    return await fs.getEntryWithUrl(url);
  } catch (e) {
    // Try without leading slash
    return fs.getEntryWithUrl("file:" + String(p).replace(/\\/g, "/"));
  }
}

function boundEdge(desc, edge) {
  const b = desc && desc.bounds ? desc.bounds : null;
  const v = b ? b[edge] : null;
  if (v === null || v === undefined) { return NaN; }
  return typeof v === "object" ? Number(v._value) : Number(v);
}

async function layerBoundsById(id) {
  const [b] = await action.batchPlay(
    [{ _obj: "get", _target: { _ref: "layer", _id: id }, _property: "bounds" }],
    {}
  );
  return {
    left: boundEdge(b, "left"),
    top: boundEdge(b, "top"),
    right: boundEdge(b, "right"),
    bottom: boundEdge(b, "bottom"),
  };
}

/* Fallback placement: open the file and duplicate its (flattened) layer into
   the active document. Works even when Photoshop refuses placeEvent/session
   tokens for a path that the plugin was not given as a File entry. */
async function placeByOpen(entry, x, y, w, h, name) {
  const target = app.activeDocument;
  const nativePath = entry.nativePath || String(entry);
  let src = null;
  let opened = false;
  let temp = null;

  for (let i = 0; i < app.documents.length; i++) {
    const d = app.documents[i];
    if (sameDocPath(d, nativePath)) { src = d; break; }
  }
  if (!src) {
    src = await app.open(entry);
    opened = true;
  }

  try {
    let source = src;
    if (src.layers.length > 1) {
      if (opened) {
        await src.flatten();
      } else if (typeof src.duplicate === "function") {
        temp = await src.duplicate();
        await temp.flatten();
        source = temp;
      } else {
        throw new Error("Close " + (entry.name || nativePath) +
          " first: it is open with multiple layers.");
      }
    }
    const srcLayer = source.layers[0];
    if (!srcLayer) {
      throw new Error("No image layer in " + (entry.name || nativePath));
    }

    const placed = await srcLayer.duplicate(
      target,
      constants.ElementPlacement.PLACEATBEGINNING,
      name || "Placed"
    );
    const b = placed.boundsNoEffects || placed.bounds;
    const cw = Number(b.right) - Number(b.left);
    const ch = Number(b.bottom) - Number(b.top);
    if (w && h && cw > 0 && ch > 0) {
      await placed.scale(
        (w / cw) * 100,
        (h / ch) * 100,
        constants.AnchorPosition.TOPLEFT
      );
      const b2 = placed.boundsNoEffects || placed.bounds;
      const dx = (x || 0) - Number(b2.left);
      const dy = (y || 0) - Number(b2.top);
      if (dx || dy) { await placed.translate(dx, dy); }
    }
    return placed.id;
  } finally {
    if (temp) {
      try {
        app.activeDocument = temp;
        await temp.close(constants.SaveOptions.DONOTSAVECHANGES);
      } catch (e) { console.error(e); }
    }
    if (opened) {
      try {
        app.activeDocument = src;
        await src.close(constants.SaveOptions.DONOTSAVECHANGES);
      } catch (e) { console.error(e); }
    }
    if (target) {
      try { app.activeDocument = target; } catch (e) { /* ignore */ }
    }
  }
}

async function placePng(path, x, y, w, h, name, entry) {
  // Reuse the File entry the user picked: UXP only grants read access to
  // entries from the picker, not to a URL reconstructed from the path.
  const source = entry || await entryForPath(path);
  let id = null;

  try {
    const token = await fs.createSessionToken(source);
    const [r] = await action.batchPlay(
      [
        {
          _obj: "placeEvent",
          null: { _path: token, _kind: "local" },
          freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
          offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      {}
    );
    id = r && (r.layerID || (Array.isArray(r.ID) ? r.ID[0] : r.ID) || r._ID);
    if (!id) { throw new Error("placeEvent returned no layer id"); }
  } catch (e) {
    console.error("placeEvent failed; opening and duplicating the file instead", e);
    id = await placeByOpen(source, x, y, w, h, name);
  }

  const placed = findLayerById(app.activeDocument, id);
  if (placed && typeof placed.scale === "function" && typeof placed.translate === "function") {
    try {
      const b = placed.boundsNoEffects || placed.bounds;
      const cw = Number(b.right) - Number(b.left);
      const ch = Number(b.bottom) - Number(b.top);
      if (w && h && cw > 0 && ch > 0 &&
        (Math.round(cw) !== Math.round(w) || Math.round(ch) !== Math.round(h))) {
        await placed.scale(
          (w / cw) * 100,
          (h / ch) * 100,
          constants.AnchorPosition.TOPLEFT
        );
      }
      const b2 = placed.boundsNoEffects || placed.bounds;
      const dx = (x || 0) - Number(b2.left);
      const dy = (y || 0) - Number(b2.top);
      if (dx || dy) { await placed.translate(dx, dy); }
    } catch (e) {
      console.error("could not size/position the placed image", e);
    }
  } else {
    try {
      const b = await layerBoundsById(id);
      const cw = b.right - b.left;
      const ch = b.bottom - b.top;
      if (w && h && cw > 0 && ch > 0 && (Math.round(cw) !== w || Math.round(ch) !== h)) {
        await action.batchPlay(
          [
            {
              _obj: "transform",
              _target: { _ref: "layer", _id: id },
              freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
              width: { _unit: "percentUnit", _value: (w / cw) * 100 },
              height: { _unit: "percentUnit", _value: (h / ch) * 100 },
            },
          ],
          {}
        );
      }
      const b2 = await layerBoundsById(id);
      const dx = (x || 0) - b2.left;
      const dy = (y || 0) - b2.top;
      if (dx || dy) {
        await action.batchPlay(
          [
            {
              _obj: "move",
              _target: { _ref: "layer", _id: id },
              to: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
              offset: {
                _obj: "offset",
                horizontal: { _unit: "pixelsUnit", _value: dx },
                vertical: { _unit: "pixelsUnit", _value: dy },
              },
            },
          ],
          {}
        );
      }
    } catch (e) {
      console.error(e);
    }
  }
  if (name) { try { await renameLayer(id, name); } catch (e) {} }
  return id;
}


/* Place a layered PSD/PSB as a group named like a panel, keeping its layers.
   The group is scaled and moved to fit (x, y, w, h) like a flat panel. */
async function placePsdLayers(entry, x, y, w, h, name) {
  const target = app.activeDocument;
  const nativePath = entry.nativePath || String(entry);
  let src = null, opened = false;
  for (let i = 0; i < app.documents.length; i++) {
    if (sameDocPath(app.documents[i], nativePath)) { src = app.documents[i]; break; }
  }
  if (!src) { src = await app.open(entry); opened = true; }
  try {
    app.activeDocument = target;
    const group = await target.createLayerGroup({ name: name || "Panel" });
    const copied = [];
    const srcLayers = src.layers.slice();
    for (let i = srcLayers.length - 1; i >= 0; i--) {
      const l = srcLayers[i];
      try {
        app.activeDocument = src;
        const dup = await l.duplicate(target, constants.ElementPlacement.PLACEATBEGINNING);
        app.activeDocument = target;
        try { await dup.move(group, constants.ElementPlacement.PLACEINSIDE); } catch (e) { console.error(e); }
        copied.push(dup);
      } catch (e) { console.error("PSD layer " + l.name + " skipped:", e); }
    }
    app.activeDocument = target;
    const b = group.boundsNoEffects || group.bounds;
    const cw = Number(b.right) - Number(b.left), ch = Number(b.bottom) - Number(b.top);
    if (w && h && cw > 0 && ch > 0) {
      const scale = Math.min(w / cw, h / ch);
      target.activeLayers = [group];
      await group.scale(scale * 100, scale * 100, constants.AnchorPosition.TOPLEFT);
      const b2 = group.boundsNoEffects || group.bounds;
      const dx = (x || 0) - Number(b2.left), dy = (y || 0) - Number(b2.top);
      if (dx || dy) { await group.translate(dx, dy); }
    }
    return { id: group.id, layers: copied.length };
  } finally {
    if (opened) {
      try { app.activeDocument = src; await src.close(constants.SaveOptions.DONOTSAVECHANGES); } catch (e) { console.error(e); }
    }
    try { app.activeDocument = target; } catch (e) { /* ignore */ }
  }
}

function isLayeredSource(entry) {
  return /\.(psd|psb)$/i.test(String((entry && entry.name) || entry || ""));
}

function readKeepPsdOption() {
  const el = document.getElementById("optKeepPsd");
  return !!(el && el.checked);
}

/* Paint a gradient strip straight into a pixel layer. */
async function paintGradient(doc, layerId, x, y, w, h, colors) {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  const buf = new Uint8Array(width * height * 3);
  const n = colors.length;

  for (let px = 0; px < width; px++) {
    let col;
    if (n === 0) {
      col = [0, 0, 0];
    } else if (n === 1) {
      col = colors[0];
    } else {
      const t = (px / Math.max(1, width - 1)) * (n - 1);
      const i = Math.min(n - 2, Math.floor(t));
      const k = t - i;
      const a = colors[i], b = colors[i + 1];
      col = [
        Math.round(a[0] + (b[0] - a[0]) * k),
        Math.round(a[1] + (b[1] - a[1]) * k),
        Math.round(a[2] + (b[2] - a[2]) * k),
      ];
    }
    for (let py = 0; py < height; py++) {
      const o = (py * width + px) * 3;
      buf[o] = col[0];
      buf[o + 1] = col[1];
      buf[o + 2] = col[2];
    }
  }

  const imageData = await imaging.createImageDataFromBuffer(buf, {
    width: width,
    height: height,
    components: 3,
    chunky: true,
    colorSpace: "RGB",
  });
  try {
    await imaging.putPixels({
      documentID: doc.id,
      layerID: layerId,
      imageData: imageData,
      replace: false,
      targetBounds: { left: Math.round(x), top: Math.round(y) },
      commandName: "Gradient strip",
    });
  } finally {
    imageData.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* emotion colorize                                                    */
/* ------------------------------------------------------------------ */

function rampColor(colors, t) {
  const n = colors.length;
  if (!n) { return [0, 0, 0]; }
  if (n === 1) { return colors[0]; }
  const x = Math.max(0, Math.min(1, t)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  const k = x - i;
  const a = colors[i], b = colors[i + 1];
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

function buildTintLut(colors) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const c = rampColor(colors, i / 255);
    lut[i * 3] = Math.round(c[0]);
    lut[i * 3 + 1] = Math.round(c[1]);
    lut[i * 3 + 2] = Math.round(c[2]);
  }
  return lut;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/* HSL uses h in degrees, s/l in 0..1 (only used to vary the mood ramps). */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) { h = (g - b) / d; }
    else if (max === g) { h = (b - r) / d + 2; }
    else { h = (r - g) / d + 4; }
    h *= 60;
    if (h < 0) { h += 360; }
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = clamp01(s);
  l = clamp01(l);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function jitter(span) {
  return (Math.random() * 2 - 1) * span;
}

/* Nudge every stop of a mood ramp by the same small hue/sat/light shift, then
 * add a little per-stop wobble. The result stays recognizably that mood but
 * differs each time a button is pressed. */
function randomEmotionPalette(colors, range) {
  range = (range === undefined || range === null) ? 100 : range;
  const rangeScale = range / 100;
  const hueShift = jitter(MOOD_HUE_SHIFT * rangeScale);
  const hueTilt = jitter(MOOD_HUE_TILT * rangeScale);
  const satScale = 1 + jitter(MOOD_SAT_SCALE * rangeScale);
  const lightShift = jitter(MOOD_LIGHT_SHIFT * rangeScale);
  const last = Math.max(1, colors.length - 1);
  let prevL = -1;
  return colors.map(function (c, i) {
    const hsl = rgbToHsl(c[0], c[1], c[2]);
    const t = colors.length <= 1 ? 0 : (i / last) * 2 - 1;
    const h = hsl[0] + hueShift + hueTilt * t + jitter(MOOD_HUE_JITTER * rangeScale);
    const s = clamp01(hsl[1] * satScale + jitter(MOOD_SAT_JITTER * rangeScale));
    let l = clamp01(hsl[2] + lightShift + jitter(MOOD_LIGHT_JITTER * rangeScale));
    if (l < prevL) { l = prevL; }
    prevL = l;
    return hslToRgb(h, s, l);
  });
}

/* A row should read as one mood, not four different ones. Keep the base ramp
 * and add a gentle left-to-right hue drift plus a tiny per-panel wobble. */
function varyEmotionPalette(colors, index, count) {
  const n = Math.max(1, Number(count) || 1);
  const t = n <= 1 ? 0 : (Math.max(0, Math.min(n - 1, index)) / (n - 1)) * 2 - 1;
  const hueShift = t * ROW_HUE_SPREAD + jitter(1.2);
  const satScale = 1 + t * ROW_SAT_SPREAD + jitter(0.018);
  const lightShift = t * ROW_LIGHT_SPREAD + jitter(0.01);
  let prevL = -1;
  return colors.map(function (c) {
    const hsl = rgbToHsl(c[0], c[1], c[2]);
    const h = hsl[0] + hueShift + jitter(0.8);
    const s = clamp01(hsl[1] * satScale + jitter(0.015));
    let l = clamp01(hsl[2] + lightShift + jitter(0.008));
    if (l < prevL) { l = prevL; }
    prevL = l;
    return hslToRgb(h, s, l);
  });
}

function paletteText(colors) {
  return colors.map(hexColor).join(" ");
}

function modeIsGray(mode) {
  return mode === "grayscaleMode" || mode === "bitmapMode" || mode === "duotoneMode";
}

/* Sample the composite and decide whether it is effectively grayscale.
 * Transparent pixels are ignored; a few colored pixels (e.g. a signature)
 * are tolerated. */
function isEffectivelyGray(data, w, h, components) {
  const count = w * h;
  if (!count) { return true; }
  const stride = Math.max(1, Math.floor(count / GRAY_SAMPLE_TARGET));
  let sampled = 0, colored = 0;
  for (let i = 0; i < count; i += stride) {
    const si = i * components;
    let r, g, b, a = 255;
    if (components === 1) {
      r = g = b = data[si];
    } else if (components === 2) {
      r = g = b = data[si];
      a = data[si + 1];
    } else {
      r = data[si];
      g = data[si + 1];
      b = data[si + 2];
      a = components >= 4 ? data[si + 3] : 255;
    }
    if (a < 8) { continue; }
    sampled++;
    if (Math.max(r, g, b) - Math.min(r, g, b) > GRAY_CHROMA_MAX) { colored++; }
  }
  if (!sampled) { return true; }
  return colored <= Math.max(1, Math.floor(sampled * GRAY_COLORED_FRACTION));
}

/* Map luminance through the LUT; keeps the source alpha so cut-outs stay cut out. */
function colorizePixels(data, w, h, components, colors) {
  const lut = buildTintLut(colors);
  const count = w * h;
  const out = new Uint8Array(count * 4);
  for (let i = 0, o = 0; i < count; i++, o += 4) {
    const si = i * components;
    let r, g, b, a = 255;
    if (components === 1) {
      r = g = b = data[si];
    } else if (components === 2) {
      r = g = b = data[si];
      a = data[si + 1];
    } else {
      r = data[si];
      g = data[si + 1];
      b = data[si + 2];
      a = components >= 4 ? data[si + 3] : 255;
    }
    const lum = (54 * r + 183 * g + 19 * b) >> 8;
    const c = lum * 3;
    out[o] = lut[c];
    out[o + 1] = lut[c + 1];
    out[o + 2] = lut[c + 2];
    out[o + 3] = a;
  }
  return out;
}

function collectTintLayers(layers, out) {
  for (const l of (layers || [])) {
    if (l.name && l.name.indexOf(TINT_PREFIX) === 0) {
      out.push(l);
    } else if (l.layers && l.layers.length) {
      collectTintLayers(l.layers, out);
    }
  }
  return out;
}

async function removeTintLayers(doc) {
  const doomed = collectTintLayers(doc.layers, []);
  let removed = 0;
  for (const l of doomed) {
    try { await l.delete(); removed++; } catch (e) { console.error(e); }
  }
  return removed;
}

function listPanelLayers(doc) {
  const out = [];
  function walk(layers) {
    for (const l of (layers || [])) {
      if (/^Panel \d+(?: - .*)?$/.test(String(l.name || ""))) {
        out.push(l);
      } else if (l.layers && l.layers.length) {
        walk(l.layers);
      }
    }
  }
  walk(doc ? doc.layers : []);
  out.sort(function (a, b) {
    return (panelNumberFromName(a.name) || 0) - (panelNumberFromName(b.name) || 0);
  });
  return out;
}

/* Group the template's Panel NN layers into visual rows using their vertical
 * centres. Image heights differ with aspect ratio, but a row shares one centre,
 * so this also works after the file has been closed and reopened. */
function panelRows(doc) {
  const panels = listPanelLayers(doc);
  if (!panels.length) { return []; }

  const items = [];
  const heights = [];
  for (const layer of panels) {
    const b = layer.boundsNoEffects || layer.bounds;
    if (!b) { continue; }
    const top = Number(b.top);
    const bottom = Number(b.bottom);
    const h = Math.abs(bottom - top);
    items.push({
      layer: layer,
      index: panelNumberFromName(layer.name) || 0,
      name: String(layer.name || ""),
      cy: (top + bottom) / 2,
      h: h,
    });
    heights.push(h);
  }
  if (!items.length) { return []; }
  heights.sort(function (a, b) { return a - b; });
  const medianH = heights[Math.floor(heights.length / 2)] || 1;
  const tolerance = Math.max(PANEL_ROW_TOLERANCE_MIN, medianH * 0.35);

  items.sort(function (a, b) { return a.index - b.index; });
  const rows = [];
  for (const item of items) {
    let best = null;
    let bestDist = Infinity;
    for (const row of rows) {
      const d = Math.abs(row.cy - item.cy);
      if (d < bestDist) { best = row; bestDist = d; }
    }
    if (!best || bestDist > tolerance) {
      best = { cy: item.cy, panels: [] };
      rows.push(best);
    }
    best.panels.push(item);
    best.cy = best.panels.reduce(function (sum, p) { return sum + p.cy; }, 0) /
      best.panels.length;
  }

  rows.sort(function (a, b) { return a.cy - b.cy; });
  for (let i = 0; i < rows.length; i++) {
    rows[i].number = i + 1;
    rows[i].panels.sort(function (a, b) {
      return a.index - b.index;
    });
  }
  return rows;
}

function findRowForPanel(rows, index) {
  const want = Number(index);
  for (const row of (rows || [])) {
    for (const p of row.panels) {
      if (p.index === want) { return row; }
    }
  }
  return null;
}

function findPanelImage(doc, index) {
  const want = Number(index);
  function walk(layers) {
    for (const l of (layers || [])) {
      if (panelNumberFromName(l.name) === want &&
          /^Panel \d+/.test(String(l.name || ""))) {
        return l;
      }
      if (l.layers && l.layers.length) {
        const hit = walk(l.layers);
        if (hit) { return hit; }
      }
    }
    return null;
  }
  return walk(doc ? doc.layers : []);
}

function selectedPanel(doc) {
  if (!doc || !doc.activeLayers || !doc.activeLayers.length) {
    return { error: "none" };
  }
  const picked = [];
  for (let i = 0; i < doc.activeLayers.length; i++) {
    const l = doc.activeLayers[i];
    const idx = panelNumberFromName(l.name);
    if (idx !== null) { picked.push({ layer: l, index: idx }); }
  }
  if (!picked.length) { return { error: "none" }; }
  if (picked.length > 1) { return { error: "multiple" }; }
  const image = findPanelImage(doc, picked[0].index);
  if (!image) { return { error: "noImage" }; }
  return { index: picked[0].index, layer: image };
}

function rememberPanelPick(doc, index, additive) {
  if (!doc || !index) { return; }
  const entry = { docId: doc.id, index: Number(index) };
  if (!additive) { panelPicks = [entry]; }
  else {
    const existing = panelPicks.findIndex(function (p) {
      return p.docId === doc.id && p.index === entry.index;
    });
    if (existing >= 0) { panelPicks.splice(existing, 1); }
    else { panelPicks.push(entry); }
  }
  if (!panelPicks.length) { panelPicks = [entry]; }
}

/* Layers-panel selection wins when it points at a panel/tint. Otherwise fall
 * back to the thumbnail the user clicked in this panel. */
function resolvePanel(doc) {
  const picked = selectedPanel(doc);
  if (picked && !picked.error) {
    rememberPanelPick(doc, picked.index, false);
    return picked;
  }
  if (picked && picked.error !== "none") { return picked; }
  const remembered = panelPicks.find(function (p) { return p.docId === doc.id; });
  if (remembered) {
    const layer = findPanelImage(doc, remembered.index);
    if (layer) { return { index: remembered.index, layer: layer }; }
  }
  return picked || { error: "none" };
}

function readRowMode() {
  const el = document.getElementById("optEmotionRow");
  return !!(el && el.checked);
}

async function removePanelTintLayers(doc, panelNo) {
  const want = Number(panelNo);
  const doomed = collectTintLayers(doc.layers, []).filter(function (l) {
    return panelNumberFromName(l.name) === want;
  });
  let removed = 0;
  for (const l of doomed) {
    try { await l.delete(); removed++; } catch (e) { console.error(e); }
  }
  return removed;
}

function panelTintName(label, panelNo) {
  return TINT_PREFIX + " - " + label + " - Panel " + panelLabel(panelNo);
}

function readStrength() {
  const el = document.getElementById("optEmotionStrength");
  let v = el ? parseInt(el.value, 10) : 100;
  if (!isFinite(v)) { v = 100; }
  return Math.max(0, Math.min(100, v));
}

function readColorRange() {
  const el = document.getElementById("optColorRange");
  let v = el ? parseInt(el.value, 10) : 100;
  if (!isFinite(v)) { v = 100; }
  return Math.max(0, Math.min(200, v));
}

function readGradientOption() {
  const el = document.getElementById("optGradientMap");
  return el ? !!el.checked : true;
}

function updateEmotionSwatches(colors) {
  const row = document.getElementById("emoSwatches");
  if (!row) { return; }
  const kids = row.children;
  for (let i = 0; i < kids.length && i < colors.length; i++) {
    kids[i].style.backgroundColor = hexColor(colors[i]);
  }
}

function setEmotionBusy(busy) {
  emotionBusy = !!busy;
  for (const id of EMOTION_BUTTON_IDS) {
    const b = document.getElementById(id);
    if (b) { b.disabled = !!busy; }
  }
  const imp = document.getElementById("btnImportGray");
  if (imp) { imp.disabled = !!busy; }
  const tpl = document.getElementById("btnTemplate");
  if (tpl) { tpl.disabled = !!busy; }
  const refresh = document.getElementById("btnRefreshPanels");
  if (refresh) { refresh.disabled = !!busy; }
  for (const b of document.querySelectorAll(".btn.mood")) { b.disabled = !!busy; }
  for (const node of panelChipNodes) {
    if (node.el) { node.el.disabled = !!busy; }
  }
}

function clearNode(node) {
  while (node && node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function panelDisplayName(layer) {
  const s = String((layer && layer.name) || "image");
  return s.replace(/^Panel \d+(?: - )?/, "") || s;
}

function panelThumbKey(doc, layer) {
  return String(doc.id) + ":" + String(layer.id);
}

function applyPanelThumbCache() {
  for (const node of panelChipNodes) {
    if (!node.img) { continue; }
    const url = panelThumbCache[node.key];
    if (url) {
      node.img.src = url;
      node.img.style.display = "block";
    }
  }
}

async function loadPanelThumbnails(doc, items) {
  const updates = [];
  try {
    await core.executeAsModal(
      async () => {
        for (const item of items) {
          let imageData = null;
          try {
            const b = item.layer.boundsNoEffects || item.layer.bounds;
            if (!b) { continue; }
            const w = Math.max(1, Number(b.right) - Number(b.left));
            const h = Math.max(1, Number(b.bottom) - Number(b.top));
            const scale = Math.min(PANEL_THUMB_W / w, PANEL_THUMB_H / h, 1);
            const result = await imaging.getPixels({
              documentID: doc.id,
              layerID: item.layer.id,
              targetSize: {
                width: Math.max(1, Math.round(w * scale)),
                height: Math.max(1, Math.round(h * scale)),
              },
              componentSize: 8,
              colorSpace: "RGB",
              applyAlpha: true,
            });
            imageData = result.imageData;
            const jpeg = await imaging.encodeImageData({
              imageData: imageData,
              base64: true,
            });
            updates.push({
              key: panelThumbKey(doc, item.layer),
              url: "data:image/jpeg;base64," + jpeg,
            });
          } catch (e) {
            console.error("Panel thumbnail failed for Panel " +
              panelLabel(item.index) + ":", e);
          } finally {
            if (imageData) { imageData.dispose(); }
          }
        }
      },
      { commandName: "Color Script: panel thumbnails" }
    );
  } catch (e) {
    console.error("Panel thumbnails failed:", e);
  }
  for (const update of updates) {
    panelThumbCache[update.key] = update.url;
  }
  return updates;
}

function renderPanelPicker(doc, rows) {
  const list = document.getElementById("panelList");
  const summary = document.getElementById("panelSummary");
  panelChipNodes = [];

  if (summary) {
    const columns = rows.length ? rows[0].panels.length : 0;
    summary.textContent = rows.length
      ? rows.reduce(function (n, r) { return n + r.panels.length; }, 0) +
        " panels | " + rows.length + " row" + (rows.length === 1 ? "" : "s") +
        " | " + columns + " column" + (columns === 1 ? "" : "s")
      : "No template panels found. Open a Color Script Template.";
  }
  if (!list) { return; }
  clearNode(list);

  for (const row of rows) {
    const block = document.createElement("div");
    block.className = "panel-row-block";

    const head = document.createElement("div");
    head.className = "panel-row-head";
    const label = document.createElement("div");
    label.className = "panel-row-label";
    label.textContent = "Row " + row.number;
    head.appendChild(label);
    const rowBtn = document.createElement("button");
    rowBtn.type = "button";
    rowBtn.className = "link-btn";
    rowBtn.textContent = "Select row";
    (function (n) { rowBtn.addEventListener("click", function () { pickRow(n); }); })(row.number);
    head.appendChild(rowBtn);
    block.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "panel-grid";
    for (const item of row.panels) {
      const key = panelThumbKey(doc, item.layer);
      const chip = document.createElement("div");
      chip.className = "panel-chip" +
        (panelPicks.some(function (p) { return p.docId === doc.id && p.index === item.index; })
          ? " on" : "");
      chip.title = item.name;
      chip.style.cursor = "pointer";
      const idx = item.index;

      const checkWrap = document.createElement("span");
      checkWrap.className = "panel-check check";
      const checkBox = document.createElement("span");
      checkBox.className = "box";
      checkWrap.appendChild(checkBox);
      const isSelected = panelPicks.some(function (p) { return p.docId === doc.id && p.index === item.index; });
      if (isSelected) { checkWrap.classList.add("on"); }
      checkWrap.addEventListener("click", function (e) {
        e.stopPropagation();
        if (e.shiftKey && lastPickIndex !== null && lastPickIndex !== idx) {
          // Shift+click: every panel between the last click and this one.
          const lo = Math.min(lastPickIndex, idx), hi = Math.max(lastPickIndex, idx);
          const range = [];
          for (const r of rows) { for (const it of r.panels) { if (it.index >= lo && it.index <= hi) { range.push(it.index); } } }
          const keep = panelPicks.filter(function (p) { return p.docId === doc.id; }).map(function (p) { return p.index; });
          for (const n of range) { if (keep.indexOf(n) < 0) { keep.push(n); } }
          setPanelPicks(doc, keep.sort(function (a, b) { return a - b; }));
          return;
        }
        lastPickIndex = idx;
        const nowChecked = !checkWrap.classList.contains("on");
        if (nowChecked) { checkWrap.classList.add("on"); }
        else { checkWrap.classList.remove("on"); }
        if (nowChecked) {
          if (!panelPicks.some(function (p) { return p.docId === doc.id && p.index === idx; })) {
            panelPicks.push({ docId: doc.id, index: idx });
          }
        } else {
          panelPicks = panelPicks.filter(function (p) {
            return !(p.docId === doc.id && p.index === idx);
          });
        }
        const layer = findPanelImage(doc, idx);
        core.executeAsModal(
          async () => {
            app.activeDocument = doc;
            if (nowChecked && layer) {
              const layers = panelPicks
                .filter(function (p) { return p.docId === doc.id; })
                .map(function (p) { return findPanelImage(doc, p.index); })
                .filter(function (l) { return !!l; });
              await selectLayers(layers.map(function (l) { return l.id; }));
            } else {
              const remaining = panelPicks
                .filter(function (p) { return p.docId === doc.id; })
                .map(function (p) { return findPanelImage(doc, p.index); })
                .filter(function (l) { return !!l; });
              if (remaining.length) {
                await selectLayers(remaining.map(function (l) { return l.id; }));
              } else {
                app.activeDocument.activeLayers = [];
              }
            }
          },
          { commandName: "Color Script: toggle panel " + panelLabel(idx) }
        ).catch(function (e) { console.error(e); });
        chip.className = "panel-chip" + (nowChecked ? " on" : "");
        const count = panelPicks.filter(function (p) { return p.docId === doc.id; }).length;
        setStatus(
          count
            ? count + " panel" + (count === 1 ? "" : "s") + " selected. Choose a mood to color them."
            : "No panels selected.",
          "ok"
        );
      });
      chip.appendChild(checkWrap);

      chip.addEventListener("click", function (e) {
        if (e.target === checkWrap || (e.target && e.target.classList && e.target.classList.contains("box"))) { return; }
        onPanelChipClick(idx, e);
      });

      const thumb = document.createElement("span");
      thumb.className = "panel-thumb";
      const fallback = document.createElement("span");
      fallback.className = "panel-thumb-fallback";
      fallback.textContent = panelLabel(item.index);
      thumb.appendChild(fallback);

      const img = document.createElement("img");
      img.className = "panel-thumb-img";
      img.style.display = "none";
      if (panelThumbCache[key]) {
        img.src = panelThumbCache[key];
        img.style.display = "block";
      }
      thumb.appendChild(img);
      chip.appendChild(thumb);

      const meta = document.createElement("span");
      meta.className = "panel-meta";
      const num = document.createElement("span");
      num.className = "panel-num";
      num.textContent = "Panel " + panelLabel(item.index);
      const name = document.createElement("span");
      name.className = "panel-name";
      name.textContent = panelDisplayName(item.layer);
      meta.appendChild(num);
      meta.appendChild(name);
      chip.appendChild(meta);

      grid.appendChild(chip);
      panelChipNodes.push({ index: item.index, el: chip, img: img, key: key });
    }
    block.appendChild(grid);
    list.appendChild(block);
  }
}

function syncPanelPickerSelection(doc, index, additive) {
  if (doc && index) { rememberPanelPick(doc, index, additive); }
  for (const node of panelChipNodes) {
    node.el.className = "panel-chip" +
      (doc && panelPicks.some(function (p) { return p.docId === doc.id && p.index === node.index; })
        ? " on" : "");
  }
}

async function refreshTemplatePanels(opts) {
  opts = opts || {};
  if (opts.clearCache) { panelThumbCache = {}; }
  const token = ++panelRefreshToken;
  const doc = app.documents.length ? app.activeDocument : null;
  const rows = doc ? panelRows(doc) : [];
  panelPickerDocId = rows.length ? doc.id : null;

  if (!rows.length) {
    panelChipNodes = [];
    renderPanelPicker(null, []);
    return rows;
  }

  // Keep picks that still exist in this document; never pre-select a panel silently.
  panelPicks = panelPicks.filter(function (p) {
    return p.docId === doc.id && !!findRowForPanel(rows, p.index);
  });

  renderPanelPicker(doc, rows);
  applyPanelThumbCache();

  const missing = [];
  for (const row of rows) {
    for (const item of row.panels) {
      const key = panelThumbKey(doc, item.layer);
      if (!panelThumbCache[key]) {
        missing.push({ index: item.index, layer: item.layer, key: key });
      }
    }
  }
  if (missing.length) {
    await loadPanelThumbnails(doc, missing);
    if (token === panelRefreshToken) { applyPanelThumbCache(); }
  }
  return rows;
}

async function onPanelChipClick(index, event) {
  if (emotionBusy) { return; }
  const doc = app.documents.length ? app.activeDocument : null;
  if (!doc) { return; }
  const layer = findPanelImage(doc, index);
  if (!layer) {
    setStatus("Panel " + panelLabel(index) + " was not found. Press Refresh panels.");
    return;
  }
  const additive = !!(event && event.shiftKey);
  rememberPanelPick(doc, index, additive);
  syncPanelPickerSelection(doc, index, additive);
  try {
    await core.executeAsModal(
      async () => {
        app.activeDocument = doc;
        const layers = panelPicks
          .filter(function (p) { return p.docId === doc.id; })
          .map(function (p) { return findPanelImage(doc, p.index); })
          .filter(function (l) { return !!l; });
        if (layers.length) {
          await selectLayers(layers.map(function (l) { return l.id; }));
        } else {
          await selectLayer(layer.id);
        }
      },
      { commandName: "Color Script: select Panel " + panelLabel(index) }
    );
    const count = panelPicks.filter(function (p) { return p.docId === doc.id; }).length;
    if (count > 1) {
      setStatus(
        "Selected " + count + " panels. Choose a mood below to color them all.",
        "ok"
      );
    } else {
      const row = findRowForPanel(panelRows(doc), index);
      setStatus(
        "Selected Panel " + panelLabel(index) +
          (row ? " (Row " + row.number + ")" : "") +
          ". Choose a mood below.",
        "ok"
      );
    }
  } catch (e) {
    console.error(e);
    setStatus("Could not select the panel: " + (e && e.message ? e.message : e), "err");
  }
}

function grayscaleTargetSummary() {
  const names = grayscaleTargets.map(function (t) { return t.name; });
  if (names.length === 1) { return names[0]; }
  const shown = names.slice(0, 3).join(", ");
  return names.length + " images (" + shown +
    (names.length > 3 ? ", +" + (names.length - 3) + " more" : "") + ")";
}

function updateGrayscaleHint(text) {
  const el = document.getElementById("grayHint");
  if (!el) { return; }
  if (text) {
    el.textContent = text;
  } else if (grayscaleTargets.length) {
    el.textContent = "Ready: " + grayscaleTargetSummary() +
      ". Choose a mood below to add the same gradient map to all of them.";
  } else {
    el.textContent = GRAY_HINT_DEFAULT;
  }
}

function clearGrayscaleTarget() {
  grayscaleTargets = [];
  updateGrayscaleHint();
}

/* Return the imported documents that are still open, dropping any that were
 * closed. When none remain the import flow is cleared. */
function importedGrayscaleDocs() {
  if (!grayscaleTargets.length) { return []; }
  const open = [];
  const keep = [];
  for (const target of grayscaleTargets) {
    let doc = null;
    for (let i = 0; i < app.documents.length; i++) {
      if (app.documents[i].id === target.id) {
        doc = app.documents[i];
        break;
      }
    }
    if (doc) {
      open.push(doc);
      keep.push(target);
    }
  }
  const previous = grayscaleTargets.length;
  grayscaleTargets = keep;
  if (!open.length) {
    clearGrayscaleTarget();
  } else if (keep.length !== previous) {
    updateGrayscaleHint();
  }
  return open;
}

/* Read a small preview of a document and report whether it is grayscale. */
async function documentGrayInfo(doc) {
  const W = Math.max(1, Math.round(Number(doc.width)));
  const H = Math.max(1, Math.round(Number(doc.height)));
  let target;
  if (W >= H) {
    target = {
      width: SAMPLE_LONG_SIDE,
      height: Math.max(1, Math.round(SAMPLE_LONG_SIDE * H / W)),
    };
  } else {
    target = {
      height: SAMPLE_LONG_SIDE,
      width: Math.max(1, Math.round(SAMPLE_LONG_SIDE * W / H)),
    };
  }
  try {
    const result = await imaging.getPixels({
      documentID: doc.id,
      targetSize: target,
      componentSize: 8,
      colorSpace: "RGB",
    });
    const imageData = result.imageData;
    try {
      const components = imageData.components || 3;
      const cw = imageData.width;
      const ch = imageData.height;
      const data = await imageData.getData({ chunky: true });
      return {
        gray: modeIsGray(doc.mode) || isEffectivelyGray(data, cw, ch, components),
        width: W,
        height: H,
      };
    } finally {
      imageData.dispose();
    }
  } catch (e) {
    console.error(e);
    return { gray: modeIsGray(doc.mode), width: W, height: H };
  }
}

async function onImportGrayscale() {
  const bar = document.getElementById("progress");
  let picked = null;
  try {
    picked = await fs.getFileForOpening({ types: IMAGE_TYPES, allowMultiple: true });
  } catch (e) {
    console.error(e);
    setStatus("Import failed: " + (e && e.message ? e.message : e), "err");
    return;
  }
  const files = Array.isArray(picked) ? picked : (picked ? [picked] : []);
  if (!files.length) {
    setStatus("No files selected.");
    return;
  }

  setEmotionBusy(true);
  if (bar) { bar.style.display = "block"; }
  setStatus("Importing " + files.length + " image" + (files.length === 1 ? "" : "s") + "...");

  try {
    const infos = await core.executeAsModal(
      async () => {
        const prevDialogs = app.displayDialogs;
        app.displayDialogs = constants.DialogModes.NONE;
        try {
          const newDoc = await app.createDocument({
            width: TEMPLATE_W,
            height: TEMPLATE_H,
            resolution: TEMPLATE_DPI || 150,
            mode: "RGBColorMode",
            fill: "transparent",
            name: "Color Script Imported",
          });

          const columns = Math.ceil(Math.sqrt(files.length));
          const rows = Math.ceil(files.length / columns);
          const innerW = TEMPLATE_W - TEMPLATE_MARGIN * 2 - TEMPLATE_GAP * (columns - 1);
          const innerH = TEMPLATE_H - TEMPLATE_MARGIN * 2 - TEMPLATE_GAP * (rows - 1);
          const cellW = innerW / columns;
          const cellH = innerH / rows;

          const grayResults = [];
          const docsBeforeImport = [];
          for (let k = 0; k < app.documents.length; k++) {
            docsBeforeImport.push(app.documents[k].id);
          }

          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const nativePath = file.nativePath || String(file);

            let doc = null;
            let wasOpenBefore = false;
            for (let j = 0; j < app.documents.length; j++) {
              const d = app.documents[j];
              if (sameDocPath(d, nativePath)) {
                doc = d;
                wasOpenBefore = true;
                break;
              }
            }
            if (!doc) {
              doc = await app.open(file);
            }

            app.activeDocument = doc;
            const grayInfo = await documentGrayInfo(doc);
            grayResults.push({
              id: doc.id,
              name: file.name || nativePath,
              gray: grayInfo.gray,
            });

            app.activeDocument = newDoc;

            const col = i % columns;
            const row = Math.floor(i / columns);
            const cellX = TEMPLATE_MARGIN + col * (cellW + TEMPLATE_GAP) + cellW / 2;
            const cellY = TEMPLATE_MARGIN + row * (cellH + TEMPLATE_GAP) + cellH / 2;

            await placeByOpen(file, cellX, cellY, cellW, cellH, file.name || "Imported");

            app.activeDocument = newDoc;

            if (!wasOpenBefore) {
              try {
                const stillOpen = app.documents.some(function (d) { return d.id === doc.id; });
                if (stillOpen) {
                  app.activeDocument = doc;
                  await doc.close(constants.SaveOptions.DONOTSAVECHANGES);
                }
              } catch (e) {
                console.error("Failed to close original doc:", e);
              }
              app.activeDocument = newDoc;
            }
          }

          for (let i = app.documents.length - 1; i >= 0; i--) {
            const d = app.documents[i];
            if (d.id === newDoc.id) { continue; }
            if (docsBeforeImport.indexOf(d.id) >= 0) { continue; }
            try {
              app.activeDocument = d;
              await d.close(constants.SaveOptions.DONOTSAVECHANGES);
            } catch (e) {
              console.error("Failed to close leftover doc:", e);
            }
          }
          app.activeDocument = newDoc;
          const compositeGrayInfo = await documentGrayInfo(newDoc);
          const allGray = grayResults.every(r => r.gray);
          const compositeGray = allGray || compositeGrayInfo.gray;

          return [{ id: newDoc.id, name: "All imported images", gray: compositeGray }];
        } finally {
          app.displayDialogs = prevDialogs;
        }
      },
      { commandName: "Color Script: Import grayscale" }
    );

    grayscaleTargets = infos;
    updateGrayscaleHint();
    const grayCount = infos.filter(function (i) { return i.gray; }).length;
    let detail;
    if (infos.length === 1) {
      detail = infos[0].name + (infos[0].gray ? " (grayscale)" : " (not detected as grayscale)");
    } else {
      detail = infos.length + " images (" +
        (grayCount === infos.length
          ? "all grayscale"
          : grayCount
            ? grayCount + " detected as grayscale"
            : "none detected as grayscale") + ")";
    }
    setStatus(
      "Imported " + detail +
      ". Choose an emotion to add the same gradient map to all of them.",
      grayCount === infos.length ? "ok" : ""
    );
  } catch (e) {
    console.error(e);
    setStatus("Import failed: " + (e && e.message ? e.message : e), "err");
  } finally {
    if (bar) { bar.style.display = "none"; }
    setEmotionBusy(false);
  }
}

async function applyEmotionTint(key, colors, ctx, opts) {
  if (!app.documents.length) {
    throw new Error("Open a document to colorize.");
  }
  const emo = EMOTIONS[key];
  if (!emo) { throw new Error("Unknown emotion: " + key); }

  const doc = (opts && opts.doc) ? opts.doc : app.activeDocument;
  if (!doc) { throw new Error("Open a document to colorize."); }
  const forceGradient = !!(opts && opts.forceGradient);
  const strength = readStrength();
  const modeGray = modeIsGray(doc.mode);
  const hostControl = ctx.hostControl;
  const suspension = await hostControl.suspendHistory({
    documentID: doc.id,
    name: TINT_PREFIX + " - " + emo.label,
  });

  try {
    app.activeDocument = doc;
    await prepareTintDocument(doc);
    const removed = await removeTintLayers(doc);

    const W = Math.round(Number(doc.width));
    const H = Math.round(Number(doc.height));
    if (!(W > 0 && H > 0)) {
      throw new Error("The document has no pixels.");
    }
    const preview = await readPreviewPixels(doc, null, W, H, 256);
    const info = analyzePixels(preview.data, preview.w, preview.h, preview.components);
    const gray = modeGray || info.gray;
    const gradient = forceGradient || (readGradientOption() && gray);
    const stops = stopsForPanel(colors, info, { fillPaper: readFillPaperOption() });

    // One Gradient Map adjustment layer on top of the stack, not clipped.
    const top = doc.layers.length ? doc.layers[0] : null;
    const layer = await makeGradientMapLayer(doc, top, stops, {
      name: TINT_PREFIX + " - " + emo.label + (gradient ? GRADIENT_SUFFIX : ""),
      opacity: strength,
      blend: gradient ? "normal" : "color",
      clip: false,
    });

    return {
      name: doc.name,
      label: emo.label,
      strength: strength,
      gray: gray,
      lineArt: info.lineArt,
      gradient: gradient,
      removed: removed,
      colors: colors,
      layerId: layer.id,
    };
  } finally {
    await hostControl.resumeHistory(suspension);
  }
}

/* Apply one mood (and therefore one palette) to every imported document.
 * Each document gets its own suspended history state; a failure on one image
 * is reported but does not stop the rest. */
async function applyImportEmotionTint(key, colors, ctx, docs) {
  const emo = EMOTIONS[key];
  if (!emo) { throw new Error("Unknown emotion: " + key); }
  if (!docs || !docs.length) {
    throw new Error("No imported images are open.");
  }

  const results = [];
  const failures = [];
  for (const doc of docs) {
    try {
      const result = await applyEmotionTint(key, colors, ctx, {
        doc: doc,
        forceGradient: true,
      });
      results.push(result);
    } catch (e) {
      console.error("Import tint failed for " + (doc && doc.name) + ":", e);
      failures.push({
        name: doc && doc.name,
        message: e && e.message ? e.message : String(e),
      });
    }
  }
  if (!results.length) {
    throw new Error("None of the imported images could be colorized.");
  }
  return {
    label: emo.label,
    strength: readStrength(),
    results: results,
    failures: failures,
    removed: results.reduce(function (n, r) { return n + (r.removed || 0); }, 0),
    gradient: results.every(function (r) { return r.gradient; }),
  };
}


/* ------------------------------------------------------------------ */
/* gradient map tint layers                                            */
/* ------------------------------------------------------------------ */

function readFillPaperOption() {
  const el = document.getElementById("optFillPaper");
  return el ? !!el.checked : true;
}

function readBandsOption() {
  const el = document.getElementById("optBands");
  return !!(el && el.checked);
}

function readBandStrength(band) {
  const el = document.getElementById("optBand" + band.charAt(0).toUpperCase() + band.slice(1));
  let v = el ? parseInt(el.value, 10) : 100;
  if (!isFinite(v)) { v = 100; }
  return Math.max(0, Math.min(100, v));
}

/* Read a small preview of one layer (or the composite when layerId is null). */
async function readPreviewPixels(doc, layerId, w, h, longSide) {
  const long = longSide || 256;
  const scale = Math.min(long / Math.max(1, w), long / Math.max(1, h), 1);
  const req = {
    documentID: doc.id,
    targetSize: { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) },
    componentSize: 8,
    colorSpace: "RGB",
  };
  if (layerId !== null && layerId !== undefined) { req.layerID = layerId; }
  const result = await imaging.getPixels(req);
  const imageData = result.imageData;
  try {
    return {
      data: await imageData.getData({ chunky: true }),
      w: imageData.width, h: imageData.height,
      components: imageData.components || 3,
    };
  } finally { imageData.dispose(); }
}

/* Read a small preview of the composite inside one rectangle (for panel groups). */
async function readPreviewRegion(doc, bounds, w, h, longSide) {
  const long = longSide || 256;
  const scale = Math.min(long / Math.max(1, w), long / Math.max(1, h), 1);
  const result = await imaging.getPixels({
    documentID: doc.id,
    sourceBounds: { left: Math.round(Number(bounds.left)), top: Math.round(Number(bounds.top)),
      right: Math.round(Number(bounds.right)), bottom: Math.round(Number(bounds.bottom)) },
    targetSize: { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) },
    componentSize: 8,
    colorSpace: "RGB",
  });
  const imageData = result.imageData;
  try {
    return { data: await imageData.getData({ chunky: true }), w: imageData.width, h: imageData.height,
      components: imageData.components || 3 };
  } finally { imageData.dispose(); }
}

/* Make one Gradient Map adjustment layer directly above `above` (a layer), and
 * clip it to that layer when clip is true. Returns the new layer. */
async function makeGradientMapLayer(doc, above, stops, opts) {
  if (above) { doc.activeLayers = [above]; }
  await action.batchPlay([gradientMapMake(stops, opts)], {});
  const layer = doc.activeLayers[0];
  if (!layer) { throw new Error("The gradient map layer was not created."); }
  if (opts && opts.clip) {
    try { layer.isClippingMask = true; }
    catch (e) {
      await action.batchPlay([{ _obj: "groupEvent", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }], {});
    }
  }
  return layer;
}

/* Build the stops for a panel from its analysis, the palette and the options. */
function stopsForPanel(colors, info, opts) {
  if (info && info.lineArt) { return lineArtStops(colors, info, opts.fillPaper !== false); }
  return rampStops(colors);
}

async function prepareTintDocument(doc) {
  if (doc.mode === "bitmapMode" || doc.mode === "duotoneMode") {
    await doc.changeMode("grayscaleMode");
  }
  if (doc.mode !== "RGBColorMode") {
    await doc.changeMode("RGBColorMode");
  }
}

async function tintPanelCore(doc, panel, colors, opts) {
  opts = opts || {};
  if (!panel || !panel.layer) {
    throw new Error("Select a panel layer first.");
  }
  const emo = opts.emo || { label: "Emotion" };
  const strength = opts.strength === undefined ? readStrength() : opts.strength;
  const gradientOption = opts.gradient === undefined ? readGradientOption() : opts.gradient;
  const fillPaper = opts.fillPaper === undefined ? readFillPaperOption() : opts.fillPaper;
  const bands = opts.bands === undefined ? readBandsOption() : opts.bands;

  let panelLayer = panel.layer;
  const b = panelLayer.boundsNoEffects || panelLayer.bounds;
  if (!b) { throw new Error("The selected panel has no pixels."); }
  const W = Math.max(1, Math.round(Number(b.right) - Number(b.left)));
  const H = Math.max(1, Math.round(Number(b.bottom) - Number(b.top)));

  let preview;
  try {
    if (panelLayer.kind === "group" || (panelLayer.layers && panelLayer.layers.length)) {
      preview = await readPreviewRegion(doc, b, W, H, 256);
    } else {
      preview = await readPreviewPixels(doc, panelLayer.id, W, H, 256);
    }
  } catch (e) {
    // A smart object still in the stack: rasterize and retry once.
    console.error(e);
    await rasterizeLayer(panelLayer.id);
    panelLayer = findPanelImage(doc, panel.index) || panelLayer;
    preview = await readPreviewPixels(doc, panelLayer.id, W, H, 256);
  }
  const info = analyzePixels(preview.data, preview.w, preview.h, preview.components);
  preview = null;

  const removed = await removePanelTintLayers(doc, panel.index);
  const gray = modeIsGray(doc.mode) || info.gray;
  const gradient = gradientOption && gray;
  const blend = gradient ? "normal" : "color";
  const stops = stopsForPanel(colors, info, { fillPaper: fillPaper });
  const baseName = panelTintName(emo.label, panel.index);
  const made = [];

  try {
    if (bands) {
      // Three clipped gradient maps, one per value band, each with its own opacity.
      // Make them bottom-up so the stack reads Shadows / Midtones / Highlights.
      const order = ["shadows", "midtones", "highlights"];
      let above = panelLayer;
      for (const band of order) {
        const layer = await makeGradientMapLayer(doc, above, stops, {
          name: baseName + " - " + BANDS[band].label,
          opacity: Math.round(strength * readBandStrength(band) / 100),
          blend: blend,
          transparency: bandTransparency(band),
          clip: true,
        });
        made.push(layer);
        above = layer;
      }
    } else {
      made.push(await makeGradientMapLayer(doc, panelLayer, stops, {
        name: baseName, opacity: strength, blend: blend, clip: true,
      }));
    }
  } catch (e) {
    for (const l of made) { try { await l.delete(); } catch (e2) { console.error(e2); } }
    throw e;
  }

  return {
    name: doc.name,
    index: panel.index,
    label: emo.label,
    strength: strength,
    gray: gray,
    lineArt: info.lineArt,
    gradient: gradient,
    bands: bands,
    removed: removed,
    layers: made.length,
  };
}

async function applyPanelEmotionTint(key, colors, ctx, panel) {
  if (!panel || !panel.layer) {
    throw new Error("Select a panel layer first.");
  }
  const emo = EMOTIONS[key];
  if (!emo) { throw new Error("Unknown emotion: " + key); }
  const doc = app.activeDocument;
  if (!doc) { throw new Error("Open a document to colorize."); }

  const strength = readStrength();
  const gradient = readGradientOption();
  const hostControl = ctx.hostControl;
  const suspension = await hostControl.suspendHistory({
    documentID: doc.id,
    name: TINT_PREFIX + " - Panel " + panelLabel(panel.index),
  });

  try {
    app.activeDocument = doc;
    await prepareTintDocument(doc);
    return await tintPanelCore(doc, panel, colors, {
      emo: emo,
      strength: strength,
      gradient: gradient,
    });
  } finally {
    await hostControl.resumeHistory(suspension);
  }
}

async function applyRowEmotionTint(key, colors, ctx, row) {
  const emo = EMOTIONS[key];
  if (!emo) { throw new Error("Unknown emotion: " + key); }
  if (!row || !row.panels || !row.panels.length) {
    throw new Error("That panel row was not found.");
  }
  const doc = app.activeDocument;
  if (!doc) { throw new Error("Open a document to colorize."); }

  const strength = readStrength();
  const gradientOption = readGradientOption();
  const hostControl = ctx.hostControl;
  const suspension = await hostControl.suspendHistory({
    documentID: doc.id,
    name: TINT_PREFIX + " - Row " + row.number,
  });

  try {
    app.activeDocument = doc;
    await prepareTintDocument(doc);

    const results = [];
    const failures = [];
    const count = row.panels.length;
    for (let i = 0; i < count; i++) {
      const item = row.panels[i];
      const varied = varyEmotionPalette(colors, i, count);
      const layer = findPanelImage(doc, item.index) || item.layer;
      try {
        const result = await tintPanelCore(doc, {
          index: item.index,
          layer: layer,
        }, varied, {
          emo: emo,
          strength: strength,
          gradient: gradientOption,
        });
        result.colors = varied;
        result.slot = i + 1;
        results.push(result);
      } catch (e) {
        console.error("Row tint failed for Panel " + panelLabel(item.index) + ":", e);
        failures.push({
          index: item.index,
          message: e && e.message ? e.message : String(e),
        });
      }
    }

    if (!results.length) {
      throw new Error("No panels in this row could be colorized.");
    }
    return {
      name: doc.name,
      label: emo.label,
      row: row.number,
      strength: strength,
      gradient: results.every(function (r) { return r.gradient; }),
      removed: results.reduce(function (n, r) { return n + (r.removed || 0); }, 0),
      results: results,
      failures: failures,
    };
  } finally {
    await hostControl.resumeHistory(suspension);
  }
}

async function onEmotion(key) {
  const emo = EMOTIONS[key];
  if (!emo) { return; }
  const colors = paletteFor(key, emo);
  updateEmotionSwatches(colors);

  const activeDoc = app.documents.length ? app.activeDocument : null;
  const isTemplate = !!activeDoc &&
    (activeDoc.name === TEMPLATE_DOC_NAME || listPanelLayers(activeDoc).length > 0);
  if (isTemplate) {
    const checkedPicks = panelPicks.filter(function (p) { return p.docId === activeDoc.id; });
    const hasChecked = checkedPicks.length > 0;

    if (hasChecked) {
      const selectedPanels = checkedPicks
        .map(function (p) { return findPanelImage(activeDoc, p.index); })
        .filter(function (l) { return !!l; });

      if (!selectedPanels.length) {
        setStatus("Check at least one panel, then choose a mood.", "err");
        return;
      }

      const bar = document.getElementById("progress");
      setEmotionBusy(true);
      if (bar) { bar.style.display = "block"; }
      setStatus("Colorizing " + selectedPanels.length + " panel" +
        (selectedPanels.length === 1 ? "" : "s") + " - " + emo.label + "...");
      try {
        const result = await core.executeAsModal(
          async (ctx) => {
            const prevDialogs = app.displayDialogs;
            app.displayDialogs = constants.DialogModes.NONE;
            try {
              const hostControl = ctx.hostControl;
              const suspension = await hostControl.suspendHistory({
                documentID: activeDoc.id,
                name: TINT_PREFIX + " - " + emo.label,
              });
              try {
                app.activeDocument = activeDoc;
                await prepareTintDocument(activeDoc);
                const strength = readStrength();
                const gradientOption = readGradientOption();
                const results = [];
                const failures = [];
                for (const panel of selectedPanels) {
                  const idx = panelNumberFromName(panel.name);
                  const resolvedPanel = { index: idx, layer: panel };
                  try {
                    const r = await tintPanelCore(activeDoc, resolvedPanel, colors, {
                      emo: emo,
                      strength: strength,
                      gradient: gradientOption,
                    });
                    r.colors = colors;
                    results.push(r);
                  } catch (e) {
                    console.error("Tint failed for Panel " + panelLabel(idx) + ":", e);
                    failures.push({ index: idx, message: e && e.message ? e.message : String(e) });
                  }
                }
                return {
                  label: emo.label,
                  strength: strength,
                  results: results,
                  failures: failures,
                  removed: results.reduce(function (n, r) { return n + (r.removed || 0); }, 0),
                  gradient: results.length && results.every(function (r) { return r.gradient; }),
                };
              } finally {
                await hostControl.resumeHistory(suspension);
              }
            } finally {
              app.displayDialogs = prevDialogs;
            }
          },
          { commandName: "Color Script: " + emo.label + " tint" }
        );

        const kind = result.gradient ? "gradient map" : "Color tint";
        let msg = "template: " + activeDoc.name + " | " + result.results.length + " panel" +
          (result.results.length === 1 ? "" : "s") + " | " + result.label + " " + kind +
          " at " + result.strength + "%";
        if (result.removed) {
          msg += " | replaced " + result.removed + " earlier tint" +
            (result.removed === 1 ? "" : "s");
        }
        if (result.failures.length) {
          msg += " | skipped " + result.failures.length + " panel" +
            (result.failures.length === 1 ? "" : "s");
        }
        const lineArt = result.results.filter(function (r) { return r.lineArt; }).length;
        if (lineArt) { msg += " | line art: " + lineArt; }
        if (result.results.some(function (r) { return r.bands; })) { msg += " | 3 value bands"; }
        setStatus(msg, "ok");
      } catch (e) {
        console.error(e);
        setStatus("Panel colorize failed: " + (e && e.message ? e.message : e), "err");
      } finally {
        if (bar) { bar.style.display = "none"; }
        setEmotionBusy(false);
      }
      return;
    }

    const picked = resolvePanel(activeDoc);
    if (!picked || picked.error) {
      setStatus(
        picked && picked.error === "multiple"
          ? "Select one panel layer, then choose a mood."
          : "Select a panel layer or click a panel thumbnail, then choose a mood."
      );
      return;
    }
    syncPanelPickerSelection(activeDoc, picked.index, false);

    const rowMode = readRowMode();
    let row = null;
    if (rowMode) {
      row = findRowForPanel(panelRows(activeDoc), picked.index);
      if (!row) {
        setStatus("Could not find this panel's row. Press Refresh panels and try again.");
        return;
      }
    }

    const bar = document.getElementById("progress");
    setEmotionBusy(true);
    if (bar) { bar.style.display = "block"; }
    setStatus(
      rowMode
        ? "Colorizing Row " + row.number + " (" + row.panels.length + " panels) - " +
          emo.label + "..."
        : "Colorizing Panel " + panelLabel(picked.index) + " - " + emo.label + "..."
    );
    try {
      const result = await core.executeAsModal(
        async (ctx) => {
          const prevDialogs = app.displayDialogs;
          app.displayDialogs = constants.DialogModes.NONE;
          try {
            return rowMode
              ? await applyRowEmotionTint(key, colors, ctx, row)
              : await applyPanelEmotionTint(key, colors, ctx, picked);
          } finally {
            app.displayDialogs = prevDialogs;
          }
        },
        {
          commandName: "Color Script: " + emo.label +
            (rowMode ? " row tint" : " panel tint"),
        }
      );

      if (rowMode) {
        const kind = result.gradient ? "gradient maps" : "Color tints";
        let msg = "template: " + result.name + " | Row " + result.row +
          " (" + result.results.length + " panel" +
          (result.results.length === 1 ? "" : "s") + ") | " +
          result.label + " " + kind + " at " + result.strength + "%";
        if (result.removed) {
          msg += " | replaced " + result.removed + " earlier tint" +
            (result.removed === 1 ? "" : "s");
        }
        if (result.failures.length) {
          msg += " | skipped " + result.failures.length + " panel" +
            (result.failures.length === 1 ? "" : "s");
        }
        setStatus(msg, "ok");
      } else {
        const kind = result.gradient ? "gradient map" : "Color tint";
        let msg = "template: " + result.name + " | Panel " + panelLabel(result.index) +
          " | " + result.label + " " + kind + " at " + result.strength + "%";
        if (result.removed) {
          msg += " | replaced " + result.removed + " earlier tint" +
            (result.removed === 1 ? "" : "s");
        }
        setStatus(msg, "ok");
      }
    } catch (e) {
      console.error(e);
      setStatus("Panel colorize failed: " + (e && e.message ? e.message : e), "err");
    } finally {
      if (bar) { bar.style.display = "none"; }
      setEmotionBusy(false);
    }
    return;
  }

  let targets = importedGrayscaleDocs();
  const currentDoc = app.documents.length ? app.activeDocument : null;
  if (targets.length && currentDoc &&
      !targets.some(function (d) { return d.id === currentDoc.id; })) {
    clearGrayscaleTarget();
    targets = [];
  }
  const fromImport = targets.length > 0;

  const bar = document.getElementById("progress");
  setEmotionBusy(true);
  if (bar) { bar.style.display = "block"; }
  setStatus(fromImport
    ? "Adding gradient map to " + targets.length + " image" +
      (targets.length === 1 ? "" : "s") + " - " + emo.label + "..."
    : "Colorizing - " + emo.label + "...");
  try {
    const result = await core.executeAsModal(
      async (ctx) => {
        const prevDialogs = app.displayDialogs;
        app.displayDialogs = constants.DialogModes.NONE;
        try {
          return fromImport
            ? await applyImportEmotionTint(key, colors, ctx, targets)
            : await applyEmotionTint(key, colors, ctx, {});
        } finally {
          app.displayDialogs = prevDialogs;
        }
      },
      { commandName: "Color Script: " + emo.label + " tint" }
    );

    if (fromImport) {
      const done = result.results.length;
      const detected = result.results.filter(function (r) { return r.gray; }).length;
      updateGrayscaleHint("Gradient map added to " + done + " image" +
        (done === 1 ? "" : "s") + ". Pick another mood to reroll.");
      const kind = result.gradient ? "gradient map" : "Color tint";
      let msg = "import: " + done + " image" + (done === 1 ? "" : "s") +
        " (" + result.results.map(function (r) { return r.name; }).join(", ") + ") | " +
        result.label + " " + kind + " at " + result.strength + "%";
      if (result.removed) {
        msg += " | replaced " + result.removed + " earlier tint" +
          (result.removed === 1 ? "" : "s");
      }
      if (result.failures.length) {
        msg += " | skipped " + result.failures.length;
      }
      msg += " | " + (detected === done
        ? "all detected as grayscale"
        : detected
          ? detected + " of " + done + " detected as grayscale"
          : "not detected as grayscale");
      msg += " | palette " + paletteText(colors);
      setStatus(msg, "ok");
    } else {
      const kind = result.gradient ? "gradient map" : "Color tint";
      const state = result.gray ? "grayscale detected" : "not detected as grayscale";
      let msg = "emotion: " + result.name + " | " +
        result.label + " " + kind + " at " + result.strength + "% (" + state + ")";
      if (result.removed) {
        msg += " | replaced " + result.removed + " earlier tint" +
          (result.removed === 1 ? "" : "s");
      }
      msg += " | palette " + paletteText(result.colors);
      setStatus(msg, "ok");
    }
  } catch (e) {
    console.error(e);
    setStatus("Colorize failed: " + (e && e.message ? e.message : e), "err");
  } finally {
    if (bar) { bar.style.display = "none"; }
    setEmotionBusy(false);
  }
}

/* Which tint layers a Strength change applies to: the checked panels, else the
 * selected panel (or its row in row mode), else every tint in the document. */
function strengthTargets(doc) {
  const all = collectTintLayers(doc.layers, []);
  const isTemplate = doc.name === TEMPLATE_DOC_NAME || listPanelLayers(doc).length > 0;
  if (!isTemplate) { return { tints: all, scope: doc.name }; }

  let indexes = panelPicks
    .filter(function (p) { return p.docId === doc.id; })
    .map(function (p) { return p.index; });
  let scope = indexes.length + " checked panel" + (indexes.length === 1 ? "" : "s");
  if (!indexes.length) {
    const picked = resolvePanel(doc);
    if (picked && !picked.error) {
      if (readRowMode()) {
        const row = findRowForPanel(panelRows(doc), picked.index);
        if (row) {
          indexes = row.panels.map(function (p) { return p.index; });
          scope = "Row " + row.number;
        }
      }
      if (!indexes.length) { indexes = [picked.index]; scope = "Panel " + panelLabel(picked.index); }
    }
  }
  if (!indexes.length) { return { tints: all, scope: "every tint" }; }
  return {
    tints: all.filter(function (l) { return indexes.indexOf(panelNumberFromName(l.name)) >= 0; }),
    scope: scope,
  };
}

function bandOfLayer(layer) {
  const m = / - (Shadows|Midtones|Highlights)$/.exec(String(layer.name || ""));
  return m ? m[1].toLowerCase() : null;
}

let strengthTimer = null;
let strengthRunning = false;
let strengthQueued = null;

/* Strength (and the three band sliders) update live while dragging. Calls are
 * serialized so a fast drag never overlaps two modal scopes. */
function scheduleStrength(band) {
  strengthQueued = band || null;
  if (strengthTimer) { clearTimeout(strengthTimer); }
  strengthTimer = setTimeout(function () { strengthTimer = null; runStrength(); }, 120);
}

async function runStrength() {
  if (strengthRunning) { return; }
  strengthRunning = true;
  try {
    while (strengthQueued !== undefined) {
      const band = strengthQueued;
      strengthQueued = undefined;
      await applyStrength(band);
    }
  } finally {
    strengthRunning = false;
    strengthQueued = undefined;
  }
}

async function applyStrength(band) {
  if (!app.documents.length) { return; }
  const doc = app.activeDocument;
  const strength = readStrength();

  let docs = [doc];
  const importTargets = importedGrayscaleDocs();
  if (importTargets.length && importTargets.some(function (d) { return d.id === doc.id; })) {
    docs = importTargets;
  }

  const jobs = [];
  let scope = "";
  for (const d of docs) {
    const t = docs.length > 1 ? { tints: collectTintLayers(d.layers, []), scope: docs.length + " imported images" }
      : strengthTargets(d);
    scope = t.scope;
    for (const l of t.tints) {
      const lb = bandOfLayer(l);
      if (band && lb !== band) { continue; }
      const factor = lb ? readBandStrength(lb) / 100 : 1;
      jobs.push({ layer: l, opacity: Math.round(strength * factor) });
    }
  }
  if (!jobs.length) {
    setStatus("No emotion tint to adjust yet. Choose a mood first.");
    return;
  }
  try {
    await core.executeAsModal(
      async () => { for (const j of jobs) { j.layer.opacity = j.opacity; } },
      { commandName: "Color Script: tint strength" }
    );
    setStatus(
      (band ? band.charAt(0).toUpperCase() + band.slice(1) + " " : "Tint ") +
        "strength " + (band ? readBandStrength(band) : strength) + "% on " + scope +
        " (" + jobs.length + " layer" + (jobs.length === 1 ? "" : "s") + ")",
      "ok"
    );
  } catch (e) {
    console.error(e);
    setStatus("Strength change failed: " + (e && e.message ? e.message : e), "err");
  }
}

async function onStrengthChange() { return applyStrength(null); }

async function onClearEmotion() {
  const bar = document.getElementById("progress");
  setEmotionBusy(true);
  if (bar) { bar.style.display = "block"; }
  setStatus("Removing emotion tint...");
  try {
    const summary = await core.executeAsModal(
      async () => {
        if (!app.documents.length) {
          throw new Error("Open a document first.");
        }
        const doc = app.activeDocument;
        const targets = importedGrayscaleDocs();
        const inImport = targets.length > 0 &&
          targets.some(function (d) { return d.id === doc.id; });
        const docs = inImport ? targets : [doc];
        let n = 0;
        for (const d of docs) { n += await removeTintLayers(d); }
        if (!n) { return "No emotion tint to remove."; }
        if (inImport && docs.length > 1) {
          return "Removed " + n + " emotion tint" + (n === 1 ? "" : "s") +
            " from " + docs.length + " imported images.";
        }
        return "Removed " + n + " emotion tint" + (n === 1 ? "" : "s") +
          " from " + doc.name + ".";
      },
      { commandName: "Color Script: Clear emotion tint" }
    );
    clearGrayscaleTarget();
    setStatus(summary, "ok");
  } catch (e) {
    console.error(e);
    setStatus("Clear failed: " + (e && e.message ? e.message : e), "err");
  } finally {
    if (bar) { bar.style.display = "none"; }
    setEmotionBusy(false);
  }
}

/* ------------------------------------------------------------------ */
/* build                                                               */
/* ------------------------------------------------------------------ */

async function createSheetDocument(spec, mode) {
  const name = spec.doc_name || DOC_NAME;

  for (let i = app.documents.length - 1; i >= 0; i--) {
    const d = app.documents[i];
    if (d && d.name === name) {
      try { await d.close(constants.SaveOptions.DONOTSAVECHANGES); }
      catch (e) { console.error(e); }
    }
  }

  return app.createDocument({
    width: spec.w,
    height: spec.h,
    resolution: spec.dpi || DPI_DEFAULT,
    mode: mode || "RGBColorMode",
    fill: "white",
    name: name,
  });
}

async function buildSheet(spec, execContext, doc) {
  doc = doc || app.activeDocument;
  const w = spec.w, h = spec.h;

  const hostControl = execContext.hostControl;
  const suspension = await hostControl.suspendHistory({
    documentID: doc.id,
    name: "Color Script",
  });

  let swatchCount = 0, stripCount = 0, textCount = 0, imageCount = 0;

  // background
  const bgId = await addLayer("Background");
  await selectLayer(bgId);
  await fillRect(0, 0, w, h, spec.bg || [255, 255, 255]);

  if (spec.title) {
    const t = spec.title;
    await addText(t.text, (t.cx || 0) + (t.dx || 0), (t.y || 0) + (t.dy || 0), t.size || 36, t.color || [0, 0, 0], !!t.bold, true, "Title");
    textCount++;
  }

  // pass 1: images, then swatches
  for (const pal of (spec.palettes || [])) {
    const placed = [];
    if (pal.images) {
      for (const im of pal.images) {
        if (!im.png) continue;
        try {
          placed.push(await placePng(im.png, (im.x || 0) + (im.dx || 0), (im.y || 0) + (im.dy || 0), im.w, im.h, im.name, im.entry));
          imageCount++;
        } catch (e) { console.error(e); }
      }
    }
    const swId = await addLayer(pal.layer_name || ("Palette " + swatchCount));
    await selectLayer(swId);
    if (pal.swatches) {
      for (const sw of pal.swatches) {
        try { await fillPoly(shapePoints(sw), sw.color); swatchCount++; } catch (e) { console.error(e); }
      }
    }
    await deselect();
    for (const id of placed) { try { await moveBelow(id, swId); } catch (e) {} }
  }

  // pass 2: captions and hex labels (topmost text)
  for (const pal of (spec.palettes || [])) {
    if (pal.caption) {
      const c = pal.caption;
      try { await addText(c.text, (c.cx || 0) + (c.dx || 0), (c.y || 0) + (c.dy || 0), c.size || 12, c.color || [0, 0, 0], !!c.bold, true, c.text); textCount++; } catch (e) {}
    }
    if (pal.swatches) {
      for (const sw of pal.swatches) {
        if (sw.label_cx === undefined || sw.label_cx === null) continue;
        try { await addText(sw.hex, (sw.label_cx || 0) + (sw.dx || 0), (sw.label_y || 0) + (sw.dy || 0), sw.label_size || 9, sw.label_color || [0, 0, 0], false, true, sw.hex); textCount++; } catch (e) {}
      }
    }
  }

  // pass 3: gradient strips (a placed PNG from a layout file, or native pixels)
  let gradLayer = null;
  for (const pal of (spec.palettes || [])) {
    if (!pal.strip) continue;
    if (pal.strip.png) {
      try {
        await placePng(pal.strip.png, (pal.strip.x || 0) + (pal.strip.dx || 0), (pal.strip.y || 0) + (pal.strip.dy || 0), pal.strip.w, pal.strip.h, pal.strip.name);
        stripCount++;
      } catch (e) { console.error(e); }
    } else if (pal.strip.colors && pal.strip.colors.length) {
      try {
        if (gradLayer === null) { gradLayer = await addLayer("Gradients"); }
        await paintGradient(doc, gradLayer, (pal.strip.x || 0) + (pal.strip.dx || 0), (pal.strip.y || 0) + (pal.strip.dy || 0), pal.strip.w, pal.strip.h, pal.strip.colors);
        stripCount++;
      } catch (e) { console.error(e); }
    }
  }

  await hostControl.resumeHistory(suspension);

  return `${doc.name} | ${Math.round(doc.width)}x${Math.round(doc.height)} px @ ${doc.resolution} ppi | ${swatchCount} swatches, ${stripCount} gradient(s), ${imageCount} image(s), ${textCount} labels | ${(spec.palettes || []).length} palette(s)`;
}

async function buildTemplateSheet(spec, execContext, doc, opts) {
  doc = doc || app.activeDocument;
  opts = opts || {};
  const hostControl = execContext.hostControl;
  const suspension = await hostControl.suspendHistory({
    documentID: doc.id,
    name: "Color Script Template",
  });

  let placed = 0;
  let layered = 0;
  const errors = [];
  try {
    for (const p of (spec.panels || [])) {
      try {
        if (opts.keepPsd && isLayeredSource(p.entry)) {
          const r = await placePsdLayers(p.entry, p.x, p.y, p.w, p.h, p.name);
          const g = findLayerById(doc, r.id);
          if (opts.desaturate && g && g.layers) {
            for (const child of g.layers) { if (child.kind === "pixel") { await desaturateLayer(child.id); } }
          }
          layered++;
        } else {
          const id = await placePng(p.png, p.x, p.y, p.w, p.h, p.name, p.entry);
          await rasterizeLayer(id);
          if (opts.desaturate) { await desaturateLayer(id); }
        }
        placed++;
      } catch (e) {
        console.error(e);
        errors.push(panelLabel(p.index) + ": " + (e && e.message ? e.message : e));
      }
    }
    if (!placed) {
      throw new Error("No panels were placed" +
        (errors.length ? " - " + errors[0] : "") +
        ". Make sure the files are not open in another app.");
    }
    // Resolve the first panel by name after rasterizing: rasterizing a smart
    // object can change its layer id.
    const first = listPanelLayers(doc)[0];
    if (first) {
      try { await selectLayer(first.id); } catch (e) { console.error(e); }
    }
  } finally {
    await hostControl.resumeHistory(suspension);
  }

  const gray = opts.desaturate ? "desaturated | " : "colour kept | ";
  let summary = `${doc.name} | ${gray}${Math.round(doc.width)}x${Math.round(doc.height)} px @ ${doc.resolution} ppi | ${placed} panel(s) | ${spec.columns} columns | no swatches/labels`;
  if (layered) { summary += " | " + layered + " PSD panel(s) kept their layers"; }
  if (errors.length) {
    summary += " | skipped " + errors.length + " (" + errors[0] + ")";
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* button wiring                                                       */
/* ------------------------------------------------------------------ */

function readOptions() {
  const colorsEl = document.getElementById("optColors");
  let colors = colorsEl ? parseInt(colorsEl.value, 10) : 6;
  if (!isFinite(colors)) { colors = 6; }
  colors = Math.max(2, Math.min(16, colors));

  const titleEl = document.getElementById("optTitle");
  const title = titleEl ? String(titleEl.value || "").trim() : "";

  const sharedEl = document.getElementById("optShared");
  const shared = !!(sharedEl && sharedEl.checked);

  return { colors: colors, title: title, shared: shared };
}

async function onBuildImages() {
  const btn = document.getElementById("btnImages");
  const bar = document.getElementById("progress");
  try {
    const files = await fs.getFileForOpening({
      allowMultiple: true,
      types: IMAGE_TYPES,
    });
    const list = !files ? [] : (Array.isArray(files) ? files : [files]);
    if (!list.length) {
      setStatus("No files selected.");
      return;
    }

    if (btn) { btn.disabled = true; }
    if (bar) { bar.style.display = "block"; }
    setStatus("Reading " + list.length + " file(s)...");

    const opts = readOptions();

    const summary = await core.executeAsModal(
      async (ctx) => {
        const prevDialogs = app.displayDialogs;
        app.displayDialogs = constants.DialogModes.NONE;
        try {
          const entries = [];
          const failed = [];
          for (const f of list) {
            try {
              entries.push(await readImageInfo(f));
            } catch (e) {
              console.error(e);
              failed.push(f.name);
            }
          }
          if (!entries.length) {
            throw new Error("Could not read any of the selected files.");
          }

          setStatus("Planning " + entries.length + " image(s)...");
          const spec = specFromEntries(entries, opts);

          setStatus("Drawing sheet...");
          const doc = await createSheetDocument(spec);
          let result = await buildSheet(spec, ctx, doc);
          if (failed.length) {
            result += " | skipped: " + failed.join(", ");
          }
          return result;
        } finally {
          app.displayDialogs = prevDialogs;
        }
      },
      { commandName: "Color Script: Build from images" }
    );

    setStatus("color script: " + summary, "ok");
    refreshTemplatePanels();
  } catch (e) {
    console.error(e);
    setStatus("Build failed: " + (e && e.message ? e.message : e), "err");
  } finally {
    if (btn) { btn.disabled = false; }
    if (bar) { bar.style.display = "none"; }
  }
}

function readTemplateColumns() {
  const el = document.getElementById("optTemplateCols");
  const v = el ? parseInt(el.value, 10) : TEMPLATE_COLUMNS_DEFAULT;
  return templateColumns(v);
}

async function onBuildTemplate() {
  const btn = document.getElementById("btnTemplate");
  const bar = document.getElementById("progress");
  const columns = readTemplateColumns();
  try {
    const files = await fs.getFileForOpening({
      allowMultiple: true,
      types: IMAGE_TYPES,
    });
    const list = !files ? [] : (Array.isArray(files) ? files : [files]);
    if (!list.length) {
      setStatus("No files selected.");
      return;
    }

    if (btn) { btn.disabled = true; }
    if (bar) { bar.style.display = "block"; }
    setStatus("Reading " + list.length + " image(s)...");

    const summary = await core.executeAsModal(
      async (ctx) => {
        const prevDialogs = app.displayDialogs;
        app.displayDialogs = constants.DialogModes.NONE;
        try {
          const entries = [];
          const failed = [];
          for (const f of list) {
            try {
              entries.push(await readImageMeta(f));
            } catch (e) {
              console.error(e);
              failed.push(f.name);
            }
          }
          if (!entries.length) {
            throw new Error("Could not read any of the selected files.");
          }

          setStatus("Planning " + entries.length + " panel(s)...");
          const preset = readPagePreset();
          const spec = planTemplate(entries, { columns: columns, w: preset.w, h: preset.h });

          setStatus("Drawing template...");
          const doc = await createSheetDocument(spec, "RGBColorMode");
          let result = await buildTemplateSheet(spec, ctx, doc, { desaturate: readDesaturateOption(), keepPsd: readKeepPsdOption() });
          if (readCaptionsOption()) {
            setStatus("Adding captions...");
            await reflowTemplate(doc, { preset: preset, columns: columns, captions: true });
            result += " | captions";
          }
          if (failed.length) {
            result += " | skipped: " + failed.join(", ");
          }
          return result;
        } finally {
          app.displayDialogs = prevDialogs;
        }
      },
      { commandName: "Color Script: Build grayscale template" }
    );

    setStatus(
      "template: " + summary + " | click a panel thumbnail, then pick a mood",
      "ok"
    );
    refreshTemplatePanels({ clearCache: true });
  } catch (e) {
    console.error(e);
    setStatus("Template build failed: " + (e && e.message ? e.message : e), "err");
  } finally {
    if (btn) { btn.disabled = false; }
    if (bar) { bar.style.display = "none"; }
  }
}

async function onBuildJson() {
  const btn = document.getElementById("btnBuild");
  const bar = document.getElementById("progress");
  try {
    const file = await fs.getFileForOpening({ types: ["json"] });
    if (!file) {
      setStatus("No file selected.");
      return;
    }
    const text = await file.read({ format: uxp.storage.formats.text });
    const spec = JSON.parse(text);

    if (btn) { btn.disabled = true; }
    if (bar) { bar.style.display = "block"; }
    setStatus("Building from layout...");

    const summary = await core.executeAsModal(
      async (ctx) => {
        const prevDialogs = app.displayDialogs;
        app.displayDialogs = constants.DialogModes.NONE;
        try {
          const doc = await createSheetDocument(spec);
          return await buildSheet(spec, ctx, doc);
        } finally {
          app.displayDialogs = prevDialogs;
        }
      },
      { commandName: "Color Script: Build from layout" }
    );

    setStatus("color script: " + summary, "ok");
    refreshTemplatePanels();
  } catch (e) {
    console.error(e);
    setStatus("Build failed: " + (e && e.message ? e.message : e), "err");
  } finally {
    if (btn) { btn.disabled = false; }
    if (bar) { bar.style.display = "none"; }
  }
}

function wireCheck(rowId, inputId) {
  const row = document.getElementById(rowId);
  const input = document.getElementById(inputId);
  if (!row || !input) { return; }
  const sync = () => {
    const on = !!input.checked;
    if (on) { row.classList.add("on"); } else { row.classList.remove("on"); }
    row.setAttribute("aria-checked", on ? "true" : "false");
  };
  row.addEventListener("click", () => {
    input.checked = !input.checked;
    sync();
  });
  row.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      input.checked = !input.checked;
      sync();
    }
  });
  sync();
}

window.addEventListener("load", () => {
  wireCheck("sharedCheck", "optShared");
  wireCheck("gradientCheck", "optGradientMap");
  wireCheck("rowCheck", "optEmotionRow");
  wireCheck("desaturateCheck", "optDesaturate");
  wireCheck("keepPsdCheck", "optKeepPsd");
  wireCheck("fillPaperCheck", "optFillPaper");
  wireCheck("bandsCheck", "optBands");

  const scroller = document.getElementById("scroll");
  const scrollNav = document.getElementById("scrollNav");
  const scrollUp = document.getElementById("scrollUp");
  const scrollDown = document.getElementById("scrollDown");
  const refreshScrollNav = () => {
    if (!scroller || !scrollNav) { return; }
    const max = scroller.scrollHeight - scroller.clientHeight;
    scrollNav.style.display = max > 2 ? "flex" : "none";
    if (scrollUp) { scrollUp.disabled = scroller.scrollTop <= 1; }
    if (scrollDown) { scrollDown.disabled = scroller.scrollTop >= max - 1; }
  };
  const nudgeScroll = (dy) => {
    if (!scroller) { return; }
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(max, scroller.scrollTop + dy));
    refreshScrollNav();
  };
  if (scroller) { scroller.addEventListener("scroll", refreshScrollNav); }
  if (scrollUp) { scrollUp.addEventListener("click", () => nudgeScroll(-180)); }
  if (scrollDown) { scrollDown.addEventListener("click", () => nudgeScroll(180)); }
  window.addEventListener("resize", refreshScrollNav);
  setTimeout(refreshScrollNav, 120);

  const templateBtn = document.getElementById("btnTemplate");
  if (templateBtn) {
    templateBtn.addEventListener("click", onBuildTemplate);
  }

  const imagesBtn = document.getElementById("btnImages");
  if (imagesBtn) {
    imagesBtn.addEventListener("click", onBuildImages);
  } else {
    console.error("btnImages not found");
  }
  const jsonBtn = document.getElementById("btnBuild");
  if (jsonBtn) {
    jsonBtn.addEventListener("click", onBuildJson);
  }

  const clearBtn = document.getElementById("btnEmotionClear");
  if (clearBtn) {
    clearBtn.addEventListener("click", onClearEmotion);
  }

  const refreshPanelsBtn = document.getElementById("btnRefreshPanels");
  if (refreshPanelsBtn) {
    // Refresh re-reads the open template's panels and thumbnails. It never
    // closes or changes the document.
    refreshPanelsBtn.addEventListener("click", async () => {
      panelChipNodes = [];
      const rows = await refreshTemplatePanels({ clearCache: true });
      const n = rows.reduce(function (sum, r) { return sum + r.panels.length; }, 0);
      setStatus(
        n ? "Panels refreshed: " + n + " panel" + (n === 1 ? "" : "s") + "."
          : "No template panels found. Open a Color Script Template.",
        n ? "ok" : ""
      );
    });
  }
  setTimeout(function () { refreshTemplatePanels(); }, 250);
  const strength = document.getElementById("optEmotionStrength");
  if (strength) {
    const out = document.getElementById("strengthOut");
    const sync = () => { if (out) { out.textContent = strength.value + "%"; } };
    strength.addEventListener("input", () => { sync(); scheduleStrength(null); });
    strength.addEventListener("change", () => { sync(); scheduleStrength(null); });
    sync();
  }
  for (const band of ["shadows", "midtones", "highlights"]) {
    const id = "optBand" + band.charAt(0).toUpperCase() + band.slice(1);
    const el = document.getElementById(id);
    const out = document.getElementById(id + "Out");
    if (!el) { continue; }
    const sync = () => { if (out) { out.textContent = el.value + "%"; } };
    el.addEventListener("input", () => { sync(); scheduleStrength(band); });
    el.addEventListener("change", () => { sync(); scheduleStrength(band); });
    sync();
  }
  const bandsCheck = document.getElementById("optBands");
  const bandRows = document.getElementById("bandRows");
  const syncBands = () => { if (bandRows) { bandRows.hidden = !(bandsCheck && bandsCheck.checked); } };
  if (bandsCheck) { bandsCheck.addEventListener("change", syncBands); }
  const bandsRow = document.getElementById("bandsCheck");
  if (bandsRow) { bandsRow.addEventListener("click", () => setTimeout(syncBands, 0)); }
  syncBands();

  if (typeof initFeatures === "function") { initFeatures(); }
  const colorRange = document.getElementById("optColorRange");
  if (colorRange) {
    const out = document.getElementById("rangeOut");
    const sync = () => {
      if (out) { out.textContent = colorRange.value + "%"; }
    };
    colorRange.addEventListener("input", sync);
    colorRange.addEventListener("change", sync);
    sync();
  }
});

