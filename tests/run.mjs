// Dependency-free tests for the pure modules. Run: node tests/run.mjs
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const gm = require("../uxp-plugin/gradientmap.js");
const moods = require("../uxp-plugin/moods.js");
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log("ok  " + name); } catch (e) { console.log("ERR " + name + "\n    " + (e.message || e)); process.exitCode = 1; } }

test("rampStops spaces four stops evenly", () => {
  const st = gm.rampStops([[0,0,0],[1,1,1],[2,2,2],[3,3,3]]);
  assert.deepEqual(st.map((s) => s.t), [0, 1/3, 2/3, 1]);
});
test("gradientMapMake builds a Photoshop descriptor with 0..4096 locations", () => {
  const d = gm.gradientMapMake(gm.rampStops([[10,20,30],[200,210,220]]), { name: "x", opacity: 40, blend: "color" });
  assert.equal(d._obj, "make");
  assert.equal(d.using.name, "x");
  assert.equal(d.using.opacity._value, 40);
  assert.equal(d.using.mode._value, "color");
  const g = d.using.type.gradient;
  assert.deepEqual(g.colors.map((c) => c.location), [0, 4096]);
  assert.deepEqual([g.colors[1].color.red, g.colors[1].color.green, g.colors[1].color.blue], [200, 210, 220]);
  assert.equal(g.transparency.length, 2);
  assert.equal(g.transparency[0].opacity._value, 100);
});
test("band blend ranges cover the value scale with soft edges", () => {
  const sh = gm.bandBlendRange("shadows").to.blendRange[0];
  assert.equal(sh.destBlackMin, 0); assert.ok(sh.destWhiteMin < sh.destWhiteMax && sh.destWhiteMax <= 160);
  const hi = gm.bandBlendRange("highlights").to.blendRange[0];
  assert.equal(hi.destWhiteMax, 255); assert.ok(hi.destBlackMin >= 96 && hi.destBlackMin < hi.destBlackMax);
  const mid = gm.bandBlendRange("midtones").to.blendRange[0];
  assert.ok(mid.destBlackMax < mid.destWhiteMin);
  assert.equal(gm.bandBlendRange("shadows").to.blendRange[0].srcWhiteMax, 255);
});
test("analyzePixels: colour image is not gray", () => {
  const px = new Uint8Array([200, 30, 30, 255, 30, 200, 30, 255, 30, 30, 200, 255, 100, 100, 100, 255]);
  const a = gm.analyzePixels(px, 2, 2, 4);
  assert.equal(a.gray, false); assert.equal(a.lineArt, false);
});
test("analyzePixels: ink on paper is line art", () => {
  const px = []; for (let i = 0; i < 100; i++) { const ink = i % 10 === 0; px.push(ink ? 15 : 248, ink ? 15 : 248, ink ? 15 : 248); }
  const a = gm.analyzePixels(new Uint8Array(px), 10, 10, 3);
  assert.equal(a.lineArt, true); assert.ok(a.inkLum < 60); assert.ok(a.paperLum > 230);
});
test("analyzePixels: dark lines on transparency is line art with paper = 255", () => {
  const px = []; for (let i = 0; i < 100; i++) { const ink = i % 5 === 0; px.push(20, 20, 20, ink ? 255 : 0); }
  const a = gm.analyzePixels(new Uint8Array(px), 10, 10, 4);
  assert.equal(a.lineArt, true); assert.equal(a.paperLum, 255); assert.ok(a.coverage < 0.5);
});
test("analyzePixels: a gray photo with full tonal range is not line art", () => {
  const px = []; for (let i = 0; i < 256; i++) { px.push(i, i, i); }
  const a = gm.analyzePixels(new Uint8Array(px), 16, 16, 3, { samples: 256 });
  assert.equal(a.gray, true); assert.equal(a.lineArt, false);
});
test("lineArtStops: ink gets the shadow stop, paper the light stop", () => {
  const st = gm.lineArtStops([[1,2,3],[9,9,9],[50,50,50],[250,251,252]], { inkLum: 20, paperLum: 250 }, true);
  assert.deepEqual(st[0].color, [1,2,3]); assert.deepEqual(st[st.length - 1].color, [250,251,252]);
  const nofill = gm.lineArtStops([[1,2,3],[9,9,9],[50,50,50],[250,251,252]], { inkLum: 20, paperLum: 250 }, false);
  assert.deepEqual(nofill[st.length - 1].color, [255,255,255]);
});
test("interpretMood: a mood word gives that mood's ramp", () => {
  const r = moods.interpretMood("calm");
  assert.deepEqual(r.colors, moods.MOODS.calm.colors); assert.equal(r.moods[0].key, "calm");
});
test("interpretMood: two moods blend and report weights", () => {
  const r = moods.interpretMood("eerie and sad");
  assert.equal(r.moods.length, 2); assert.equal(r.moods[0].weight + r.moods[1].weight, 100);
});
test("interpretMood: modifiers change lightness and saturation the right way", () => {
  const base = moods.interpretMood("happy").colors;
  const night = moods.interpretMood("happy night").colors;
  const sumL = (cs) => cs.reduce((a, c) => a + c[0] + c[1] + c[2], 0);
  assert.ok(sumL(night) < sumL(base));
  const pastel = moods.interpretMood("happy pastel").colors;
  assert.ok(sumL(pastel) > sumL(base));
});
test("interpretMood: deterministic", () => {
  assert.deepEqual(moods.interpretMood("lonely winter morning").colors, moods.interpretMood("lonely winter morning").colors);
});
test("interpretMood: nonsense is refused with an explanation", () => {
  const r = moods.interpretMood("qwerty zzz");
  assert.equal(r.colors, null); assert.ok(/recognised/.test(r.explanation));
});
test("interpretMood: every mood has four stops that get lighter", () => {
  for (const k of moods.MOOD_ORDER) {
    const c = moods.MOODS[k].colors; assert.equal(c.length, 4);
    const lum = c.map((x) => 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2]);
    for (let i = 1; i < 4; i++) { assert.ok(lum[i] > lum[i - 1], k + " stop " + i); }
  }
});
test("band masks tile the value scale: the three weights sum to 255 everywhere", () => {
  const lum = new Uint8Array(256); for (let i = 0; i < 256; i++) { lum[i] = i; }
  const s = gm.bandMask(lum, "shadows"), m = gm.bandMask(lum, "midtones"), h = gm.bandMask(lum, "highlights");
  for (let i = 0; i < 256; i++) { assert.ok(Math.abs(s[i] + m[i] + h[i] - 255) <= 2, "lum " + i + ": " + (s[i] + m[i] + h[i])); }
  assert.equal(s[0], 255); assert.equal(h[255], 255); assert.equal(m[144], 255);
});
test("luminanceOf handles gray, RGB and RGBA", () => {
  assert.deepEqual(Array.from(gm.luminanceOf(new Uint8Array([200]), 1, 1, 1)), [200]);
  assert.deepEqual(Array.from(gm.luminanceOf(new Uint8Array([255, 255, 255, 0, 0, 0]), 2, 1, 3)), [255, 0]);
  assert.deepEqual(Array.from(gm.luminanceOf(new Uint8Array([0, 255, 0, 255]), 1, 1, 4)), [182]);
});
console.log(passed + " passed");
