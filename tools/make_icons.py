"""Rasterize web/icon.svg's simple shapes into PNG app icons (stdlib only, 4x supersampled)."""
import os, struct, zlib

BG, BLUE, LIGHT = (0x0f, 0x17, 0x2a), (0x6d, 0x9b, 0xff), (0xe7, 0xea, 0xf2)


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def color_at(x, y):
    """Color of the 512x512 design at (x, y), or None outside the background."""
    if not in_round_rect(x, y, 0, 0, 512, 512, 112):
        return None
    d2 = (x - 256) ** 2 + (y - 232) ** 2
    if d2 <= 14 ** 2 or 36 ** 2 <= d2 <= 56 ** 2:
        return LIGHT
    outer = in_round_rect(x, y, 82, 118, 430, 346, 36)
    inner = in_round_rect(x, y, 110, 146, 402, 318, 8)
    if outer and not inner:
        return BLUE
    if 236 <= x <= 276 and 332 <= y <= 376:
        return BLUE
    if in_round_rect(x, y, 176, 372, 336, 400, 14):
        return BLUE
    return BG


def render(size):
    scale, ss = 512 / size, 4
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    c = color_at((px + (sx + .5) / ss) * scale, (py + (sy + .5) / ss) * scale)
                    if c:
                        r += c[0]; g += c[1]; b += c[2]; a += 1
            n = ss * ss
            row += bytes([r // a, g // a, b // a, 255 * a // n] if a else [0, 0, 0, 0])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
    for size in (192, 512):
        with open(os.path.join(out, "icon-%d.png" % size), "wb") as f:
            f.write(render(size))
        print("wrote icon-%d.png" % size)
