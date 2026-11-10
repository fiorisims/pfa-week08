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
sleep 25
osascript -e 'tell application "System Events" to tell process "Adobe Photoshop 2026" to click menu item 1 of menu 1 of menu item "Color Script (fixes)" of menu "Plugins" of menu bar 1' >/dev/null 2>&1
sleep 4
echo "reloaded from $SRC"
