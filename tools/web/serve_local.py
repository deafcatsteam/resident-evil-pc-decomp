#!/usr/bin/env python3
"""Serve the web build and a data tree on http://localhost:8080 (testing only).

    python3 tools/web/serve_local.py [--build build/web] [--data ~/re1-web/data] [--port 8080]

/            the build folder: build/web in a checkout, www/ next to tools/ in
             the CI artifact (residentevil.html or index.html is served as /)
/data/...    the data folder (run tools/web/build_manifest.py on it first)

localhost counts as a secure context, so the Cache API works as it will behind
HTTPS. Not for the internet: no authentication, single process. The real
deployment is Caddy (docs/WEB_PORT.md).
"""
import argparse
import functools
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    build = "."
    data = "."
    page = "/index.html"

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
    }

    def translate_path(self, path):
        path = path.split("?", 1)[0].split("#", 1)[0]
        if path == "/":
            path = self.page
        if path.startswith("/data/"):
            base, rest = self.data, path[len("/data"):]
        else:
            base, rest = self.build, path
        saved = self.directory
        self.directory = base
        try:
            return super().translate_path(rest)
        finally:
            self.directory = saved

    def end_headers(self):
        if self.path.startswith("/data/") and "?v=" in self.path:
            self.send_header("Cache-Control", "private, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get("RE1_SERVE_QUIET") != "1":
            super().log_message(fmt, *args)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    default_build = os.path.join(repo, "build", "web")
    if not os.path.isdir(default_build):
        default_build = os.path.join(os.path.dirname(here), "www")   # CI artifact layout
    ap.add_argument("--build", default=default_build)
    ap.add_argument("--data", default=os.path.expanduser("~/re1-web/data"))
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--bind", default="127.0.0.1")
    args = ap.parse_args()

    build = os.path.abspath(args.build)
    data = os.path.abspath(args.data)
    pages = [n for n in ("index.html", "residentevil.html") if os.path.isfile(os.path.join(build, n))]
    if not pages:
        sys.exit(f"{build}: no index.html / residentevil.html - build the web target first")
    Handler.page = "/" + pages[0]
    if not os.path.isfile(os.path.join(data, "manifest.json")):
        print(f"warning: {data}/manifest.json missing - run tools/web/build_manifest.py {data}",
              file=sys.stderr)

    Handler.build, Handler.data = build, data
    server = http.server.ThreadingHTTPServer((args.bind, args.port),
                                             functools.partial(Handler, directory=build))
    print(f"build {build}\ndata  {data}\nhttp://localhost:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
