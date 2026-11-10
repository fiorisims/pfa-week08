#!/usr/bin/env python3
"""Drive the plugin's autotest hook: python3 tools/autotest.py steps.json [timeout_s]
Writes autotest.json into the plugin data folder, waits for autotest-result.json, prints it."""
import json, os, sys, time, glob
base = os.path.expanduser("~/Library/Application Support/Adobe/UXP/PluginsStorage/PHSP")
cands = glob.glob(base + "/*/External/com.fiorisims.colorscript.fixes/PluginData")
if not cands: sys.exit("plugin data folder not found")
data = sorted(cands)[-1]
spec = json.load(open(sys.argv[1]))
timeout = float(sys.argv[2]) if len(sys.argv) > 2 else 300
res = os.path.join(data, "autotest-result.json")
if os.path.exists(res): os.remove(res)
with open(os.path.join(data, "autotest.json"), "w") as f: json.dump(spec, f)
t0 = time.time()
while not os.path.exists(res):
    if time.time() - t0 > timeout: sys.exit("timed out after %.0fs" % timeout)
    time.sleep(1)
time.sleep(0.5)
out = json.load(open(res))
for r in out["results"]:
    print(("OK  " if r["ok"] else "ERR ") + r["op"], json.dumps(r.get("value"))[:300] if "value" in r else "", "| status:", r.get("status","")[:200])
    if not r["ok"]: print("    ", r.get("error","")[:600])
print("elapsed %.1fs" % (time.time() - t0))
