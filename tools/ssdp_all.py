"""List every SSDP responder on the LAN with its SERVER / LOCATION headers and device description."""
import socket, time, re, urllib.request

msg = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n"
       'MAN: "ssdp:discover"\r\nMX: 3\r\nST: ssdp:all\r\n\r\n').encode()
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
s.settimeout(0.5)
for _ in range(3):
    s.sendto(msg, ("239.255.255.250", 1900))
seen = {}
end = time.time() + 6
while time.time() < end:
    try:
        data, addr = s.recvfrom(65535)
    except socket.timeout:
        continue
    text = data.decode(errors="replace")
    hdr = {k.lower(): v.strip() for k, v in re.findall(r"^([^:\r\n]+):(.*)$", text, re.M)}
    seen.setdefault(addr[0], set()).add((hdr.get("server", ""), hdr.get("location", ""), hdr.get("st", "")))

for ip in sorted(seen, key=lambda x: tuple(int(p) for p in x.split("."))):
    print(ip)
    locs = set()
    for server, loc, st in sorted(seen[ip]):
        print("   server=%s  st=%s  loc=%s" % (server, st, loc))
        if loc:
            locs.add(loc)
    for loc in sorted(locs)[:2]:
        try:
            body = urllib.request.urlopen(loc, timeout=3).read().decode(errors="replace")
            for tag in ("friendlyName", "manufacturer", "modelName", "modelNumber", "modelDescription"):
                m = re.search(r"<%s>(.*?)</%s>" % (tag, tag), body)
                if m:
                    print("      %s: %s" % (tag, m.group(1)))
        except Exception as e:
            print("      (desc fetch failed: %s)" % e)
