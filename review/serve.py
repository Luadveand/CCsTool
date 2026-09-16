#!/usr/bin/env python3
"""Static file server with HTTP Range support (stdlib only).

Why not `python3 -m http.server`: it ignores the `Range` header and always
answers 200 with the whole file, so the browser cannot seek into a large
audio file — pressing play restarts at 0 and dragging the progress bar fails.
"""
import argparse
import os
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

CHUNK = 64 * 1024
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


class RangeHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()  # directories: default behavior
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        try:
            total = os.fstat(f.fileno()).st_size
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Length", str(total))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Last-Modified", self.date_time_string(os.path.getmtime(path)))
            self.end_headers()
            return f
        except Exception:
            f.close()
            raise

    def do_GET(self):
        path = self.translate_path(self.path)
        if not os.path.isdir(path):
            range_header = self.headers.get("Range")
            if range_header and (rng := self._parse_range(range_header)) is not None:
                start, end = rng
                size = os.path.getsize(path)
                if end < start or start >= size:
                    self._send_416(path)
                    return
                self._send_range(path, start, end)
                return
        super().do_GET()

    def _parse_range(self, header):
        m = RANGE_RE.match(header.strip())
        if not m:
            return None  # malformed: serve full file
        first, last = m.group(1), m.group(2)
        size = os.path.getsize(self.translate_path(self.path))
        if first == "" and last == "":
            return None
        if first == "":  # suffix: bytes=-N (last N bytes)
            n = min(int(last), size)
            if n == 0:
                return (0, -1)  # sentinel: handled as 416 path
            return (size - n, size - 1)
        start = int(first)
        end = int(last) if last else size - 1
        end = min(end, size - 1)
        if start > end:
            return (start, -1)  # sentinel: unsatisfiable
        return (start, end)

    def _send_416(self, path):
        total = os.path.getsize(path)
        self.send_response(416)
        self.send_header("Content-Range", "bytes */%d" % total)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_range(self, path, start, end):
        total = os.path.getsize(path)
        length = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, total))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(CHUNK, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except BrokenPipeError:
                    return
                remaining -= len(chunk)


def main():
    ap = argparse.ArgumentParser(description="Static server with Range support")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--directory", default=os.path.dirname(os.path.abspath(__file__)))
    args = ap.parse_args()

    handler = lambda *a, **kw: RangeHandler(*a, directory=args.directory, **kw)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving {args.directory} on http://{args.host}:{args.port} (Range enabled)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
