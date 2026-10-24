#!/usr/bin/env python3
"""Serve the web build, a data tree and a save folder on localhost (testing only).

    python3 tools/web/serve_local.py [--build build/web] [--data ~/re1-web/data]
                                     [--saves ~/re1-web/saves] [--port 8080]

/            the build folder: build/web in a checkout, www/ next to tools/ in
             the CI artifact (residentevil.html or index.html is served as /)
/data/...    the data folder (run tools/web/build_manifest.py on it first);
             byte ranges are honoured, which the movies need to seek
/saves/...   the save folder, through the handful of WebDAV methods the page
             uses (PROPFIND, GET, PUT, MKCOL) - what Caddy's webdav does on
             the real server

localhost counts as a secure context, so the Cache API works as it will behind
HTTPS. Not for the internet: no authentication, single user. The real
deployment is Caddy (docs/WEB_PORT.md).
"""
import argparse
import errno
import functools
import html
import http.server
import os
import re
import sys
import urllib.parse


class Handler(http.server.SimpleHTTPRequestHandler):
    build = "."
    data = "."
    saves = "."
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
        elif path.startswith("/saves/") or path == "/saves":
            base, rest = self.saves, path[len("/saves"):] or "/"
        else:
            base, rest = self.build, path
        saved = self.directory
        self.directory = base
        try:
            return super().translate_path(rest)
        finally:
            self.directory = saved

    def is_saves(self):
        p = self.path.split("?", 1)[0]
        return p == "/saves" or p.startswith("/saves/")

    def end_headers(self):
        if self.path.startswith("/data/") and "?v=" in self.path:
            self.send_header("Cache-Control", "private, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ---- byte ranges (the <video> element seeks with them)
    def send_head(self):
        self.range = None
        spec = self.headers.get("Range")
        path = self.translate_path(self.path)
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", spec.strip()) if spec else None
        if m is None or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        if m.group(1):
            start = int(m.group(1))
            end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
        else:
            start, end = max(0, size - int(m.group(2) or 0)), size - 1
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        f = open(path, "rb")
        f.seek(start)
        self.range = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(self.range))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        if getattr(self, "range", None) is None:
            return super().copyfile(source, outputfile)
        left = self.range
        while left > 0:
            block = source.read(min(left, 1 << 16))
            if not block:
                break
            outputfile.write(block)
            left -= len(block)

    # ---- the WebDAV subset under /saves/
    def do_PROPFIND(self):
        if not self.is_saves():
            return self.send_error(405)
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        path = self.translate_path(self.path)
        if not os.path.exists(path):
            return self.send_error(404)
        href = urllib.parse.urlsplit(self.path).path
        entries = [(href, path)]
        if os.path.isdir(path) and self.headers.get("Depth", "1") != "0":
            if not href.endswith("/"):
                href += "/"
            for name in sorted(os.listdir(path)):
                full = os.path.join(path, name)
                entries.append((href + urllib.parse.quote(name) + ("/" if os.path.isdir(full) else ""), full))
        parts = ['<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">']
        for h, full in entries:
            kind = "<D:collection/>" if os.path.isdir(full) else ""
            parts.append(f"<D:response><D:href>{html.escape(h)}</D:href><D:propstat><D:prop>"
                         f"<D:resourcetype>{kind}</D:resourcetype></D:prop>"
                         "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>")
        parts.append("</D:multistatus>")
        body = "".join(parts).encode()
        self.send_response(207)
        self.send_header("Content-Type", "application/xml; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        if not self.is_saves():
            return self.send_error(405)
        path = self.translate_path(self.path)
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if not os.path.isdir(os.path.dirname(path)):
            return self.send_error(409)
        existed = os.path.exists(path)
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, path)
        self.send_response(204 if existed else 201)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_MKCOL(self):
        if not self.is_saves():
            return self.send_error(405)
        path = self.translate_path(self.path)
        if os.path.exists(path):
            return self.send_error(405)
        os.makedirs(path)
        self.send_response(201)
        self.send_header("Content-Length", "0")
        self.end_headers()

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
    ap.add_argument("--saves", default=os.path.expanduser("~/re1-web/saves"))
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--bind", default="127.0.0.1")
    args = ap.parse_args()

    build = os.path.abspath(args.build)
    data = os.path.abspath(args.data)
    saves = os.path.abspath(args.saves)
    pages = [n for n in ("index.html", "residentevil.html") if os.path.isfile(os.path.join(build, n))]
    if not pages:
        sys.exit(f"{build}: no index.html / residentevil.html - build the web target first")
    Handler.page = "/" + pages[0]
    if not os.path.isfile(os.path.join(data, "manifest.json")):
        print(f"warning: {data}/manifest.json missing - run tools/web/build_manifest.py {data}",
              file=sys.stderr)
    os.makedirs(saves, exist_ok=True)

    Handler.build, Handler.data, Handler.saves = build, data, saves
    try:
        server = http.server.ThreadingHTTPServer((args.bind, args.port),
                                                 functools.partial(Handler, directory=build))
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            sys.exit(f"port {args.port} is already in use by another program - "
                     f"pick another one, e.g. --port {args.port + 1}")
        raise
    print(f"build {build}\ndata  {data}\nsaves {saves}\nhttp://localhost:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
