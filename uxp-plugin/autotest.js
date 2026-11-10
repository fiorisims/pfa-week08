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
    return el ? el.textContent : "";
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async function waitIdle(maxMs) {
    const t0 = Date.now();
    await sleep(400);
    for (;;) {
      const bar = document.getElementById("progress");
      const busy = (bar && bar.style.display !== "none") ||
        /\.\.\.$/.test(statusText().trim());
      if (!busy) { return true; }
      if (Date.now() - t0 > (maxMs || 120000)) { return false; }
      await sleep(250);
    }
  }

  async function runStep(data, step) {
    const out = { op: step.op, ok: true };
    try {
      if (step.op === "pickFiles") {
        pendingPick = [];
        for (const n of step.names) { pendingPick.push(await data.getEntry(n)); }
        out.value = pendingPick.length;
      } else if (step.op === "click") {
        const el = document.getElementById(step.id);
        if (!el) { throw new Error("no element " + step.id); }
        if (el.disabled) { throw new Error(step.id + " is disabled"); }
        el.click();
        out.value = await waitIdle(step.maxMs);
      } else if (step.op === "set") {
        const el = document.getElementById(step.id);
        if (!el) { throw new Error("no element " + step.id); }
        if (typeof step.checked === "boolean") { el.checked = step.checked; }
        else { el.value = step.value; }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        out.value = await waitIdle(step.maxMs);
      } else if (step.op === "wait") {
        await sleep(step.ms || 500);
      } else if (step.op === "waitIdle") {
        out.value = await waitIdle(step.maxMs);
      } else if (step.op === "eval") {
        const fn = new Function(step.js);
        out.value = await fn();
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
