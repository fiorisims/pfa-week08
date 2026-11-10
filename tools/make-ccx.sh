#!/bin/zsh
# Pack uxp-plugin/ into dist/ColorScript-<version>.ccx (a zip of the plugin folder's contents).
set -eu
cd "${0:A:h}/.."
v=$(python3 -c "import json;print(json.load(open('uxp-plugin/manifest.json'))['version'])")
mkdir -p dist; out="$PWD/dist/ColorScript-$v.ccx"; rm -f "$out"
(cd uxp-plugin && zip -qr "$out" . -x '.*' -x '__MACOSX*')
echo "$out"
