#!/bin/zsh
# Run one autotest under the shared heavy-app lock: tools/pstest.sh steps.json [timeout]
# Optional: RELOAD=1 tools/pstest.sh steps.json  (reload the plugin first, same lock)
set -u
H=${0:A:h}
cd $H/..
exec $HOME/sva-midterm-fixes/_heavy.sh sh -c "[[ -n \"\${RELOAD:-}\" ]] && $H/reload.sh; python3 $H/autotest.py ${1:?steps.json} ${2:-400}"
