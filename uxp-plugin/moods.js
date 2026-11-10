/*
 * Moods and the "type your own" interpreter — pure, no Photoshop objects.
 * Loads in the panel as a plain script and in Node for the tests.
 *
 * Each mood is a four-stop ramp: shadow, low mid, high mid, highlight.
 * interpretMood("eerie dawn, muted") blends the moods it recognises and applies
 * the modifiers it recognises, and says what it understood. Offline and
 * deterministic: the same words give the same palette.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  else { Object.assign(root, api); }
})(typeof window !== "undefined" ? window : this, function () {
  const MOODS = {
    happy:      { label: "Happy",      colors: [[74, 44, 107], [214, 69, 80], [247, 166, 58], [255, 232, 163]] },
    tense:      { label: "Tense",      colors: [[16, 20, 26], [61, 14, 20], [178, 34, 34], [242, 194, 48]] },
    sad:        { label: "Sad",        colors: [[21, 35, 59], [47, 74, 99], [110, 143, 168], [198, 214, 224]] },
    cautious:   { label: "Cautious",   colors: [[30, 42, 36], [63, 83, 72], [138, 144, 112], [211, 205, 180]] },
    calm:       { label: "Calm",       colors: [[24, 40, 56], [60, 96, 118], [140, 178, 186], [224, 236, 232]] },
    angry:      { label: "Angry",      colors: [[30, 8, 8], [110, 16, 20], [205, 52, 30], [255, 170, 90]] },
    eerie:      { label: "Eerie",      colors: [[10, 14, 20], [40, 70, 60], [110, 160, 120], [200, 235, 190]] },
    romantic:   { label: "Romantic",   colors: [[60, 20, 50], [150, 50, 90], [230, 120, 140], [255, 220, 210]] },
    nostalgic:  { label: "Nostalgic",  colors: [[50, 38, 28], [120, 94, 66], [190, 160, 120], [240, 228, 200]] },
    hopeful:    { label: "Hopeful",    colors: [[40, 36, 70], [120, 90, 140], [240, 160, 120], [255, 240, 200]] },
    lonely:     { label: "Lonely",     colors: [[18, 22, 34], [50, 58, 80], [110, 118, 140], [200, 205, 215]] },
    triumphant: { label: "Triumphant", colors: [[40, 20, 60], [150, 40, 80], [240, 150, 40], [255, 240, 150]] },
    dreamy:     { label: "Dreamy",     colors: [[48, 30, 80], [120, 80, 160], [190, 150, 220], [245, 230, 250]] },
  };
  const MOOD_ORDER = Object.keys(MOODS);

  /* word -> mood key */
  const MOOD_WORDS = {
    happy: ["happy", "joy", "joyful", "cheerful", "sunny", "playful", "fun", "bright", "upbeat", "glad"],
    tense: ["tense", "anxious", "nervous", "danger", "dangerous", "thriller", "suspense", "suspenseful", "alarm", "urgent", "chase"],
    sad: ["sad", "melancholy", "melancholic", "gloomy", "grief", "sorrow", "mourning", "blue", "tearful", "loss"],
    cautious: ["cautious", "wary", "uneasy", "careful", "hesitant", "guarded", "suspicious"],
    calm: ["calm", "serene", "peaceful", "quiet", "still", "tranquil", "gentle", "rest", "resting", "meditative"],
    angry: ["angry", "anger", "rage", "fury", "furious", "violent", "wrath", "hostile", "fight", "battle"],
    eerie: ["eerie", "creepy", "haunted", "spooky", "ghost", "ghostly", "horror", "uncanny", "sinister", "ominous"],
    romantic: ["romantic", "romance", "love", "tender", "intimate", "kiss", "passion", "affection"],
    nostalgic: ["nostalgic", "nostalgia", "memory", "memories", "old", "faded", "vintage", "sepia", "childhood", "remember"],
    hopeful: ["hopeful", "hope", "optimistic", "new", "beginning", "promise", "rising", "renewal"],
    lonely: ["lonely", "alone", "isolated", "empty", "solitude", "abandoned", "distant", "cold-hearted"],
    triumphant: ["triumphant", "triumph", "victory", "victorious", "epic", "heroic", "glory", "glorious", "win", "celebration"],
    dreamy: ["dreamy", "dream", "dreamlike", "surreal", "magic", "magical", "fantasy", "wonder", "whimsical"],
  };

  /* modifier word -> { hue (target degrees), pull (0..1), sat (x), light (+), label } */
  const MODIFIERS = {
    warm:       { hue: 30, pull: 0.35, sat: 1.05, light: 0, label: "warmer" },
    hot:        { hue: 20, pull: 0.45, sat: 1.15, light: 0, label: "hotter" },
    cold:       { hue: 215, pull: 0.4, sat: 1.0, light: -0.02, label: "colder" },
    cool:       { hue: 200, pull: 0.3, sat: 1.0, light: 0, label: "cooler" },
    icy:        { hue: 195, pull: 0.5, sat: 0.9, light: 0.08, label: "icy" },
    night:      { hue: 230, pull: 0.25, sat: 0.9, light: -0.12, label: "darker (night)" },
    midnight:   { hue: 235, pull: 0.35, sat: 0.85, light: -0.16, label: "darker (midnight)" },
    dark:       { hue: null, pull: 0, sat: 1.0, light: -0.12, label: "darker" },
    moonlit:    { hue: 220, pull: 0.45, sat: 0.7, light: -0.1, label: "moonlit" },
    dawn:       { hue: 345, pull: 0.3, sat: 1.0, light: 0.06, label: "lighter (dawn)" },
    morning:    { hue: 40, pull: 0.25, sat: 1.0, light: 0.08, label: "lighter (morning)" },
    dusk:       { hue: 290, pull: 0.3, sat: 1.0, light: -0.06, label: "dusk" },
    sunset:     { hue: 20, pull: 0.45, sat: 1.2, light: -0.02, label: "sunset" },
    golden:     { hue: 45, pull: 0.5, sat: 1.2, light: 0.03, label: "golden" },
    neon:       { hue: null, pull: 0, sat: 1.5, light: 0.02, label: "more saturated (neon)" },
    vivid:      { hue: null, pull: 0, sat: 1.35, light: 0, label: "more saturated" },
    saturated:  { hue: null, pull: 0, sat: 1.35, light: 0, label: "more saturated" },
    muted:      { hue: null, pull: 0, sat: 0.6, light: 0, label: "muted" },
    dusty:      { hue: 35, pull: 0.2, sat: 0.55, light: 0.02, label: "dusty" },
    faded:      { hue: null, pull: 0, sat: 0.55, light: 0.08, label: "faded" },
    pastel:     { hue: null, pull: 0, sat: 0.7, light: 0.14, label: "pastel" },
    soft:       { hue: null, pull: 0, sat: 0.8, light: 0.06, label: "softer" },
    pale:       { hue: null, pull: 0, sat: 0.7, light: 0.12, label: "paler" },
    stormy:     { hue: 210, pull: 0.35, sat: 0.75, light: -0.07, label: "stormy" },
    storm:      { hue: 210, pull: 0.35, sat: 0.75, light: -0.07, label: "stormy" },
    rain:       { hue: 205, pull: 0.3, sat: 0.7, light: -0.04, label: "rainy" },
    fog:        { hue: 200, pull: 0.2, sat: 0.45, light: 0.1, label: "foggy" },
    mist:       { hue: 200, pull: 0.2, sat: 0.45, light: 0.1, label: "misty" },
    snow:       { hue: 210, pull: 0.3, sat: 0.5, light: 0.14, label: "snowy" },
    autumn:     { hue: 28, pull: 0.5, sat: 1.05, light: -0.02, label: "autumn" },
    spring:     { hue: 95, pull: 0.4, sat: 1.0, light: 0.06, label: "spring" },
    summer:     { hue: 48, pull: 0.35, sat: 1.15, light: 0.04, label: "summer" },
    winter:     { hue: 215, pull: 0.4, sat: 0.6, light: 0.06, label: "winter" },
    rainy:      { hue: 205, pull: 0.3, sat: 0.7, light: -0.04, label: "rainy" },
    foggy:      { hue: 200, pull: 0.2, sat: 0.45, light: 0.1, label: "foggy" },
    forest:     { hue: 120, pull: 0.45, sat: 0.95, light: -0.03, label: "forest green" },
    green:      { hue: 120, pull: 0.5, sat: 1.0, light: 0, label: "greener" },
    ocean:      { hue: 200, pull: 0.5, sat: 1.0, light: 0, label: "ocean blue" },
    sea:        { hue: 195, pull: 0.45, sat: 1.0, light: 0, label: "sea blue" },
    underwater: { hue: 190, pull: 0.55, sat: 0.9, light: -0.05, label: "underwater" },
    desert:     { hue: 35, pull: 0.5, sat: 0.9, light: 0.06, label: "desert" },
    fire:       { hue: 18, pull: 0.55, sat: 1.3, light: 0, label: "fiery" },
    candle:     { hue: 35, pull: 0.5, sat: 1.1, light: -0.1, label: "candlelit" },
    purple:     { hue: 275, pull: 0.5, sat: 1.0, light: 0, label: "more purple" },
    red:        { hue: 0, pull: 0.5, sat: 1.1, light: 0, label: "redder" },
    blue:       { hue: 220, pull: 0.5, sat: 1.0, light: 0, label: "bluer" },
    orange:     { hue: 30, pull: 0.5, sat: 1.1, light: 0, label: "more orange" },
    pink:       { hue: 340, pull: 0.5, sat: 1.0, light: 0.05, label: "pinker" },
    yellow:     { hue: 50, pull: 0.5, sat: 1.1, light: 0.04, label: "yellower" },
    teal:       { hue: 175, pull: 0.5, sat: 1.0, light: 0, label: "teal" },
  };

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function rgbToHsl(c) {
    let r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
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
    s = clamp01(s); l = clamp01(l);
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
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  /* Weighted blend of several ramps, stop by stop, with a circular hue mean. */
  function blendRamps(ramps, weights) {
    const n = ramps[0].length;
    const out = [];
    for (let i = 0; i < n; i++) {
      let x = 0, y = 0, s = 0, l = 0, wsum = 0;
      for (let k = 0; k < ramps.length; k++) {
        const w = weights[k];
        const hsl = rgbToHsl(ramps[k][i]);
        const a = hsl[0] * Math.PI / 180;
        x += Math.cos(a) * w * hsl[1]; y += Math.sin(a) * w * hsl[1];
        s += hsl[1] * w; l += hsl[2] * w; wsum += w;
      }
      const h = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      out.push(hslToRgb(h, s / wsum, l / wsum));
    }
    return out;
  }

  function pullHue(h, target, pull) {
    let d = ((target - h + 540) % 360) - 180;
    return (h + d * pull + 360) % 360;
  }

  /* Small pulls rotate the hue (warm, cool). Strong pulls (ocean, fire, green)
   * mix toward a one-hue ramp in RGB instead, so a red ramp pulled to blue
   * passes through grey, never through green and purple. */
  function applyModifier(colors, mod) {
    return colors.map(function (c) {
      const hsl = rgbToHsl(c);
      let h = hsl[0];
      let rgb;
      if (mod.hue === null || mod.hue === undefined) {
        rgb = hslToRgb(h, hsl[1] * mod.sat, hsl[2] + mod.light);
      } else if (mod.pull < 0.4) {
        h = pullHue(hsl[0], mod.hue, mod.pull);
        rgb = hslToRgb(h, hsl[1] * mod.sat, hsl[2] + mod.light);
      } else {
        const base = hslToRgb(hsl[0], hsl[1] * mod.sat, hsl[2] + mod.light);
        const target = hslToRgb(mod.hue, Math.max(hsl[1] * mod.sat, 0.45), hsl[2] + mod.light);
        rgb = base.map(function (v, i) { return Math.round(v + (target[i] - v) * mod.pull); });
      }
      return rgb;
    });
  }

  function tokens(text) {
    return String(text || "").toLowerCase().replace(/[^a-z\- ]+/g, " ").split(/\s+/).filter(Boolean);
  }

  function stem(w) {
    if (MOODS[w] || MODIFIERS[w]) { return w; }
    const tries = [w.replace(/ness$/, ""), w.replace(/ly$/, ""), w.replace(/ing$/, ""), w.replace(/ed$/, ""),
      w.replace(/s$/, ""), w.replace(/ful$/, ""), w.replace(/y$/, "")];
    for (const t of tries) { if (t !== w && (lookupMood(t) || MODIFIERS[t])) { return t; } }
    return w;
  }

  let wordIndex = null;
  function lookupMood(w) {
    if (!wordIndex) {
      wordIndex = {};
      for (const key of Object.keys(MOOD_WORDS)) { for (const word of MOOD_WORDS[key]) { wordIndex[word] = key; } }
      for (const key of Object.keys(MOODS)) { wordIndex[key] = key; }
    }
    return wordIndex[w] || null;
  }

  /* Returns { colors, moods: [{key, label, weight}], modifiers: [label], explanation }
   * or { colors: null, explanation } when nothing was recognised. */
  function interpretMood(text) {
    const words = tokens(text);
    const moodHits = {};
    const mods = [];
    const seenMods = {};
    let negateNext = false;
    for (const raw of words) {
      const w = stem(raw);
      if (w === "not" || w === "less") { negateNext = true; continue; }
      const key = lookupMood(w);
      if (key) {
        moodHits[key] = (moodHits[key] || 0) + (negateNext ? 0.35 : 1);
        negateNext = false;
        continue;
      }
      if (MODIFIERS[w] && !seenMods[w]) {
        seenMods[w] = true;
        const m = MODIFIERS[w];
        mods.push(negateNext ? { hue: m.hue, pull: m.pull * 0.5, sat: 1 / m.sat, light: -m.light, label: "less " + m.label } : m);
        negateNext = false;
      }
    }
    const keys = Object.keys(moodHits);
    let colors = null;
    const moods = [];
    if (keys.length) {
      const ramps = keys.map(function (k) { return MOODS[k].colors; });
      const weights = keys.map(function (k) { return moodHits[k]; });
      colors = blendRamps(ramps, weights);
      const total = weights.reduce(function (a, b) { return a + b; }, 0);
      keys.forEach(function (k, i) {
        moods.push({ key: k, label: MOODS[k].label, weight: Math.round(100 * weights[i] / total) });
      });
      moods.sort(function (a, b) { return b.weight - a.weight; });
    } else if (mods.length) {
      colors = [[28, 28, 34], [84, 84, 92], [160, 160, 168], [236, 236, 240]];
    }
    if (!colors) {
      return { colors: null, moods: [], modifiers: [], explanation: "No mood or colour words recognised. Try words like eerie, calm, warm, night, pastel." };
    }
    for (const m of mods) { colors = applyModifier(colors, m); }
    const parts = [];
    if (moods.length) {
      parts.push(moods.map(function (m) { return m.label + (moods.length > 1 ? " " + m.weight + "%" : ""); }).join(" + "));
    } else {
      parts.push("neutral ramp");
    }
    if (mods.length) { parts.push(mods.map(function (m) { return m.label; }).join(", ")); }
    return { colors: colors, moods: moods, modifiers: mods.map(function (m) { return m.label; }), explanation: parts.join(" | ") };
  }

  return { MOODS: MOODS, MOOD_ORDER: MOOD_ORDER, MOOD_WORDS: MOOD_WORDS, MODIFIERS: MODIFIERS,
    interpretMood: interpretMood, blendRamps: blendRamps, rgbToHslMood: rgbToHsl, hslToRgbMood: hslToRgb };
});
