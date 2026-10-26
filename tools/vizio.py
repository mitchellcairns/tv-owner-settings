"""Talk to a Vizio SmartCast / Vizio OS TV over its local API (the one the Vizio phone app uses).

Usage:
  vizio.py info  <ip>              read whatever the TV exposes without pairing
  vizio.py pair  <ip>              start pairing; the TV shows a PIN
  vizio.py pin   <ip> <PIN>        finish pairing; saves the auth token to .vizio_auth.json
  vizio.py dump  <ip> [out.json]   walk every settings menu (read-only) and save it
  vizio.py wait  <ip>              block until the TV's API port answers

Stdlib only. The TV uses a self-signed cert, so TLS verification is off for this host.
"""
import json, os, socket, ssl, sys, time, urllib.request, urllib.error, uuid

AUTH_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".vizio_auth.json")
PORTS = (7345, 9000)
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def load_auth():
    try:
        with open(AUTH_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_auth(data):
    with open(AUTH_FILE, "w") as f:
        json.dump(data, f, indent=2)


def find_port(ip):
    for port in PORTS:
        try:
            with socket.create_connection((ip, port), timeout=1.5):
                return port
        except OSError:
            pass
    return None


def call(ip, port, method, path, body=None, token=None, timeout=8):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request("https://%s:%d%s" % (ip, port, path), data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("AUTH", token)
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=timeout) as r:
            raw = r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
    except (TimeoutError, urllib.error.URLError, OSError) as e:
        return {"STATUS": {"RESULT": "CLIENT_ERROR", "DETAIL": str(e)}}
    try:
        return json.loads(raw)
    except ValueError:
        return {"_raw": raw}


def status(resp):
    return (resp.get("STATUS") or {}).get("RESULT", "?")


def cmd_wait(ip, minutes="30"):
    deadline = time.time() + float(minutes) * 60
    while find_port(ip) is None:
        if time.time() > deadline:
            sys.exit("Gave up waiting for %s after %s minutes." % (ip, minutes))
        time.sleep(3)
    print("API is up on", ip, "port", find_port(ip))


def cmd_info(ip):
    port = find_port(ip)
    if port is None:
        sys.exit("No API port open on %s; is the TV fully on?" % ip)
    print("API port:", port)
    token = load_auth().get(ip, {}).get("token")
    for path in ("/state/device/deviceinfo",
                 "/menu_native/dynamic/tv_settings/system/system_information/tv_information",
                 "/menu_native/dynamic/tv_settings/system/system_information/uli_information",
                 "/state/device/power_mode",
                 "/menu_native/dynamic/tv_settings/devices/current_input"):
        r = call(ip, port, "GET", path, token=token)
        print("\n==", path, "->", status(r))
        print(json.dumps(r, indent=1)[:4000])


def cmd_pair(ip):
    port = find_port(ip)
    auth = load_auth()
    dev_id = auth.get("_device_id") or "vizio-owner-" + uuid.uuid4().hex[:8]
    r = call(ip, port, "PUT", "/pairing/start", {"DEVICE_ID": dev_id, "DEVICE_NAME": "Vizio Owner Tools"})
    print("pairing/start ->", status(r))
    item = r.get("ITEM") or {}
    if "PAIRING_REQ_TOKEN" not in item:
        print(json.dumps(r, indent=1))
        return
    auth["_device_id"] = dev_id
    auth["_pending"] = {"ip": ip, "port": port, "req_token": item["PAIRING_REQ_TOKEN"],
                        "challenge": item.get("CHALLENGE_TYPE", 1)}
    save_auth(auth)
    print("A PIN should now be on the TV screen. Run: vizio.py pin %s <PIN>" % ip)


def cmd_pin(ip, pin):
    auth = load_auth()
    p = auth.get("_pending") or {}
    r = call(ip, p["port"], "PUT", "/pairing/pair", {
        "DEVICE_ID": auth["_device_id"], "CHALLENGE_TYPE": p["challenge"],
        "RESPONSE_VALUE": str(pin), "PAIRING_REQ_TOKEN": p["req_token"]})
    print("pairing/pair ->", status(r))
    token = (r.get("ITEM") or {}).get("AUTH_TOKEN")
    if not token:
        print(json.dumps(r, indent=1))
        return
    auth[ip] = {"token": token, "port": p["port"]}
    auth.pop("_pending", None)
    save_auth(auth)
    print("Paired. Token saved to .vizio_auth.json (keep it private).")


def walk(ip, port, token, path, depth=0, out=None):
    """Recursively GET every menu under /menu_native/dynamic/<path>, plus static option lists."""
    out = out if out is not None else []
    r = call(ip, port, "GET", "/menu_native/dynamic/" + path, token=token)
    items = r.get("ITEMS") or []
    for it in items:
        cname, typ = it.get("CNAME"), it.get("TYPE", "")
        sub = path + "/" + cname
        entry = {"path": sub, "name": it.get("NAME"), "type": typ, "value": it.get("VALUE"),
                 "hashval": it.get("HASHVAL"), "enabled": it.get("ENABLED"), "hidden": it.get("HIDDEN"),
                 "readonly": it.get("READONLY")}
        if typ in ("T_LIST_V1", "T_LIST_X_V1"):
            s = call(ip, port, "GET", "/menu_native/static/" + sub, token=token)
            sitems = s.get("ITEMS") or []
            if sitems:
                entry["options"] = sitems[0].get("ELEMENTS")
        out.append(entry)
        print("  " * depth + "%s [%s] = %r" % (cname, typ, it.get("VALUE")))
        if typ.startswith("T_MENU") or typ.startswith("T_ROOT_MENU") or it.get("ITEMS") is not None and not it.get("VALUE"):
            if depth < 8:
                walk(ip, port, token, sub, depth + 1, out)
    return out


def cmd_dump(ip, out_path=None):
    a = load_auth().get(ip)
    if not a:
        sys.exit("Not paired with %s yet; run pair/pin first." % ip)
    port, token = a["port"], a["token"]
    out = walk(ip, port, token, "tv_settings")
    out_path = out_path or os.path.join(os.path.dirname(AUTH_FILE), "settings-dump.json")
    with open(out_path, "w") as f:
        json.dump(out, f, indent=1)
    print("\nSaved %d entries to %s" % (len(out), out_path))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd, ip, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
    {"info": cmd_info, "pair": cmd_pair, "pin": cmd_pin, "dump": cmd_dump, "wait": cmd_wait}[cmd](ip, *rest)
