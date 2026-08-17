#!/usr/bin/env python3
"""Static dev server for Neon Pug Shooter.

Same as `python3 -m http.server`, except every response carries no-store headers.
Without that the browser happily serves yesterday's main.js after an edit, which
looks exactly like the change never happened.
"""
import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    # conditional requests would still hand back 304s, so answer everything fresh
    def send_head(self):
        self.headers.replace_header('If-Modified-Since', '') if 'If-Modified-Since' in self.headers else None
        if 'If-None-Match' in self.headers:
            del self.headers['If-None-Match']
        return super().send_head()

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(('', PORT), handler) as httpd:
        print(f'serving {ROOT} on http://localhost:{PORT} (no-store)')
        httpd.serve_forever()
