"""Find Vizio SmartCast TVs on the local /24: SSDP + TCP probe of 7345/9000/8008."""
import socket, concurrent.futures, sys, time

SUBNET = sys.argv[1] if len(sys.argv) > 1 else "192.168.1"

def ssdp(st, wait=4):
    msg = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n"
           'MAN: "ssdp:discover"\r\nMX: 2\r\nST: %s\r\n\r\n' % st).encode()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    s.settimeout(0.5)
    s.sendto(msg, ("239.255.255.250", 1900))
    s.sendto(msg, ("239.255.255.250", 1900))
    found = {}
    end = time.time() + wait
    while time.time() < end:
        try:
            data, addr = s.recvfrom(65535)
        except socket.timeout:
            continue
        found.setdefault(addr[0], []).append(data.decode(errors="replace"))
    return found

def probe(ip):
    open_ports = []
    for port in (7345, 9000, 8008):
        try:
            with socket.create_connection((ip, port), timeout=0.6):
                open_ports.append(port)
        except OSError:
            pass
    return ip, open_ports

print("== SSDP kinoma (Vizio SmartCast) ==")
for ip, resps in ssdp("urn:schemas-kinoma-com:device:shell:1").items():
    print(ip)
    for r in resps[:1]:
        print("  " + r.strip().replace("\r\n", "\n  "))

print("\n== TCP probe %s.0/24 for 7345/9000/8008 ==" % SUBNET)
with concurrent.futures.ThreadPoolExecutor(128) as ex:
    for ip, ports in ex.map(probe, ["%s.%d" % (SUBNET, i) for i in range(1, 255)]):
        if ports:
            print(ip, ports)
