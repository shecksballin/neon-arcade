#!/usr/bin/env python3
"""rename_clip.py - rename animation clips inside a GLB (stdlib only).
Usage: python3 rename_clip.py model.glb OldName NewName [Old2 New2 ...]
"""
import json
import struct
import sys

MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A


def main():
    path = sys.argv[1]
    pairs = list(zip(sys.argv[2::2], sys.argv[3::2]))
    with open(path, "rb") as f:
        data = f.read()
    magic, version, _ = struct.unpack_from("<III", data, 0)
    if magic != MAGIC or version != 2:
        raise SystemExit(f"{path}: not a GLB v2")
    chunks, off = [], 12
    while off < len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        chunks.append((ctype, data[off + 8: off + 8 + clen]))
        off += 8 + clen
    out = []
    for ctype, payload in chunks:
        if ctype == CHUNK_JSON:
            g = json.loads(payload.decode("utf-8"))
            for anim in g.get("animations", []):
                for old, new in pairs:
                    if anim.get("name") == old:
                        anim["name"] = new
                        print(f"renamed clip '{old}' -> '{new}'")
            payload = json.dumps(g, separators=(",", ":")).encode("utf-8")
        out.append((ctype, payload))
    body = b""
    for ctype, payload in out:
        pad = (4 - len(payload) % 4) % 4
        payload += (b" " if ctype == CHUNK_JSON else b"\x00") * pad
        body += struct.pack("<II", len(payload), ctype) + payload
    with open(path, "wb") as f:
        f.write(struct.pack("<III", MAGIC, 2, 12 + len(body)) + body)
    print(f"saved {path}")


if __name__ == "__main__":
    main()
