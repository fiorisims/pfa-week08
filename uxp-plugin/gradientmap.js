/*
 * Gradient Map tints — pure helpers, no Photoshop objects.
 *
 * A mood tint is a real Gradient Map adjustment layer clipped to its panel:
 * non-destructive, editable in Properties, and Strength is just its opacity.
 * This file builds the batchPlay descriptor for that layer and analyses a
 * panel's pixels (grayscale? line art?). It loads in the panel as a plain
 * script and in Node for the tests (see tests/).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  else { Object.assign(root, api); }
})(typeof window !== "undefined" ? window : this, function () {
  const GRADIENT_SPAN = 4096;          /* Photoshop stop locations run 0..4096 */
  const LINE_ART_INK_MAX = 90;         /* luminance of "ink" pixels, at most */
  const LINE_ART_PAPER_MIN = 215;      /* luminance of "paper" pixels, at least */
  const LINE_ART_FRACTION = 0.92;      /* share of opaque pixels that must be ink or paper */
  const LINE_ART_INK_MIN_SHARE = 0.01; /* some ink has to be there */
  const LINE_ART_ALPHA_COVERAGE = 0.5; /* a transparent PNG is line art when ink covers less than this */

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function loc(t) { return Math.round(clamp(t, 0, 1) * GRADIENT_SPAN); }

  /* Evenly spaced stops from a mood ramp ([r,g,b] x N, shadow first). */
  function rampStops(colors) {
    const n = colors.length;
    return colors.map(function (c, i) {
      return { t: n <= 1 ? 0 : i / (n - 1), color: c };
    });
  }

  /* Line art: ink takes the shadow stop, paper takes the light stop (or stays
   * white when fillPaper is off). Edges between them blend through the ramp. */
  function lineArtStops(colors, info, fillPaper) {
    const shadow = colors[0];
    const light = colors[colors.length - 1];
    const ink = clamp(info.inkLum / 255, 0, 0.6);
    const paper = clamp(info.paperLum / 255, 0.7, 1);
    return [
      { t: 0, color: shadow },
      { t: ink, color: shadow },
      { t: paper, color: fillPaper ? light : [255, 255, 255] },
      { t: 1, color: fillPaper ? light : [255, 255, 255] },
    ];
  }

  /* Value bands: a Blend If "Underlying Layer" range on the adjustment layer,
   * so each map only shows over the shadows, the midtones or the highlights
   * of the panel below it. Split points give a soft edge (0..255). */
  const BANDS = {
    shadows:    { label: "Shadows",    range: [0, 0, 72, 136] },
    midtones:   { label: "Midtones",   range: [72, 136, 152, 216] },
    highlights: { label: "Highlights", range: [152, 216, 255, 255] },
  };
  function bandBlendRange(band) {
    const b = BANDS[band];
    const r = b ? b.range : [0, 0, 255, 255];
    return {
      _obj: "set",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      to: {
        _obj: "layer",
        blendRange: [{
          _obj: "blendRange",
          channel: { _ref: "channel", _enum: "channel", _value: "gray" },
          srcBlackMin: 0, srcBlackMax: 0, srcWhiteMin: 255, srcWhiteMax: 255,
          destBlackMin: r[0], destBlackMax: r[1], destWhiteMin: r[2], destWhiteMax: r[3],
        }],
      },
      _options: { dialogOptions: "dontDisplay" },
    };
  }

  /* Luminance (0..255) of every pixel in an RGB(A)/gray buffer. */
  function luminanceOf(data, w, h, components) {
    const count = w * h;
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const si = i * components;
      if (components <= 2) { out[i] = data[si]; }
      else { out[i] = (54 * data[si] + 183 * data[si + 1] + 19 * data[si + 2]) >> 8; }
    }
    return out;
  }

  /* A layer-mask buffer (0..255) that limits one Gradient Map to a value band
   * of the ORIGINAL panel, so the three band maps never re-map each other. The
   * three weights sum to 255 at every luminance. */
  function bandMask(lum, band) {
    const r = (BANDS[band] || { range: [0, 0, 255, 255] }).range;
    const n = lum.length;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = lum[i];
      let wgt;
      if (v < r[0]) { wgt = 0; }
      else if (v < r[1]) { wgt = (v - r[0]) / (r[1] - r[0]); }
      else if (v <= r[2]) { wgt = 1; }
      else if (v < r[3]) { wgt = (r[3] - v) / (r[3] - r[2]); }
      else { wgt = 0; }
      out[i] = Math.round(wgt * 255);
    }
    return out;
  }

  function gradientDescriptor(name, stops, transparency) {
    return {
      _obj: "gradientClassEvent",
      name: name || "Mood",
      gradientForm: { _enum: "gradientForm", _value: "customStops" },
      interfaceIconFrameDimmed: GRADIENT_SPAN,
      colors: stops.map(function (s) {
        return {
          _obj: "colorStop",
          color: { _obj: "RGBColor", red: s.color[0], green: s.color[1], blue: s.color[2] },
          type: { _enum: "colorStopType", _value: "userStop" },
          location: loc(s.t),
          midpoint: 50,
        };
      }),
      transparency: (transparency || [{ t: 0, opacity: 100 }, { t: 1, opacity: 100 }]).map(function (s) {
        return {
          _obj: "transparencyStop",
          opacity: { _unit: "percentUnit", _value: s.opacity },
          location: loc(s.t),
          midpoint: 50,
        };
      }),
    };
  }

  /* The batchPlay command that makes one Gradient Map adjustment layer above
   * the active layer. opts: { name, opacity, blend ("normal" | "color"), transparency } */
  function gradientMapMake(stops, opts) {
    opts = opts || {};
    return {
      _obj: "make",
      _target: [{ _ref: "adjustmentLayer" }],
      using: {
        _obj: "adjustmentLayer",
        name: opts.name || "Gradient Map",
        opacity: { _unit: "percentUnit", _value: clamp(opts.opacity === undefined ? 100 : opts.opacity, 0, 100) },
        mode: { _enum: "blendMode", _value: opts.blend || "normal" },
        type: {
          _obj: "gradientMapClass",
          gradient: gradientDescriptor(opts.name, stops, opts.transparency),
        },
      },
      _options: { dialogOptions: "dontDisplay" },
    };
  }

  /* Same descriptor for "set" on an existing adjustment layer (edit the ramp). */
  function gradientMapSet(stops, transparency) {
    return {
      _obj: "set",
      _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
      to: { _obj: "gradientMapClass", gradient: gradientDescriptor("Mood", stops, transparency) },
      _options: { dialogOptions: "dontDisplay" },
    };
  }

  /* Sample an RGB(A) buffer: is it effectively gray? is it line art?
   * Returns { gray, lineArt, paperLum, inkLum, coverage, sampled }. */
  function analyzePixels(data, w, h, components, opts) {
    opts = opts || {};
    const chromaMax = opts.chromaMax === undefined ? 12 : opts.chromaMax;
    const coloredFraction = opts.coloredFraction === undefined ? 0.005 : opts.coloredFraction;
    const target = opts.samples || 6000;
    const count = w * h;
    const out = { gray: true, lineArt: false, paperLum: 255, inkLum: 0, coverage: 1, sampled: 0 };
    if (!count || !data) { return out; }
    const stride = Math.max(1, Math.floor(count / target));
    let sampled = 0, colored = 0, opaque = 0, ink = 0, paper = 0;
    let inkSum = 0, paperSum = 0;
    for (let i = 0; i < count; i += stride) {
      const si = i * components;
      let r, g, b, a = 255;
      if (components === 1) { r = g = b = data[si]; }
      else if (components === 2) { r = g = b = data[si]; a = data[si + 1]; }
      else { r = data[si]; g = data[si + 1]; b = data[si + 2]; a = components >= 4 ? data[si + 3] : 255; }
      sampled++;
      if (a < 8) { continue; }
      opaque++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > chromaMax) { colored++; }
      const lum = (54 * r + 183 * g + 19 * b) >> 8;
      if (lum <= LINE_ART_INK_MAX) { ink++; inkSum += lum; }
      else if (lum >= LINE_ART_PAPER_MIN) { paper++; paperSum += lum; }
    }
    out.sampled = sampled;
    if (!opaque) { return out; }
    out.coverage = opaque / sampled;
    out.gray = colored <= Math.max(1, Math.floor(opaque * coloredFraction));
    if (ink) { out.inkLum = Math.round(inkSum / ink); }
    if (paper) { out.paperLum = Math.round(paperSum / paper); }
    const inkShare = ink / opaque;
    const twoTone = (ink + paper) / opaque >= LINE_ART_FRACTION && inkShare >= LINE_ART_INK_MIN_SHARE;
    const transparentInk = out.coverage < LINE_ART_ALPHA_COVERAGE && inkShare >= 0.6;
    out.lineArt = out.gray && (twoTone || transparentInk);
    if (transparentInk && !paper) { out.paperLum = 255; }
    return out;
  }

  return {
    GRADIENT_SPAN: GRADIENT_SPAN,
    BANDS: BANDS,
    rampStops: rampStops,
    lineArtStops: lineArtStops,
    bandBlendRange: bandBlendRange,
    luminanceOf: luminanceOf,
    bandMask: bandMask,
    gradientDescriptor: gradientDescriptor,
    gradientMapMake: gradientMapMake,
    gradientMapSet: gradientMapSet,
    analyzePixels: analyzePixels,
  };
});
