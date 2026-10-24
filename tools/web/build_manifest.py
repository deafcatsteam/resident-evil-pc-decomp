#!/usr/bin/env python3
"""Write manifest.json for the web build's data tree.

The web build (src/platform/web/vfs.js) mounts this list under /re1 before the
game starts: every directory, and an empty placeholder per file whose bytes are
fetched the first time the game reads it. Run it on the folder that holds the
asset migrator's output (USA/, and DC/, HD/, JPN/, SATURN/ when present), and
again whenever that folder changes:

    python3 tools/web/build_manifest.py ~/re1-web/data

Entry: [path relative to the folder, size, tag]. The tag is appended to the URL
as ?v=, so a URL never changes meaning and the server can mark data immutable.
By default it is derived from size and modification time (instant on 2 GB);
--hash uses the file contents instead (slower, survives copies that reset
mtimes).

Skipped: manifest.json itself, dot files, and the save folder and config.ini
(the web build keeps those apart - they belong to the player, not the data).
"""
import argparse
import hashlib
import json
import os
import sys

SKIP_TOP = {"save", "config.ini", "manifest.json"}


def tag_for(path, st, by_content):
    h = hashlib.sha1()
    if by_content:
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                h.update(block)
    else:
        h.update(f"{st.st_size}:{st.st_mtime_ns}".encode())
    return h.hexdigest()[:10]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("data", help="the data folder (contains USA/)")
    ap.add_argument("--hash", action="store_true", help="tag files by content")
    args = ap.parse_args()

    root = os.path.abspath(args.data)
    if not os.path.isdir(root):
        sys.exit(f"{root}: not a folder")
    tops = {n.lower() for n in os.listdir(root)}
    if "usa" not in tops and "jpn" not in tops:
        print(f"warning: {root} has no USA/ or JPN/ folder - the game needs one", file=sys.stderr)

    files = []
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == ".":
            dirnames[:] = [d for d in dirnames if d.lower() not in SKIP_TOP]
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            if rel_dir == "." and name.lower() in SKIP_TOP:
                continue
            full = os.path.join(dirpath, name)
            st = os.stat(full)
            rel = name if rel_dir == "." else f"{rel_dir}/{name}".replace(os.sep, "/")
            files.append([rel, st.st_size, tag_for(full, st, args.hash)])
            total += st.st_size

    out = os.path.join(root, "manifest.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "files": files}, f, separators=(",", ":"))
    print(f"{out}: {len(files)} files, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
