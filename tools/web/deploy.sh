#!/usr/bin/env bash
# deploy.sh - copy the web build and the data tree to the server (docs/WEB_PORT.md).
#
#     tools/web/deploy.sh [--build DIR] [--data DIR] [--no-data] DEST
#
# DEST is an rsync destination for the site folder, e.g. me@server:/srv/re1
# or a local /srv/re1. It receives:
#     DEST/www/        the page, the engine and the HD decoder worker
#     DEST/www/data/   the data tree, with a fresh manifest.json
# DEST/saves/ (the players' saves) is never touched.
#
# --build  the build: build/web in a checkout, or the artifact's www/
#          (default: whichever exists, as serve_local.py picks it)
# --data   the data tree (default ~/re1-web/data)
# --no-data  update the engine only
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build=""
data="$HOME/re1-web/data"
send_data=1
dest=""
while [ $# -gt 0 ]; do
    case "$1" in
        --build) build="$2"; shift 2 ;;
        --data) data="$2"; shift 2 ;;
        --no-data) send_data=0; shift ;;
        -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "unknown option $1" >&2; exit 2 ;;
        *) dest="${1%/}"; shift ;;
    esac
done
[ -n "$dest" ] || { echo "usage: $0 [--build DIR] [--data DIR] [--no-data] DEST" >&2; exit 2; }

if [ -z "$build" ]; then
    if [ -d "$here/../../build/web" ]; then build="$here/../../build/web"; else build="$here/../www"; fi
fi

# The page is index.html on the server; the build names it residentevil.html.
page="$build/index.html"
[ -f "$page" ] || page="$build/residentevil.html"
for f in "$page" "$build/residentevil.js" "$build/residentevil.wasm" \
         "$build/re1_hd_worker.js" "$build/re1_hd_worker.wasm"; do
    [ -f "$f" ] || { echo "$f missing - build the web target first" >&2; exit 1; }
done

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/www"
cp "$page" "$stage/www/index.html"
cp "$build"/residentevil.js "$build"/residentevil.wasm \
   "$build"/re1_hd_worker.js "$build"/re1_hd_worker.wasm "$stage/www/"

# The engine first: --delete clears what an older build left, but never data/.
rsync -rtv --delete --exclude=/data/ "$stage/www/" "$dest/www/"

if [ "$send_data" = 1 ]; then
    [ -d "$data" ] || { echo "$data: no data tree" >&2; exit 1; }
    python3 "$here/build_manifest.py" "$data"
    # Size+time comparison is enough: build_manifest.py tags by the same.
    # The manifest goes last, so a page loaded meanwhile never names a file
    # that is not there yet.
    rsync -rtv --delete --exclude=/manifest.json "$data/" "$dest/www/data/"
    rsync -tv "$data/manifest.json" "$dest/www/data/manifest.json"
fi
echo "done: $dest/www"
