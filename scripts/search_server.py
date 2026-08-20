#!/usr/bin/env python3
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import re
from ddgs import DDGS


AD_LINK_MARKERS = (
    '/aclick',
    'doubleclick.net',
    'googleadservices.com',
    'googlesyndication.com',
)


def is_ad_link(url):
    lower = (url or '').lower()
    return any(marker in lower for marker in AD_LINK_MARKERS)


def clean_title(raw_title):
    title = (raw_title or '').strip()
    if '\u203a' in title:
        title = title.rsplit('\u203a', 1)[-1].strip()
    title = re.sub(r'^[a-z0-9]+(?:-[a-z0-9]+)*(?=[A-Z])', '', title)
    return title.strip()


class ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True


class SearchHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path not in ('/search', '/v1/search', '/v2/search'):
            self.send_error(404)
            return
        length = int(self.headers.get('content-length', 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = {}
        query = (data.get('query') or '').strip()
        limit = int(data.get('limit') or 5)
        if not query:
            response = {'success': False, 'error': 'query is required'}
            self.send_response(400)
            self.send_header('content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
            return

        try:
            results = DDGS().text(query, max_results=limit)
        except Exception as err:
            response = {'success': False, 'error': str(err)}
            self.send_response(500)
            self.send_header('content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
            return

        web = [
            {
                'title': clean_title(item.get('title', '')),
                'url': item.get('href', ''),
                'description': item.get('body', ''),
            }
            for item in results
            if item.get('href') and not is_ad_link(item.get('href'))
        ]
        response = {'success': True, 'data': {'query': query, 'web': web}}
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())

    def log_message(self, format, *args):
        return None


if __name__ == '__main__':
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3003
    ReusableHTTPServer(('127.0.0.1', port), SearchHandler).serve_forever()
