"""mitmproxy addon: record the Mahlkoenig Sync app's API traffic, redacted.

Used to find the endpoints the mobile app uses for home accounts (docs/sync-api.md, Q8).
Only flows to *.mahlkoenig.com are recorded. Authorization/cookie headers, the login request
body, tokens and personal or hardware identifiers are never written; identifiers are replaced
by stable aliases such as "<id:3>" so equal values stay recognisable.

Usage (from the repo root):
    mitmweb --mode wireguard -s scripts/capture.py

Output: probe-output/capture-<timestamp>.jsonl (gitignored), one JSON object per request or
WebSocket message. Look through it before sharing it anyway.
"""

import json
import re
import time
from pathlib import Path

from mitmproxy import http, tls

HOST_RE = re.compile(r"(^|\.)mahlkoenig\.com$")
REDACT_KEYS = {
    "user", "username", "email", "mail", "name", "firstname", "lastname", "fullname",
    "phone", "address", "street", "city", "zip", "postalcode",
    "serial", "serialnumber", "storeid", "companyid", "regionid", "userid", "accountid",
    "deviceid", "grinderid", "brewerid", "bindingcode", "hmihwproductid", "macaddress", "mac", "ip",
    "password", "secret", "access_token", "accesstoken", "refresh_token", "refreshtoken",
    "token", "id_token", "idtoken", "jwt", "sub", "comp", "storeids", "deviceids", "companyids",
    "fromdeviceid", "todeviceid", "togrinderid", "profileid", "key", "pushtoken",
}
# Any key naming a device, user or organisation id (toBrewerId, fromDeviceId, …).
ID_KEY_RE = re.compile(r"(device|grinder|brewer|store|company|region|user|profile|account)ids?$", re.I)
SENSITIVE_HEADERS = {"authorization", "cookie", "set-cookie", "x-auth-token"}
EMAIL_RE = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
JWT_RE = re.compile(r"^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*$")
MAX_BODY_CHARS = 20000

aliases: dict = {}


def alias(value, kind="id"):
    key = f"{type(value).__name__}:{value}"
    if key not in aliases:
        aliases[key] = f"<{kind}:{len(aliases) + 1}>"
    return aliases[key]


def redact(value, key=""):
    if isinstance(value, list):
        return [redact(v, key) for v in value]
    if isinstance(value, dict):
        return {k: redact(v, k) for k, v in value.items()}
    if value is None or isinstance(value, bool):
        return value
    if key.lower() in REDACT_KEYS or ID_KEY_RE.search(key):
        return alias(value)
    if isinstance(value, str) and JWT_RE.match(value):
        return alias(value, "jwt")
    if isinstance(value, str) and EMAIL_RE.search(value):
        return alias(value, "email")
    return value


def redact_query(path):
    if "?" not in path:
        return path
    base, query = path.split("?", 1)
    parts = []
    for pair in query.split("&"):
        k, _, v = pair.partition("=")
        parts.append(f"{k}={redact(v, k)}" if v else k)
    return f"{base}?{'&'.join(parts)}"


def body(content, content_type):
    if not content:
        return None
    text = content.decode("utf-8", errors="replace")
    if "json" in (content_type or "") or text[:1] in "{[":
        try:
            return redact(json.loads(text))
        except ValueError:
            pass
    return f"<{len(content)} bytes, {content_type or 'unknown type'}>"


def headers(h):
    return {k: ("<redacted>" if k.lower() in SENSITIVE_HEADERS else v) for k, v in h.items()}


class Capture:
    def __init__(self):
        out = Path(__file__).resolve().parent.parent / "probe-output"
        out.mkdir(exist_ok=True)
        self.file = out / f"capture-{time.strftime('%Y-%m-%dT%H-%M-%S')}.jsonl"
        print(f"[capture] writing Sync traffic to {self.file}")

    def write(self, record):
        line = json.dumps(record, ensure_ascii=False)
        with self.file.open("a", encoding="utf-8") as f:
            f.write(line[: MAX_BODY_CHARS * 3] + "\n")

    def response(self, flow: http.HTTPFlow):
        if not HOST_RE.search(flow.request.pretty_host):
            return
        req, res = flow.request, flow.response
        is_login = req.path.startswith("/api/security-service/auth")
        self.write({
            "type": "http",
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "method": req.method,
            "host": req.pretty_host,
            "path": redact_query(req.path),
            "requestHeaders": headers(req.headers),
            # The login request carries the password: never record its body.
            "requestBody": "<omitted: auth request>" if is_login else body(req.content, req.headers.get("content-type")),
            "status": res.status_code if res else None,
            "responseHeaders": headers(res.headers) if res else None,
            "responseBody": body(res.content, res.headers.get("content-type")) if res else None,
        })
        print(f"[capture] {req.method} {req.pretty_host}{redact_query(req.path)} -> {res.status_code if res else '?'}")

    def websocket_message(self, flow: http.HTTPFlow):
        if not HOST_RE.search(flow.request.pretty_host):
            return
        msg = flow.websocket.messages[-1]
        self.write({
            "type": "websocket",
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "path": redact_query(flow.request.path),
            "fromClient": msg.from_client,
            "message": body(msg.content, "application/json") if msg.is_text else f"<{len(msg.content)} binary bytes>",
        })

    def tls_failed_client(self, data: tls.TlsData):
        sni = data.conn.sni or "?"
        if HOST_RE.search(sni):
            print(f"[capture] TLS handshake with the app FAILED for {sni}: the app rejects the "
                  "mitmproxy certificate (pinning, or the CA isn't trusted).")
            self.write({"type": "tls_failed", "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "sni": sni})


addons = [Capture()]
