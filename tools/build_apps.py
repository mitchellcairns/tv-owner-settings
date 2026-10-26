"""Build web/apps.json: launch payloads for popular apps, per chipset and firmware range.

Source is Vizio's public SmartCast app feed (the same one the Vizio mobile app reads). Browsers can't
fetch it directly (no CORS headers), so the PWA ships this trimmed copy. Re-run to refresh.
"""
import json, os, urllib.request

FEED = "https://scfs.vizio.com/appservice/"
APPS = [
    "Netflix", "YouTube", "Prime Video", "Disney+", "Hulu", "HBO Max", "Apple TV+", "Plex",
    "Peacock", "Paramount+", "ESPN+", "YouTube TV", "Sling TV", "Tubi", "Pluto TV", "Pandora", "Crunchyroll",
]


def fetch(name):
    with urllib.request.urlopen(FEED + name, timeout=30) as r:
        return json.load(r)


if __name__ == "__main__":
    catalog = {a["name"]: a for a in fetch("vizio_apps_prod.json")}
    availability = {a["id"]: a["chipsets"] for a in fetch("app_availability_prod.json")}
    out = []
    for name in APPS:
        app = catalog.get(name)
        chipsets = app and availability.get(app["id"])
        if not chipsets:
            print("skipped (not in feed):", name)
            continue
        out.append({
            "name": name,
            "chipsets": {
                chip: [{"payload": json.loads(e["app_type_payload"]), "min": e["firmwareMinimum"], "max": e["firmwareMaximum"]}
                       for e in entries]
                for chip, entries in chipsets.items()
            },
        })
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "apps.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote %d apps to web/apps.json" % len(out))
