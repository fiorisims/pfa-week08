/*
 * Developer self-test hook. Does nothing unless a file named autotest.json
 * exists in the plugin's own data folder (Photoshop grants that folder without
 * a prompt). It drives the real buttons and inputs, stands in for the file
 * picker, and writes autotest-result.json. Used to verify fixes end to end.
 */
(function () {
  const uxpMod = window.require("uxp");
  const lfs = uxpMod.storage.localFileSystem;
  const formats = uxpMod.storage.formats;
  let pendingPick = null;
  let running = false;

  const realPick = lfs.getFileForOpening.bind(lfs);
  lfs.getFileForOpening = async function (opts) {
    if (pendingPick) {
      const p = pendingPick; pendingPick = null;
      return (opts && opts.allowMultiple) ? p : p[0];
    }
    return realPick(opts);
  };

  function statusText() {
    const el = document.getElementById("status");
    const detail = document.getElementById("statusDetail");
    return (el ? el.textContent : "") + (detail && detail.textContent ? " | " + detail.textContent.replace(/\n/g, " | ") : "");
  }
  let pendingSave = null;
  const realSave = lfs.getFileForSaving.bind(lfs);
  lfs.getFileForSaving = async function (name, opts) {
    if (pendingSave) {
      const n = pendingSave; pendingSave = null;
      const data = await lfs.getDataFolder();
      return data.createFile(n, { overwrite: true });
    }
    return realSave(name, opts);
  };
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async function waitIdle(maxMs) {
    const t0 = Date.now();
    await sleep(1200);
    for (;;) {
      const bar = document.getElementById("progress");
      const busy = (bar && bar.style.display !== "none") ||
        /\.\.\.$/.test(statusText().trim());
      if (!busy) { return true; }
      if (Date.now() - t0 > (maxMs || 120000)) { return false; }
      await sleep(250);
    }
  }


  function layerInfo(l, depth) {
    const o = { name: l.name, opacity: l.opacity, blend: String(l.blendMode), kind: String(l.kind),
      visible: l.visible, clipped: !!l.isClippingMask, id: l.id };
    try { const b = l.boundsNoEffects || l.bounds; o.bounds = [b.left, b.top, b.right, b.bottom].map(Number); } catch (e) {}
    if (l.layers && l.layers.length && depth < 2) { o.layers = l.layers.map((c) => layerInfo(c, depth + 1)); }
    return o;
  }
  /* Fixed probes: UXP forbids new Function / eval in a plugin. */
  async function probe(step) {
    const ps = window.require("photoshop");
    const app = ps.app;
    const what = step.what;
    if (what === "docs") {
      return { count: app.documents.length, names: app.documents.map((d) => d.name) };
    }
    if (what === "doc") {
      if (!app.documents.length) { return null; }
      const d = app.activeDocument;
      return { name: d.name, mode: String(d.mode), width: Number(d.width), height: Number(d.height),
        active: d.activeLayers.map((l) => l.name), layers: d.layers.map((l) => layerInfo(l, 0)) };
    }
    if (what === "picker") {
      const thumbs = [...document.querySelectorAll(".panel-thumb-img")].map((i) => ({
        shown: i.style.display, srcHead: String(i.src || "").slice(0, 40), srcLen: String(i.src || "").length,
        natural: [i.naturalWidth, i.naturalHeight], complete: i.complete }));
      const summary = document.getElementById("panelSummary");
      return { chips: document.querySelectorAll(".panel-chip").length, summary: summary ? summary.textContent : null,
        thumbs: thumbs, picks: JSON.parse(JSON.stringify(typeof panelPicks !== "undefined" ? panelPicks : null)) };
    }
    if (what === "checkPanels") {
      const checks = document.querySelectorAll(".panel-check");
      for (const i of step.indexes) { if (checks[i - 1]) { checks[i - 1].click(); } }
      await sleep(800);
      return JSON.parse(JSON.stringify(panelPicks));
    }
    if (what === "text") {
      const el = document.getElementById(step.id);
      return el ? { text: el.textContent, value: el.value } : null;
    }
    if (what === "styles") {
      return [...document.querySelectorAll(step.selector)].slice(0, 5).map((el) => {
        const cs = getComputedStyle(el); const o = { text: (el.textContent || "").trim().slice(0, 40) };
        for (const pr of step.props) { o[pr] = cs[pr] || cs.getPropertyValue(pr); }
        return o;
      });
    }
    if (what === "dom") {
      const els = document.querySelectorAll(step.selector);
      return { count: els.length, first: els[0] ? els[0].outerHTML.slice(0, 300) : null };
    }
    throw new Error("unknown probe " + what);
  }

  async function runStep(data, step) {
    const out = { op: step.op, ok: true };
    try {
      if (step.op === "pickFiles") {
        pendingPick = [];
        for (const n of step.names) { pendingPick.push(await data.getEntry(n)); }
        out.value = pendingPick.length;
      } else if (step.op === "waitHost") {
        // Photoshop can still be in a startup modal state after the panel loads.
        const ps = window.require("photoshop");
        const t0 = Date.now();
        let ok = false, lastErr = null;
        while (Date.now() - t0 < (step.maxMs || 120000)) {
          try { await ps.core.executeAsModal(async () => {}, { commandName: "autotest ping" }); ok = true; break; }
          catch (e) { lastErr = String(e && e.message || e); await sleep(1500); }
        }
        if (!ok) { throw new Error("host stayed modal: " + lastErr); }
        out.value = Math.round((Date.now() - t0) / 1000) + "s";
      } else if (step.op === "saveTo") {
        pendingSave = step.name;
        out.value = step.name;
      } else if (step.op === "click") {
        const el = document.getElementById(step.id);
        if (!el) { throw new Error("no element " + step.id); }
        if (el.disabled) { throw new Error(step.id + " is disabled"); }
        el.click();
        out.value = await waitIdle(step.maxMs);
      } else if (step.op === "set") {
        const el = document.getElementById(step.id);
        if (!el) { throw new Error("no element " + step.id); }
        if (typeof step.checked === "boolean") {
          // Checkboxes are hidden inputs behind a styled row: click the row.
          if (!!el.checked !== step.checked) {
            const row = el.closest ? el.closest(".check") : el.parentNode;
            (row || el).click();
          }
          await sleep(80);
          out.value = { checked: !!el.checked, idle: await waitIdle(step.maxMs) };
        } else {
          el.value = step.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          out.value = await waitIdle(step.maxMs);
        }
      } else if (step.op === "wait") {
        await sleep(step.ms || 500);
      } else if (step.op === "waitIdle") {
        out.value = await waitIdle(step.maxMs);
      } else if (step.op === "probe") {
        out.value = await probe(step);
      } else {
        throw new Error("unknown op " + step.op);
      }
    } catch (e) {
      out.ok = false;
      out.error = (e && e.stack) ? String(e.stack) : String(e);
    }
    out.status = statusText();
    return out;
  }

  async function poll() {
    if (running) { return; }
    let data;
    try { data = await lfs.getDataFolder(); } catch (e) { return; }
    let job;
    try { job = await data.getEntry("autotest.json"); } catch (e) { return; }
    running = true;
    const results = [];
    try {
      const text = await job.read({ format: formats.text });
      const spec = JSON.parse(text);
      try { await job.delete(); } catch (e) { /* ignore */ }
      for (const step of (spec.steps || [])) {
        const r = await runStep(data, step);
        results.push(r);
        if (!r.ok && spec.stopOnError !== false) { break; }
      }
    } catch (e) {
      results.push({ op: "job", ok: false, error: String(e && e.stack || e) });
    }
    try {
      const outFile = await data.createFile("autotest-result.json", { overwrite: true });
      await outFile.write(JSON.stringify({ when: new Date().toISOString(), results: results }, null, 2),
        { format: formats.text });
    } catch (e) { console.error(e); }
    running = false;
  }

  window.addEventListener("load", function () { setInterval(poll, 2000); });
})();
