"""Development relay: http://localhost:8138/<path> -> https://<tv>:7345/<path>, with CORS.

Lets the PWA be tested in browsers that can't accept the TV's certificate (e.g. embedded previews).
Usage: dev_proxy.py <tv-ip> [listen-port]
"""
import http.server, ssl, sys, urllib.request, urllib.error

TV = sys.argv[1]
LISTEN = int(sys.argv[2]) if len(sys.argv) > 2 else 8138
try:
    import json, os
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".vizio_auth.json")) as f:
        DEV_TOKEN = json.load(f).get(TV, {}).get("token")
except (OSError, ValueError):
    DEV_TOKEN = None
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


class Relay(http.server.BaseHTTPRequestHandler):
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type, AUTH")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def relay(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)) or None
        req = urllib.request.Request("https://%s:7345%s" % (TV, self.path), data=body, method=self.command)
        req.add_header("Content-Type", "application/json")
        auth = self.headers.get("AUTH")
        if auth == "dev":  # use the token tools/vizio.py saved, so the preview needn't pair again
            auth = DEV_TOKEN
        if auth:
            req.add_header("AUTH", auth)
        try:
            with urllib.request.urlopen(req, context=CTX, timeout=10) as r:
                status, data = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, data = e.code, e.read()
        except OSError as e:
            self.send_response(502)
            self.cors()
            self.end_headers()
            self.wfile.write(str(e).encode())
            return
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_PUT = relay


if __name__ == "__main__":
    print("relaying http://localhost:%d -> https://%s:7345" % (LISTEN, TV))
    http.server.ThreadingHTTPServer(("127.0.0.1", LISTEN), Relay).serve_forever()
