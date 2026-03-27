#!/usr/bin/env python3
"""Write a solid RGBA PNG (stdlib only) for `npx tauri icon` input."""
import binascii
import struct
import zlib
from pathlib import Path


def _chunk(chunk_type: bytes, data: bytes) -> bytes:
    crc = binascii.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)


def rgba_png(width: int, height: int, r: int, g: int, b: int, a: int = 255) -> bytes:
    row = b"\x00" + bytes([r, g, b, a]) * width
    raw = row * height
    compressed = zlib.compress(raw, 9)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    sig = b"\x89PNG\r\n\x1a\n"
    return sig + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", compressed) + _chunk(b"IEND", b"")


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "src-tauri" / "app-icon.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    # Brand-ish blue (matches default SVG pet idle tone)
    out.write_bytes(rgba_png(1024, 1024, 100, 180, 255, 255))
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
