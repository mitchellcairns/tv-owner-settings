"""TCP connect scan of one host. Usage: portscan.py <ip> [max_port]"""
import socket, sys, concurrent.futures

ip = sys.argv[1]
max_port = int(sys.argv[2]) if len(sys.argv) > 2 else 65535

def check(port):
    try:
        with socket.create_connection((ip, port), timeout=0.4):
            return port
    except OSError:
        return None

with concurrent.futures.ThreadPoolExecutor(400) as ex:
    open_ports = [p for p in ex.map(check, range(1, max_port + 1)) if p]
print(ip, "open:", open_ports)
