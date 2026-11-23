"""Seal the app's data files so that only paired devices can read them.

Every data file the collectors write (articles, archives, maritime brief, freight) is
compressed and encrypted with AES-256-GCM. The key is a random 32-byte value kept in two
places only: the repository secret APP_KEY (so the daily run can read yesterday's state and
write today's edition) and the browser storage of the devices you pair with it.

The published app and the public repository therefore only hold ciphertext:

    {"sealed": "A256GCM+gzip", "iv": "<base64url>", "data": "<base64url>"}

Command line:
    python collector/vault.py seal FILE...    encrypt any file that is still plain (idempotent)
    python collector/vault.py open FILE       print a sealed file as JSON (needs APP_KEY)
    python collector/vault.py new-key         print a fresh random key
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import secrets
import sys
from pathlib import Path

ALG = "A256GCM+gzip"


def b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def key() -> bytes | None:
    """The key from APP_KEY, or None when it is not set."""
    text = os.environ.get("APP_KEY", "").strip()
    if not text:
        return None
    raw = b64d(text)
    if len(raw) != 32:
        raise SystemExit("APP_KEY must be 32 bytes in base64url (43 characters).")
    return raw


def is_sealed(doc) -> bool:
    return isinstance(doc, dict) and doc.get("sealed") == ALG


def seal(payload, k: bytes) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    plain = gzip.compress(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9, mtime=0)
    iv = secrets.token_bytes(12)
    return {"sealed": ALG, "iv": b64e(iv), "data": b64e(AESGCM(k).encrypt(iv, plain, None))}


def unseal(doc: dict, k: bytes | None):
    if not is_sealed(doc):
        return doc
    if k is None:
        raise SystemExit("This data file is sealed: set APP_KEY to read it.")
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    plain = AESGCM(k).decrypt(b64d(doc["iv"]), b64d(doc["data"]), None)
    return json.loads(gzip.decompress(plain).decode("utf-8"))


def write(path: Path, payload) -> None:
    """Write a data file, sealed when a key is available."""
    k = key()
    path.parent.mkdir(parents=True, exist_ok=True)
    if k is None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    else:
        path.write_text(json.dumps(seal(payload, k)) + "\n", encoding="utf-8")


def read(path: Path):
    return unseal(json.loads(path.read_text(encoding="utf-8")), key()) if path.exists() else {}


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in {"seal", "open", "new-key"}:
        print(__doc__)
        return 2
    if argv[0] == "new-key":
        print(b64e(secrets.token_bytes(32)))
        return 0
    k = key()
    if k is None:
        print("APP_KEY is not set.", file=sys.stderr)
        return 1
    if argv[0] == "open":
        print(json.dumps(read(Path(argv[1])), ensure_ascii=False, indent=1))
        return 0
    for name in argv[1:]:
        path = Path(name)
        if not path.exists():
            continue
        doc = json.loads(path.read_text(encoding="utf-8"))
        if is_sealed(doc):
            unseal(doc, k)   # fails loudly if the file was sealed with another key
            print(f"{name}: already sealed")
        else:
            write(path, doc)
            print(f"{name}: sealed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
