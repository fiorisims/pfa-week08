#!/bin/zsh
# Sync a plugin folder (default: uxp-plugin/) into the installed "(fixes)" plugin and relaunch Photoshop
# in the background, then reopen the panel from the Plugins menu without bringing Photoshop forward.
set -u
SRC=${1:-${0:A:h}/../uxp-plugin}
D=$HOME/Library/Application\ Support/Adobe/UXP/Plugins/External/com.fiorisims.colorscript.fixes_1.8.0
rsync -a --delete --exclude '.*' "$SRC/" "$D/"
osascript -e 'tell application "Adobe Photoshop 2026" to quit' >/dev/null 2>&1
for i in $(seq 1 60); do pgrep -x "Adobe Photoshop 2026" >/dev/null || break; sleep 1; done
open -g -a "Adobe Photoshop 2026"
for i in $(seq 1 60); do pgrep -x "Adobe Photoshop 2026" >/dev/null && break; sleep 1; done
sleep 15
# Open the panel from the Plugins menu (no activate: Photoshop stays in the background), until it answers.
P=$HOME/Library/Application\ Support/Adobe/UXP/PluginsStorage/PHSP/27/External/com.fiorisims.colorscript.fixes/PluginData
mkdir -p "$P"
for i in $(seq 1 12); do
  osascript -e 'tell application "System Events" to tell process "Adobe Photoshop 2026" to click menu item 1 of menu 1 of menu item "Color Script (fixes)" of menu "Plugins" of menu bar 1' >/dev/null 2>&1
  rm -f "$P/autotest-result.json"; echo '{"steps":[{"op":"wait","ms":10}]}' > "$P/autotest.json"
  for j in $(seq 1 6); do [[ -e "$P/autotest-result.json" ]] && break; sleep 1; done
  [[ -e "$P/autotest-result.json" ]] && { echo "panel answered after $i click(s)"; break; }
  sleep 4
done
rm -f "$P/autotest.json"
echo "reloaded from $SRC"
