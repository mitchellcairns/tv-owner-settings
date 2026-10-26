"""Read-only probe: GET a list of known/likely endpoints on a paired TV and report which exist.

Usage: probe.py <ip> [path ...]   (defaults to the list below)
"""
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vizio

DEFAULT_PATHS = [
    "/state/device/deviceinfo",
    "/state/device/power_mode",
    "/state_extended",
    "/system/versions",
    "/pin/is_pin_default",
    "/audio/volume/level",
    "/audio/volume/mute",
    "/app/current",
    "/app/list",
    "/apps",
    "/menu_native/dynamic/audio_settings",
    "/menu_native/dynamic/tv_settings/system/timers/blank_screen",
    "/menu_native/dynamic/tv_settings/picture/picture_mode",
    "/menu_native/dynamic/tv_settings/devices/current_inputs",
]

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ip = sys.argv[1]
    a = vizio.load_auth()[ip]
    for path in sys.argv[2:] or DEFAULT_PATHS:
        r = vizio.call(ip, a["port"], "GET", path, token=a["token"])
        print("== %-60s %s" % (path, vizio.status(r)))
        if vizio.status(r) == "SUCCESS":
            print("   " + json.dumps({k: v for k, v in r.items() if k not in ("STATUS", "URI", "PARAMETERS")})[:700])
