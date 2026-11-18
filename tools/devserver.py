"""Dev server for Пердун: serves the site and accepts POST /save?name=<file> into tools/out/.

Run:  python tools/devserver.py [port]   (default 8765), from any directory.
Only for local development; binds to 127.0.0.1.
"""
import http.server
import os
import re
import sys
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'tools', 'out')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        u = urlparse(self.path)
        name = parse_qs(u.query).get('name', [''])[0]
        if u.path != '/save' or not re.fullmatch(r'[\w.\-]{1,80}', name):
            self.send_error(400, 'bad save request')
            return
        n = int(self.headers.get('Content-Length', 0))
        data = self.rfile.read(n)
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, name), 'wb') as f:
            f.write(data)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'saved')


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
